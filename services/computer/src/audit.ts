import { createHash, randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const COMPUTER_AUDIT_EVENT_TYPES = [
  "computer.action_decided",
  "computer.action_completed",
  "computer.action_failed",
  "computer.help_requested",
  "computer.control_taken",
  "computer.control_released",
  "computer.secret_requested",
  "computer.secret_supplied",
] as const;

type ComputerAuditEventType = (typeof COMPUTER_AUDIT_EVENT_TYPES)[number];

type ComputerAuditDecision = {
  allowed: boolean;
  carriedOut: boolean;
  mode: "dry-run" | "enforce";
  reason: string;
  rule: string | null;
  source: "allow" | "deny" | "default";
};

export type ComputerAuditInput = {
  action: string;
  actor: string;
  bot: string;
  decision?: ComputerAuditDecision;
  eventType: ComputerAuditEventType;
  outcome?: Record<string, unknown>;
  sessionId: string;
  target: Record<string, unknown>;
};

export type ComputerAuditEvent = ComputerAuditInput & {
  hash: string;
  id: string;
  previousHash: string | null;
  recordedAt: string;
};

const EVENT_TYPES = new Set<string>(COMPUTER_AUDIT_EVENT_TYPES);
const MAX_AUDIT_STRING_LENGTH = 4_000;

const sensitiveKeys = new Set([
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "authorization",
  "client_secret",
  "clientsecret",
  "content",
  "contents",
  "credential",
  "credentials",
  "id_token",
  "idtoken",
  "password",
  "prompt",
  "refresh_token",
  "refreshtoken",
  "secret",
  "secrets",
  "text",
  "token",
  "tokens",
  "tool_arguments",
  "tool_result",
]);

export class ComputerAuditInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerAuditInputError";
  }
}

function normalizedKey(key: string): string {
  return key.replaceAll(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, label: string, limit = 256): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ComputerAuditInputError(`${label} is required.`);
  }
  const result = value.trim();
  if (result.length > limit) {
    throw new ComputerAuditInputError(`${label} is too long.`);
  }
  return result;
}

function cleanString(value: string): string {
  const bounded = value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, MAX_AUDIT_STRING_LENGTH);

  return bounded.replace(/https?:\/\/[^\s"'<>]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return candidate.split(/[?#]/, 1)[0] ?? "";
    }
  });
}

function redact(value: unknown): unknown {
  if (typeof value === "string") return cleanString(value);
  if (Array.isArray(value)) return value.map(redact);
  if (!plainRecord(value)) return value;

  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      sensitiveKeys.has(key.toLowerCase()) || sensitiveKeys.has(normalizedKey(key))
        ? "[REDACTED]"
        : redact(nested),
    ]),
  );
}

function parseDecision(value: unknown): ComputerAuditDecision | undefined {
  if (value === undefined) return undefined;
  if (!plainRecord(value)) {
    throw new ComputerAuditInputError("decision must be an object.");
  }
  if (
    typeof value.allowed !== "boolean" ||
    typeof value.carriedOut !== "boolean" ||
    (value.mode !== "dry-run" && value.mode !== "enforce") ||
    typeof value.reason !== "string" ||
    (value.rule !== null && typeof value.rule !== "string") ||
    (value.source !== "allow" &&
      value.source !== "deny" &&
      value.source !== "default")
  ) {
    throw new ComputerAuditInputError("decision has an invalid shape.");
  }
  return {
    allowed: value.allowed,
    carriedOut: value.carriedOut,
    mode: value.mode,
    reason: value.reason,
    rule: value.rule,
    source: value.source,
  };
}

export function parseComputerAuditInput(value: unknown): ComputerAuditInput {
  if (!plainRecord(value)) {
    throw new ComputerAuditInputError("An audit event must be a JSON object.");
  }
  const eventType = boundedString(value.eventType, "eventType", 64);
  if (!EVENT_TYPES.has(eventType)) {
    throw new ComputerAuditInputError("eventType is not supported.");
  }
  if (!plainRecord(value.target)) {
    throw new ComputerAuditInputError("target must be an object.");
  }
  if (value.outcome !== undefined && !plainRecord(value.outcome)) {
    throw new ComputerAuditInputError("outcome must be an object.");
  }

  const decision = parseDecision(value.decision);
  return {
    action: boundedString(value.action, "action", 128),
    actor: boundedString(value.actor, "actor", 128),
    bot: boundedString(value.bot, "bot", 128),
    ...(decision ? { decision } : {}),
    eventType: eventType as ComputerAuditEventType,
    ...(value.outcome ? { outcome: value.outcome } : {}),
    sessionId: boundedString(value.sessionId, "sessionId", 256),
    target: value.target,
  };
}

async function readLastHash(path: string): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  try {
    const { size } = await handle.stat();
    if (size === 0) return null;
    // Audit inputs are capped at the HTTP boundary. Reading only the tail keeps
    // restart time flat even after the append-only log has grown for years.
    const bytes = Math.min(size, 128 * 1024);
    const buffer = Buffer.alloc(bytes);
    await handle.read(buffer, 0, bytes, size - bytes);
    const latest = buffer
      .toString("utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (!latest) return null;
    const parsed = JSON.parse(latest) as { hash?: unknown };
    return typeof parsed.hash === "string" ? parsed.hash : null;
  } finally {
    await handle.close();
  }
}

/**
 * One append-only, fsynced hash chain stored outside the model-visible workspace.
 *
 * The Railway deployment has one replica because it owns one volume. Serializing
 * appends here also makes concurrent Vercel requests share one canonical order.
 */
export function createComputerAuditLog(directory: string) {
  const path = resolve(directory, "events.ndjson");
  let appendQueue: Promise<void> = Promise.resolve();
  let cachedLastHash: string | null | undefined;

  async function ready(): Promise<void> {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const handle = await open(path, "a", 0o600);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  function append(input: ComputerAuditInput): Promise<ComputerAuditEvent> {
    const run = appendQueue.then(async () => {
      await ready();
      if (cachedLastHash === undefined) cachedLastHash = await readLastHash(path);
      const unsigned = redact({
        ...input,
        id: randomUUID(),
        previousHash: cachedLastHash,
        recordedAt: new Date().toISOString(),
      }) as Omit<ComputerAuditEvent, "hash">;
      const hash = createHash("sha256")
        .update(JSON.stringify(unsigned))
        .digest("hex");
      const event: ComputerAuditEvent = { ...unsigned, hash };
      const handle = await open(path, "a", 0o600);
      try {
        await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      cachedLastHash = hash;
      return event;
    });

    appendQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return { append, path, ready };
}

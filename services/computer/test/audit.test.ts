import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import {
  ComputerAuditInputError,
  createComputerAuditLog,
  parseComputerAuditInput,
  type ComputerAuditEvent,
  type ComputerAuditInput,
} from "../src/audit";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

async function temporaryDirectory(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "khloei-audit-"));
  temporaryDirectories.push(path);
  return path;
}

function input(
  eventType: ComputerAuditInput["eventType"],
  action: string,
): ComputerAuditInput {
  return {
    action,
    actor: "local-user",
    bot: "khloei",
    eventType,
    sessionId: "session-1",
    target: { page: "https://example.com/path?session=secret" },
  };
}

function expectedHash(event: ComputerAuditEvent): string {
  const { hash: _hash, ...unsigned } = event;
  return createHash("sha256").update(JSON.stringify(unsigned)).digest("hex");
}

describe("computer audit log", () => {
  it("serializes, redacts, fsyncs, and hash-chains concurrent events", async () => {
    const directory = await temporaryDirectory();
    const log = createComputerAuditLog(directory);
    const [decided, completed] = await Promise.all([
      log.append({
        ...input("computer.action_decided", "computer_navigate"),
        outcome: { text: "must not be stored" },
      }),
      log.append(input("computer.action_completed", "computer_navigate")),
    ]);

    expect(decided.previousHash).toBeNull();
    expect(completed.previousHash).toBe(decided.hash);
    expect(decided.hash).toBe(expectedHash(decided));
    expect(completed.hash).toBe(expectedHash(completed));
    expect(decided.outcome).toEqual({ text: "[REDACTED]" });
    expect(decided.target.page).toBe("https://example.com/path");

    const stored = (await readFile(log.path, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(stored).toEqual([decided, completed]);
  });

  it("rejects malformed audit input", () => {
    expect(() => parseComputerAuditInput({ action: "computer_click" })).toThrow(
      ComputerAuditInputError,
    );
  });
});

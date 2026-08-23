import { randomBytes } from "node:crypto";

export const DEFAULT_VIEWER_SESSION_TTL_MS = 60_000;

type ViewerSession = {
  botId: string;
  expiresAt: number;
  origin: string;
};

type ViewerSessionOptions = {
  now?: () => number;
  randomToken?: () => string;
  ttlMs?: number;
};

/**
 * One-use, short-lived credentials for the browser-facing live screen.
 *
 * The computer's root token can drive files, the shell, and every browser profile, so it must never
 * reach React. A viewer credential is deliberately much smaller: it opens one WebSocket for one Bot,
 * from the exact app origin that requested it, and disappears as soon as that upgrade succeeds.
 */
export function createViewerSessions(options: ViewerSessionOptions = {}) {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? DEFAULT_VIEWER_SESSION_TTL_MS;
  const randomToken =
    options.randomToken ?? (() => randomBytes(32).toString("base64url"));
  const sessions = new Map<string, ViewerSession>();

  const prune = () => {
    const timestamp = now();
    for (const [token, session] of sessions) {
      if (session.expiresAt <= timestamp) sessions.delete(token);
    }
  };

  return {
    mint(input: { botId: string; origin: string }): {
      token: string;
      expiresAt: string;
    } {
      prune();
      const token = randomToken();
      const expiresAt = now() + ttlMs;
      sessions.set(token, { ...input, expiresAt });
      return { token, expiresAt: new Date(expiresAt).toISOString() };
    },

    /** Consume rather than merely inspect, so a copied URL cannot open a second screen. */
    consume(input: {
      token: string;
      botId: string;
      origin: string;
    }): boolean {
      prune();
      const session = sessions.get(input.token);
      if (!session) return false;
      sessions.delete(input.token);
      return (
        session.botId === input.botId &&
        session.origin === input.origin &&
        session.expiresAt > now()
      );
    },
  };
}

export function normaliseViewerOrigin(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

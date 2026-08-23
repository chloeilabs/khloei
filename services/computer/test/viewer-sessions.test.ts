import { describe, expect, test } from "bun:test";

import {
  createViewerSessions,
  normaliseViewerOrigin,
} from "../src/viewer-sessions";

describe("viewer sessions", () => {
  test("binds a one-use token to its bot and origin", () => {
    const sessions = createViewerSessions({
      now: () => 1_000,
      randomToken: () => "viewer-token",
      ttlMs: 60_000,
    });
    sessions.mint({ botId: "khloei", origin: "https://app.example" });
    expect(
      sessions.consume({
        botId: "other",
        origin: "https://app.example",
        token: "viewer-token",
      }),
    ).toBe(false);
    expect(
      sessions.consume({
        botId: "khloei",
        origin: "https://app.example",
        token: "viewer-token",
      }),
    ).toBe(false);

    sessions.mint({ botId: "khloei", origin: "https://app.example" });
    expect(
      sessions.consume({
        botId: "khloei",
        origin: "https://app.example",
        token: "viewer-token",
      }),
    ).toBe(true);
    expect(
      sessions.consume({
        botId: "khloei",
        origin: "https://app.example",
        token: "viewer-token",
      }),
    ).toBe(false);
  });

  test("normalizes only web origins", () => {
    expect(normaliseViewerOrigin("https://example.com/path?q=1")).toBe(
      "https://example.com",
    );
    expect(normaliseViewerOrigin("javascript:alert(1)")).toBeNull();
  });
});

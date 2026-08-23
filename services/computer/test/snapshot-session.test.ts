import { describe, expect, test } from "bun:test";

import {
  assertComputerSession,
  createComputerSessionId,
  StaleSnapshotError,
} from "../src/snapshot-session";

describe("computer snapshot sessions", () => {
  test("creates opaque process-scoped session ids", () => {
    const first = createComputerSessionId();
    const second = createComputerSessionId();
    expect(first).toMatch(/^computer_[a-f0-9]{32}$/);
    expect(second).not.toBe(first);
  });

  test("accepts the current session and rejects an earlier one", () => {
    expect(() => assertComputerSession("current", undefined)).not.toThrow();
    expect(() => assertComputerSession("current", "current")).not.toThrow();
    expect(() => assertComputerSession("current", "previous")).toThrow(
      StaleSnapshotError,
    );
  });
});

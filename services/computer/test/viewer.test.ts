import { describe, expect, test } from "bun:test";

import { isCurrentViewer } from "../src/viewer";

describe("live viewer ownership", () => {
  const socket = { id: "current" };
  const replacement = { id: "replacement" };

  test("the current socket owns the cast", () => {
    expect(isCurrentViewer(socket, socket)).toBe(true);
  });

  test("a replaced socket cannot stop the replacement", () => {
    expect(isCurrentViewer(replacement, socket)).toBe(false);
  });

  test("a missing viewer owns nothing", () => {
    expect(isCurrentViewer(undefined, socket)).toBe(false);
  });

  test("socket ownership uses identity rather than shape", () => {
    expect(isCurrentViewer({ id: "current" }, { id: "current" })).toBe(false);
  });
});

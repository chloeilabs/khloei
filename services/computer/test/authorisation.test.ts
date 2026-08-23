import { describe, expect, test } from "bun:test";

import {
  isOpenPath,
  matchesToken,
  offeredToken,
} from "../src/authorisation";

describe("computer authorization", () => {
  test("matches only the complete non-empty token", () => {
    expect(matchesToken("secret-token", "secret-token")).toBe(true);
    expect(matchesToken("secret-token", "secret-toke")).toBe(false);
    expect(matchesToken("secret-token", "secret-token-2")).toBe(false);
    expect(matchesToken("", "")).toBe(false);
  });

  test("accepts bearer and service headers without opening other paths", () => {
    const url = new URL("https://computer.example/control");
    expect(
      offeredToken(new Headers({ authorization: "Bearer bearer-value" }), url),
    ).toBe("bearer-value");
    expect(
      offeredToken(
        new Headers({ "x-khloei-computer-token": "service-value" }),
        url,
      ),
    ).toBe("service-value");
    expect(isOpenPath("/health")).toBe(true);
    expect(isOpenPath("/control")).toBe(false);
  });
});

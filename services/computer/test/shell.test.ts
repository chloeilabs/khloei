import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createShell, environmentForCommand } from "../src/shell";

const source = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  LANG: "C.UTF-8",
  HTTP_PROXY: "http://user:password@proxy.example:8080",
  OPENROUTER_API_KEY: "secret-model-key",
  COMPUTER_TOKEN: "secret-computer-token",
  ...extra,
});

describe("command environment", () => {
  test("keeps deployment secrets out and makes the workspace home", () => {
    const environment = environmentForCommand(source(), "/workspace");
    expect(environment.HOME).toBe("/workspace");
    expect(environment.PWD).toBe("/workspace");
    expect(environment).not.toHaveProperty("OPENROUTER_API_KEY");
    expect(environment).not.toHaveProperty("COMPUTER_TOKEN");
    expect(environment.HTTP_PROXY).toBe("http://proxy.example:8080");
  });

  test("drops malformed credentialed proxy values but preserves no-proxy hosts", () => {
    const environment = environmentForCommand(
      source({
        HTTP_PROXY: "user:password@proxy.example:8080",
        NO_PROXY: "127.0.0.1,.example.test",
      }),
      "/workspace",
    );
    expect(environment.HTTP_PROXY).toBeUndefined();
    expect(environment.NO_PROXY).toBe("127.0.0.1,.example.test");
  });

  test("allows explicitly named informational variables but never execution hooks", () => {
    const environment = environmentForCommand(
      source({
        BASH_ENV: "/workspace/hook.sh",
        COMPUTER_SHELL_ENV: "JAVA_HOME,BASH_ENV,LD_PRELOAD",
        JAVA_HOME: "/opt/java",
        LD_PRELOAD: "/workspace/hook.so",
      }),
      "/workspace",
    );
    expect(environment.JAVA_HOME).toBe("/opt/java");
    expect(environment.BASH_ENV).toBeUndefined();
    expect(environment.LD_PRELOAD).toBeUndefined();
  });
});

describe("command limits", () => {
  let workspace: string;

  beforeEach(async () => {
    workspace = await mkdtemp(join(tmpdir(), "khloei-shell-"));
  });

  afterEach(async () => {
    await rm(workspace, { recursive: true, force: true });
  });

  test("runs in the workspace without sourcing a workspace profile", async () => {
    await writeFile(join(workspace, ".bash_profile"), "export MARKER=unsafe\n");
    const result = await createShell(workspace, source()).run({
      command: 'printf "%s:%s" "$PWD" "${MARKER:-clean}"',
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(`${workspace}:clean`);
  });

  test("stops the complete process group on timeout", async () => {
    const startedAt = Date.now();
    const result = await createShell(workspace, source()).run({
      command: "sleep 30 | cat",
      timeoutMs: 1_000,
    });
    expect(result.timedOut).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(10_000);
  }, 15_000);

  test("bounds noisy output while preserving its tail", async () => {
    const result = await createShell(workspace, source()).run({
      command: "head -c 300000 /dev/zero | tr '\\0' x; printf tail",
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.endsWith("tail")).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(64 * 1024);
  });

  test("cancellation stops a running command", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const result = await createShell(workspace, source()).run({
      command: "sleep 30",
      signal: controller.signal,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.elapsedMs).toBeLessThan(10_000);
  }, 15_000);

  test("an already-cancelled command exits immediately", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await createShell(workspace, source()).run({
      command: "sleep 30",
      signal: controller.signal,
    });
    expect(result.exitCode).not.toBe(0);
    expect(result.elapsedMs).toBeLessThan(2_000);
  }, 5_000);
});

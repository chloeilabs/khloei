import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 120_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 64 * 1024;

export type ShellResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  elapsedMs: number;
};

const PASSTHROUGH_NAMES = [
  "PATH",
  "LANG",
  "LANGUAGE",
  "TERM",
  "TERMINFO",
  "COLORTERM",
] as const;
const PROXY_NAMES = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "FTP_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "ftp_proxy",
] as const;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LOCALE_CATEGORY = /^LC_[A-Za-z0-9_]+$/;

// These variables execute code or change how the shell and dynamic linker interpret a command.
// They are never inherited, even when an operator includes them in COMPUTER_SHELL_ENV.
const NEVER_PASSED = new Set([
  "BASH_ENV",
  "ENV",
  "BASH_XTRACEFD",
  "BASHOPTS",
  "SHELLOPTS",
  "CDPATH",
  "GLOBIGNORE",
  "IFS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "LD_AUDIT",
  "PS4",
]);

function extraShellEnvNames(raw: string | undefined): readonly string[] {
  if (!raw?.trim()) return [];
  const names = raw.split(",").map((name) => name.trim());
  for (const name of names) {
    if (!name || (ENV_NAME.test(name) && !NEVER_PASSED.has(name))) continue;
    console.warn(
      JSON.stringify({
        type: "computer-shell-env-refused",
        name,
        reason: NEVER_PASSED.has(name)
          ? "the variable changes command execution"
          : "the value is not an environment variable name",
      }),
    );
  }
  return names.filter(
    (name) => ENV_NAME.test(name) && !NEVER_PASSED.has(name),
  );
}

function withoutUserinfo(raw: string): string | undefined {
  try {
    const url = new URL(raw.trim());
    if (
      !["http:", "https:", "socks:", "socks4:", "socks5:", "ftp:"].includes(
        url.protocol,
      )
    ) {
      return undefined;
    }
    if (!url.username && !url.password) return raw;
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    // A malformed proxy value can still contain embedded credentials. Do not copy something we
    // cannot safely parse into the model-visible command environment.
    return undefined;
  }
}

/** Build the deliberately small environment visible to a command. */
export function environmentForCommand(
  source: NodeJS.ProcessEnv,
  workspaceDir: string,
): Record<string, string> {
  const environment: Record<string, string> = {};
  const copy = (name: string) => {
    const value = source[name];
    if (value !== undefined) environment[name] = value;
  };

  for (const name of PASSTHROUGH_NAMES) copy(name);
  for (const name of Object.keys(source)) {
    if (LOCALE_CATEGORY.test(name)) copy(name);
  }
  for (const name of PROXY_NAMES) {
    const value = source[name];
    if (value === undefined) continue;
    if (name.toLowerCase() === "no_proxy") {
      environment[name] = value;
      continue;
    }
    const safeValue = withoutUserinfo(value);
    if (safeValue !== undefined) environment[name] = safeValue;
  }
  // Explicitly named variables are an operator decision. Copy them last so an explicitly named
  // credentialed proxy is not silently rewritten.
  for (const name of extraShellEnvNames(source.COMPUTER_SHELL_ENV)) copy(name);

  environment.HOME = workspaceDir;
  environment.PWD = workspaceDir;
  environment.DEBIAN_FRONTEND ??= "noninteractive";
  return environment;
}

function clamp(text: string): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES) {
    return { text, truncated: false };
  }
  return {
    text: Buffer.from(text, "utf8")
      .subarray(-MAX_OUTPUT_BYTES)
      .toString("utf8"),
    truncated: true,
  };
}

function collector() {
  let text = "";
  let dropped = false;
  return {
    add(chunk: unknown) {
      text += String(chunk);
      if (Buffer.byteLength(text, "utf8") <= MAX_OUTPUT_BYTES * 2) return;
      text = Buffer.from(text, "utf8")
        .subarray(-MAX_OUTPUT_BYTES)
        .toString("utf8");
      dropped = true;
    },
    result() {
      const final = clamp(text);
      return { ...final, truncated: final.truncated || dropped };
    },
  };
}

/**
 * Create the command runner rooted in Khloei's persistent workspace.
 *
 * Policy and audit decisions happen in the gateway before this runner is called. This boundary
 * limits time and output, prevents deployment secrets from being inherited, and kills the complete
 * process group on timeout or cancellation. The desktop container supplies the filesystem and user
 * isolation; the HTTP route additionally refuses to run while that process is root.
 */
export function createShell(
  workspaceDir: string,
  sourceEnvironment: NodeJS.ProcessEnv = process.env,
) {
  return {
    async run(input: {
      command: string;
      timeoutMs?: number;
      signal?: AbortSignal;
    }): Promise<ShellResult> {
      const startedAt = Date.now();
      const timeoutMs = Math.min(
        Math.max(input.timeoutMs ?? DEFAULT_TIMEOUT_MS, MIN_TIMEOUT_MS),
        MAX_TIMEOUT_MS,
      );
      const child = spawn("/bin/bash", ["-c", input.command], {
        cwd: workspaceDir,
        detached: true,
        env: environmentForCommand(sourceEnvironment, workspaceDir),
      });
      const stdout = collector();
      const stderr = collector();
      child.stdout.on("data", (chunk) => stdout.add(chunk));
      child.stderr.on("data", (chunk) => stderr.add(chunk));

      const stop = () => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The process group has already exited.
        }
      };

      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        stop();
      }, timeoutMs);
      if (input.signal?.aborted) stop();
      else input.signal?.addEventListener("abort", stop, { once: true });

      const exitCode = await new Promise<number>((resolve) => {
        let settled = false;
        const finish = (value: number) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        child.once("close", (code) => finish(code ?? -1));
        child.once("error", () => finish(-1));
      });

      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", stop);
      const out = stdout.result();
      const err = stderr.result();
      return {
        command: input.command,
        exitCode,
        stdout: out.text,
        stderr: err.text,
        truncated: out.truncated || err.truncated,
        timedOut,
        elapsedMs: Date.now() - startedAt,
      };
    },
  };
}

export type Shell = ReturnType<typeof createShell>;

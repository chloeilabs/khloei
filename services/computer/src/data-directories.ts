import { mkdir } from "node:fs/promises";

export type ComputerDataDirectories = {
  audit: string;
  profiles: string;
  workspace: string;
};

export function computerDataDirectories(
  environment: Record<string, string | undefined> = process.env,
): ComputerDataDirectories {
  return {
    audit: environment.AUDIT_DIR ?? "/audit",
    profiles: environment.PROFILES_DIR ?? "/profiles",
    workspace: environment.WORKSPACE_DIR ?? "/workspace",
  };
}

/**
 * Initialize every writable root after the runtime volume has been mounted.
 *
 * Image-layer directories disappear beneath a mount. Railway intentionally mounts
 * one empty volume at `/data`, so `/data/workspace`, `/data/profiles`, and
 * `/data/audit` must be created by the running process before any subsystem uses
 * `realpath` or starts Chromium.
 */
export async function prepareComputerDataDirectories(
  directories = computerDataDirectories(),
): Promise<ComputerDataDirectories> {
  await Promise.all(
    Object.values(directories).map((directory) =>
      mkdir(directory, { recursive: true, mode: 0o700 }),
    ),
  );
  return directories;
}

import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorkspace, WorkspacePathError } from "../src/workspace";

const temporaryDirectories: string[] = [];

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "khloei-workspace-"));
  temporaryDirectories.push(directory);
  const root = join(directory, "workspace");
  const outside = join(directory, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, "secret.txt"), "outside");
  return { outside, root, workspace: createWorkspace(root) };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("workspace confinement", () => {
  test("refuses traversal and absolute paths", async () => {
    const { workspace } = fixture();
    await expect(workspace.read("../outside/secret.txt")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
    await expect(workspace.read("/etc/passwd")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
  });

  test("refuses reads and writes through a symlinked directory", async () => {
    const { outside, root, workspace } = fixture();
    symlinkSync(outside, join(root, "escape"));
    await expect(workspace.read("escape/secret.txt")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
    await expect(workspace.write("escape/new.txt", "blocked")).rejects.toBeInstanceOf(
      WorkspacePathError,
    );
  });
});

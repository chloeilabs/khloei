import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "bun:test";
import { prepareComputerDataDirectories } from "../src/data-directories";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

describe("computer data directories", () => {
  it("creates every root beneath a newly mounted volume", async () => {
    const volume = await mkdtemp(join(tmpdir(), "khloei-volume-"));
    temporaryDirectories.push(volume);
    const directories = {
      audit: join(volume, "audit"),
      profiles: join(volume, "profiles"),
      workspace: join(volume, "workspace"),
    };

    await prepareComputerDataDirectories(directories);

    for (const directory of Object.values(directories)) {
      expect((await stat(directory)).isDirectory()).toBe(true);
    }
  });
});

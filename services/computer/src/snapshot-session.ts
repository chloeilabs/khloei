import { randomUUID } from "node:crypto";

export class StaleSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleSnapshotError";
  }
}

export function createComputerSessionId(): string {
  return `computer_${randomUUID().replaceAll("-", "")}`;
}

export function assertComputerSession(
  currentSessionId: string,
  expectedSessionId: string | undefined,
): void {
  if (expectedSessionId === undefined || expectedSessionId === currentSessionId) {
    return;
  }
  throw new StaleSnapshotError(
    "That list of elements belongs to an earlier computer session. Take a fresh snapshot before acting.",
  );
}

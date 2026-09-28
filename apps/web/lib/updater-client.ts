export type UpdaterPhase =
  | "idle" | "waiting" | "backing_up" | "building" | "switching" | "verifying" | "done" | "rolled_back" | "failed";

export interface UpdaterStatus {
  phase: UpdaterPhase;
  targetTag: string | null;
  fromCommit: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** One human sentence for the UI. */
  message: string;
  /** Last ~40 lines of the update log, shown behind 「查看详情」. */
  logTail: string;
}

/** Replaced in Task 9. */
export async function getUpdaterStatus(): Promise<UpdaterStatus | null> {
  return null;
}

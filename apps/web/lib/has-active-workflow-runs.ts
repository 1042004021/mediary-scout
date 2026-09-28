import { DEFAULT_ACCOUNT_ID, type WorkflowRepository } from "@media-track/workflow";

type BusyRepository = Pick<WorkflowRepository, "listAccounts" | "listActiveWorkflowRuns">;

/** After the hold is taken, a worker tick that checked the hold a moment earlier may
 *  still be about to mark a claimed run `running`. Stay busy this long to cover it. */
export const HOLD_GRACE_MS = 15_000;

/** True when any account has a queued or running run of any kind, including hidden
 *  `staging_recovery`. `listActiveWorkflowRuns()` with no scope only sees the default
 *  account. `acct_default` is seeded in both SQL schemas; union it in so an in-memory
 *  repository, which does not seed accounts, still sees that account's runs.
 *
 *  While the update hold is on (`holdStartedAt` set), nothing new starts, so queued
 *  runs wait for the new version and only `running` ones count — plus a short grace
 *  right after the hold was taken. */
export async function hasActiveWorkflowRuns(
  repository: BusyRepository,
  hold: { holdStartedAt: number | null; now: number } = { holdStartedAt: null, now: 0 },
): Promise<boolean> {
  if (hold.holdStartedAt !== null && hold.now - hold.holdStartedAt < HOLD_GRACE_MS) return true;
  const accounts = await repository.listAccounts();
  const ids = new Set(accounts.map((account) => account.id));
  ids.add(DEFAULT_ACCOUNT_ID);
  for (const accountId of ids) {
    const active = await repository.listActiveWorkflowRuns(accountId);
    const counted =
      hold.holdStartedAt === null ? active : active.filter((run) => run.workflowRun.status === "running");
    if (counted.length > 0) return true;
  }
  return false;
}

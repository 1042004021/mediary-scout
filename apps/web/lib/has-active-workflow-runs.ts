import { DEFAULT_ACCOUNT_ID, type WorkflowRepository } from "@media-track/workflow";

type BusyRepository = Pick<WorkflowRepository, "listAccounts" | "listActiveWorkflowRuns">;

/** True when any account has a queued or running run of any kind, including hidden
 *  `staging_recovery`. `listActiveWorkflowRuns()` with no scope only sees the default
 *  account. `acct_default` is seeded in both SQL schemas; union it in so an in-memory
 *  repository, which does not seed accounts, still sees that account's runs. */
export async function hasActiveWorkflowRuns(repository: BusyRepository): Promise<boolean> {
  const accounts = await repository.listAccounts();
  const ids = new Set(accounts.map((account) => account.id));
  ids.add(DEFAULT_ACCOUNT_ID);
  for (const accountId of ids) {
    const active = await repository.listActiveWorkflowRuns(accountId);
    if (active.length > 0) return true;
  }
  return false;
}

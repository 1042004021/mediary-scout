import { DEFAULT_ACCOUNT_ID, InMemoryWorkflowRepository, type WorkflowKind, type WorkflowStatus } from "@media-track/workflow";
import { describe, expect, it } from "vitest";
import { hasActiveWorkflowRuns } from "./has-active-workflow-runs";

async function saveRun(
  repo: InMemoryWorkflowRepository,
  input: { id: string; accountId: string; status: WorkflowStatus; kind: WorkflowKind },
): Promise<void> {
  await repo.saveWorkflowRunSnapshot({
    accountId: input.accountId,
    connectedStorageId: "drive-1",
    title: {
      id: `title-${input.id}`,
      tmdbId: 7,
      type: "tv",
      title: "Show",
      originalTitle: "Show",
      year: 2024,
      aliases: [],
    },
    season: {
      id: `season-${input.id}`,
      mediaTitleId: `title-${input.id}`,
      seasonNumber: 1,
      status: "active",
      qualityPreference: "1080p",
      storageDirectoryId: `dir-${input.id}`,
      totalEpisodes: 1,
      latestAiredEpisode: 1,
      latestAiredSource: "metadata",
    },
    workflowRun: {
      id: input.id,
      kind: input.kind,
      status: input.status,
      trackedSeasonId: `season-${input.id}`,
      startedAt: "2026-10-02T00:00:00.000Z",
      finishedAt: input.status === "queued" || input.status === "running" ? null : "2026-10-02T01:00:00.000Z",
      auditEvents: [],
    },
    episodes: [],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
}

describe("hasActiveWorkflowRuns", () => {
  it("is busy when the only active run belongs to a second account, including a hidden recovery", async () => {
    const repo = new InMemoryWorkflowRepository();
    await repo.createAccount({
      id: "acct_other",
      username: "other",
      passwordHash: "",
      groupId: null,
      isOwner: false,
      createdAt: "2026-10-02T00:00:00.000Z",
    });
    await saveRun(repo, { id: "run-other", accountId: "acct_other", status: "running", kind: "staging_recovery" });
    // No argument only looks at the default account, so this is the bug the helper exists for.
    expect(await repo.listActiveWorkflowRuns()).toEqual([]);
    expect(await hasActiveWorkflowRuns(repo)).toBe(true);
  });

  it("is not busy when nothing is queued or running", async () => {
    const repo = new InMemoryWorkflowRepository();
    expect(await hasActiveWorkflowRuns(repo)).toBe(false);
  });

  it("is not busy when the only run has finished", async () => {
    const repo = new InMemoryWorkflowRepository();
    await saveRun(repo, { id: "run-done", accountId: DEFAULT_ACCOUNT_ID, status: "succeeded", kind: "type3_monitor" });
    expect(await hasActiveWorkflowRuns(repo)).toBe(false);
  });

  it("sees a queued run on the default account even when that account is not in listAccounts", async () => {
    const repo = new InMemoryWorkflowRepository();
    await saveRun(repo, { id: "run-default", accountId: DEFAULT_ACCOUNT_ID, status: "queued", kind: "type2_init" });
    expect(await repo.listAccounts()).toEqual([]);
    expect(await hasActiveWorkflowRuns(repo)).toBe(true);
  });
});

import { DEFAULT_ACCOUNT_ID, InMemoryWorkflowRepository, type WorkflowKind, type WorkflowStatus } from "@media-track/workflow";
import { describe, expect, it } from "vitest";
import { HOLD_GRACE_MS, hasActiveWorkflowRuns } from "./has-active-workflow-runs";

async function saveRun(
  repo: InMemoryWorkflowRepository,
  input: { id: string; accountId: string; status: WorkflowStatus; kind: WorkflowKind; nextAttemptAt?: string },
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
      ...(input.nextAttemptAt ? { nextAttemptAt: input.nextAttemptAt } : {}),
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

  it("ignores a queued run still in backoff before the hold: the worker defers it too", async () => {
    const now = Date.parse("2026-10-02T12:00:00.000Z");
    const repo = new InMemoryWorkflowRepository();
    // A transient failure re-queued this run with a future nextAttemptAt; the worker will
    // not claim it yet, so an update must not sit waiting for it on an idle instance.
    await saveRun(repo, {
      id: "run-backoff",
      accountId: DEFAULT_ACCOUNT_ID,
      status: "queued",
      kind: "type2_init",
      nextAttemptAt: "2026-10-02T12:05:00.000Z",
    });
    expect(await hasActiveWorkflowRuns(repo, { holdStartedAt: null, now })).toBe(false);
    // Once its backoff has elapsed it is claimable again → busy.
    const later = Date.parse("2026-10-02T12:06:00.000Z");
    expect(await hasActiveWorkflowRuns(repo, { holdStartedAt: null, now: later })).toBe(true);
  });

  describe("while the update hold is on", () => {
    const heldLongAgo = { holdStartedAt: 1_000, now: 1_000 + HOLD_GRACE_MS };

    it("does not wait for queued runs: nothing new starts, they run on the new version", async () => {
      const repo = new InMemoryWorkflowRepository();
      await saveRun(repo, { id: "run-queued", accountId: DEFAULT_ACCOUNT_ID, status: "queued", kind: "type2_init" });
      expect(await hasActiveWorkflowRuns(repo, heldLongAgo)).toBe(false);
    });

    it("still waits for a running run on any account", async () => {
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
      expect(await hasActiveWorkflowRuns(repo, heldLongAgo)).toBe(true);
    });

    it("stays busy for the grace period right after the hold was taken", async () => {
      const repo = new InMemoryWorkflowRepository();
      expect(await hasActiveWorkflowRuns(repo, { holdStartedAt: 1_000, now: 1_000 + HOLD_GRACE_MS - 1 })).toBe(true);
      expect(await hasActiveWorkflowRuns(repo, heldLongAgo)).toBe(false);
    });
  });
});

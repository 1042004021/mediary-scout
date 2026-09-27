import { describe, expect, it, vi } from "vitest";
import type { MediaTitle, TrackedSeason, WorkflowRun } from "../src/domain.js";
import type { PersistedWorkflowRunSnapshot, PersistWorkflowRunSnapshotInput } from "../src/repository.js";
import { attachStagingCleanupUnverified, stagingCleanupUnverifiedAuditEvent } from "../src/acquisition-v2/directory-lifecycle.js";
import { handleWorkflowRunFailure } from "../src/worker.js";

const title: MediaTitle = {
  id: "tmdb_tv_1",
  tmdbId: 1,
  type: "tv",
  title: "测试剧",
  originalTitle: "Test",
  year: 2020,
  aliases: [],
};

const season: TrackedSeason = {
  id: "tmdb_tv_1_s1",
  mediaTitleId: "tmdb_tv_1",
  seasonNumber: 1,
  status: "active",
  qualityPreference: "1080p",
  storageDirectoryId: "show",
  totalEpisodes: 1,
  latestAiredEpisode: 1,
  latestAiredSource: "metadata",
};

function snapshot(): PersistedWorkflowRunSnapshot {
  const workflowRun: WorkflowRun = {
    id: "r1",
    kind: "type3_monitor",
    status: "running",
    trackedSeasonId: season.id,
    startedAt: "2026-09-27T03:00:00.000Z",
    finishedAt: null,
    auditEvents: [],
  };
  return {
    accountId: "acct_default",
    connectedStorageId: "cs_1",
    title,
    season,
    workflowRun,
    episodes: [],
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
    obtainedEpisodes: [],
    providerAheadEpisodes: [],
  };
}

describe("staging_cleanup_unverified persist", () => {
  it("handleWorkflowRunFailure writes the event onto the failed run", async () => {
    const error = attachStagingCleanupUnverified(new Error("agent gave up"), [
      {
        stagingDirectoryId: "stg",
        showDirectoryId: "show",
        error: new Error("budget exhausted before deleteItems"),
      },
    ]);
    const save = vi.fn(async (_input: PersistWorkflowRunSnapshotInput) => {});
    await handleWorkflowRunFailure({
      claimed: snapshot(),
      error,
      repository: { saveWorkflowRunSnapshot: save },
      now: () => "2026-09-27T03:30:00.000Z",
    });
    const saved = save.mock.calls[0]![0];
    const event = saved.workflowRun.auditEvents.find(
      (item: { type: string }) => item.type === "staging_cleanup_unverified",
    );
    expect(event).toEqual(
      stagingCleanupUnverifiedAuditEvent({
        stagingDirectoryId: "stg",
        showDirectoryId: "show",
        error: new Error("budget exhausted before deleteItems"),
      }),
    );
  });
});

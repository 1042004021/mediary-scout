import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEpisodeStates,
  InMemoryWorkflowRepository,
  queueReplaceRequest,
  type MediaTitle,
  type TrackedSeason,
  type WorkflowKind,
  type WorkflowStatus,
} from "@media-track/workflow";

// tmdb-cache (imported by title-hub) marks itself server-only; plain Node has no such package.
// @ts-expect-error Vitest's runtime supports virtual mocks, but its v4 typings omit the option.
vi.mock("server-only", () => ({}), { virtual: true });

const NOW = "2026-09-27T08:00:00.000Z";
const scope = { accountId: "acct_1", connectedStorageId: "cs_primary" };

const title = (tmdbId: number, name: string): MediaTitle => ({
  id: `tmdb_tv_${tmdbId}`,
  tmdbId,
  type: "tv",
  title: name,
  originalTitle: name,
  year: 2026,
  aliases: [],
  // A stored poster: no TMDB lookup in the test.
  posterPath: `/p${tmdbId}.jpg`,
});

function season(t: MediaTitle, seasonNumber: number): TrackedSeason {
  return {
    id: `${t.id}_s${seasonNumber}`,
    mediaTitleId: t.id,
    seasonNumber,
    status: "completed",
    qualityPreference: "4K",
    storageDirectoryId: `dir_${t.id}_s${seasonNumber}`,
    totalEpisodes: 2,
    latestAiredEpisode: 2,
    latestAiredSource: "metadata",
  };
}

async function saveRun(repo: InMemoryWorkflowRepository, t: MediaTitle, s: TrackedSeason, run: { id: string; kind: WorkflowKind; status: WorkflowStatus; obtained: boolean }) {
  await repo.saveWorkflowRunSnapshot({
    ...scope,
    title: t,
    season: s,
    workflowRun: {
      id: run.id,
      kind: run.kind,
      status: run.status,
      trackedSeasonId: s.id,
      startedAt: NOW,
      finishedAt: run.status === "succeeded" ? NOW : null,
      auditEvents: [],
    },
    episodes: createEpisodeStates({ trackedSeasonId: s.id, seasonNumber: s.seasonNumber, totalEpisodes: 2, latestAiredEpisode: 2 }).map((e) => ({ ...e, obtained: run.obtained })),
    resourceSnapshots: [],
    decisions: [],
    transferAttempts: [],
    notifications: [],
  });
}

/** The library's 获取中 placeholders: non-clickable cards for titles still being fetched. */
describe("getInProgressTitles", () => {
  let repo: InMemoryWorkflowRepository;
  let hub: typeof import("./title-hub");

  beforeEach(async () => {
    repo = new InMemoryWorkflowRepository();
    vi.resetModules();
    vi.doMock("./workflow-runtime", async () => {
      const actual = await vi.importActual<typeof import("./workflow-runtime")>("./workflow-runtime");
      return { ...actual, getWorkflowRepository: () => repo, getActiveWorkspaceScope: async () => scope };
    });
    hub = await import("./title-hub");
  }, 30_000);

  it("a title whose only active run is a replace request stays a normal, clickable library card", async () => {
    // In the library already; the user's message queued a replace run (they queue last
    // and pile up after each sweep). The card must still open the page, to edit or
    // withdraw the message.
    const owned = title(42, "Owned");
    await saveRun(repo, owned, season(owned, 1), { id: "seed_42", kind: "type2_init", status: "succeeded", obtained: true });
    const work = { accountId: scope.accountId, drive: scope.connectedStorageId, titleKey: owned.id };
    await repo.createUserMessage({ ...work, body: "第 1 集发蓝", episodeTags: ["S01E01"], now: NOW });
    expect((await queueReplaceRequest({ repository: repo, work })).status).toBe("queued");
    expect((await repo.listActiveWorkflowRuns(scope)).map((r) => r.workflowRun.kind)).toEqual(["replace_request"]);

    expect(await hub.getInProgressTitles()).toEqual([]);
  });

  it("a staging recovery is not a 获取中 card and does not mark the show page acquiring", async () => {
    const owned = title(42, "Owned");
    await saveRun(repo, owned, season(owned, 1), { id: "seed_42", kind: "type2_init", status: "succeeded", obtained: true });
    await saveRun(repo, owned, season(owned, 1), { id: "rec_42", kind: "staging_recovery", status: "running", obtained: true });

    expect(await hub.getInProgressTitles()).toEqual([]);
    const view = await hub.getTitleHubView(42);
    expect(view?.acquiring).toBe(false);
  });

  it("a title still being fetched is 获取中 — also when a replace run of it is queued too", async () => {
    const fresh = title(7, "Fresh");
    await saveRun(repo, fresh, season(fresh, 1), { id: "run_7", kind: "type2_init", status: "queued", obtained: false });
    const both = title(9, "Both");
    await saveRun(repo, both, season(both, 1), { id: "seed_9", kind: "type2_init", status: "succeeded", obtained: true });
    await saveRun(repo, both, season(both, 2), { id: "run_9_s2", kind: "type2_init", status: "running", obtained: false });
    await saveRun(repo, both, season(both, 1), { id: "run_9_swap", kind: "replace_request", status: "queued", obtained: true });

    const inProgress = await hub.getInProgressTitles();

    expect(inProgress.map((t) => t.tmdbId).sort()).toEqual([7, 9]);
    expect(inProgress.find((t) => t.tmdbId === 7)).toMatchObject({ title: "Fresh", posterPath: "/p7.jpg" });
  });
});

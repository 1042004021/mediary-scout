import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { buildReflectionDigest } from "../src/acquisition-v2/agent-loop.js";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";
import { runAcquisitionV2 } from "../src/acquisition-v2/orchestrator.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import { InMemoryWorkflowRepository } from "../src/repository.js";
import type { ResourceProvider } from "../src/ports.js";
import type { VerifiedFile } from "../src/domain.js";

const episodes = (n: number) => ({
  files: Array.from({ length: n }, (_, i) => ({ path: `Pack/E${String(i + 1).padStart(2, "0")}.mkv`, sizeBytes: 1 })),
});

async function tvWith(packId: string, fileCount: number) {
  const provider = new FakeResourceProviderV2({ results: { show: [{ id: packId, title: "黄泉的使者 (2026)" }] } });
  const storage = new Storage115Simulator({ packs: { [packId]: episodes(fileCount) } });
  const staging = await storage.createDirectory({ name: "staging", parentId: "root" });
  const season = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId: staging,
    targetSeasonDirectoryIds: { 1: season },
    need: ["S01E01"],
  });
  const snapshotId = (await sandbox.searchResources("show")).snapshot!.id;
  const transfer = await sandbox.transferCandidate({ snapshotId, candidateId: packId });
  return { sandbox, transfer };
}

function digestFor(
  candidateId: string,
  fileIds: string[],
  fate: { kept: number; thrownAway: number },
  title: string,
): string {
  return buildReflectionDigest({
    searches: [],
    attempts: [{ candidateId, status: "succeeded", materializedFileIds: fileIds, ...fate }],
    candidateTitle: () => title,
    coverage: { coverageMet: false, obtained: [], missing: ["S01E01"] },
    auditEvents: [],
  });
}

describe("reflection digest — what became of the transferred files", () => {
  it("an attempt whose 12 files were all discarded prints 0 kept, 12 thrown away", async () => {
    const { sandbox, transfer } = await tvWith("pack", 12);
    await sandbox.discardStaging();

    const fate = sandbox.materializedFate("pack");
    expect(fate).toEqual({ kept: 0, thrownAway: 12 });
    expect(digestFor("pack", transfer.attempt.materializedFileIds, fate, "黄泉的使者 (2026)")).toContain(
      "- 黄泉的使者 (2026) → succeeded (12 files: 0 kept, 12 thrown away)",
    );
  });

  it("a file moved into a season dir counts as kept; one deleted from there counts as thrown away", async () => {
    const { sandbox, transfer } = await tvWith("pack", 12);
    const ids = transfer.staging.filter((f) => f.isVideo).map((f) => f.id);
    const [moved, deleted, ...rest] = ids;
    await sandbox.moveToSeason({ moves: [{ season: 1, fileIds: [moved!, deleted!] }] });
    await sandbox.deleteFiles({ directory: "season", season: 1, fileIds: [deleted!] });
    await sandbox.discardStaging();

    expect(sandbox.materializedFate("pack")).toEqual({ kept: 1, thrownAway: 11 });
    expect(rest).toHaveLength(10);
  });

  it("files still in staging when the run ends count as thrown away", async () => {
    const { sandbox } = await tvWith("pack", 12);
    expect(sandbox.materializedFate("pack")).toEqual({ kept: 0, thrownAway: 12 });
  });

  it("a movie run's files count as kept unless deleted; flattenMovie keeps only what it lifts", async () => {
    const provider = new FakeResourceProviderV2({ results: { film: [{ id: "film", title: "Film" }] } });
    const storage = new Storage115Simulator({
      packs: {
        film: {
          files: [
            { path: "Film.2026/Film.mkv", sizeBytes: 100 },
            { path: "Film.2026/Film.zh.ass", sizeBytes: 2 },
            { path: "Film.2026/cover.jpg", sizeBytes: 1 },
          ],
        },
      },
    });
    const movieDir = await storage.createDirectory({ name: "Film (2026)", parentId: "root" });
    const sandbox = new TaskSandbox({
      provider,
      storage,
      stagingDirectoryId: movieDir,
      targetMovieDirectoryId: movieDir,
      need: ["MOVIE"],
    });
    const snapshotId = (await sandbox.searchResources("film")).snapshot!.id;
    const transfer = await sandbox.transferCandidate({ snapshotId, candidateId: "film" });
    expect(sandbox.materializedFate("film")).toEqual({ kept: 3, thrownAway: 0 });

    await sandbox.flattenMovie();
    const fate = sandbox.materializedFate("film");
    expect(fate).toEqual({ kept: 2, thrownAway: 1 });
    expect(digestFor("film", transfer.attempt.materializedFileIds, fate, "Film")).toContain(
      "- Film → succeeded (3 files: 2 kept, 1 thrown away)",
    );

    const video = (await sandbox.inspectTargetDir()).find((f) => f.isVideo)!;
    await sandbox.deleteFiles({ directory: "staging", fileIds: [video.id] });
    expect(sandbox.materializedFate("film")).toEqual({ kept: 1, thrownAway: 2 });
  });

  it("an attempt without a file fate keeps the plain file count", () => {
    const digest = buildReflectionDigest({
      searches: [],
      attempts: [{ candidateId: "c", status: "succeeded", materializedFileIds: ["f"] }],
      candidateTitle: () => "出入平安 2160p",
      coverage: { coverageMet: true, obtained: ["MOVIE"], missing: [] },
      auditEvents: [],
    });
    expect(digest).toContain("- 出入平安 2160p → succeeded (1 files)");
    expect(digest).not.toContain("kept");
  });
});

const USAGE = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
} as const;
const tool = (name: string, input: unknown, i: number) => ({
  content: [{ type: "tool-call" as const, toolCallId: `c${i}`, toolName: name, input: JSON.stringify(input) }],
  finishReason: { unified: "tool-calls" as const, raw: "tool-calls" as const },
  usage: USAGE,
  warnings: [],
});
const stop = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  finishReason: { unified: "stop" as const, raw: "stop" as const },
  usage: USAGE,
  warnings: [],
});

describe("runAcquisitionV2 — reflection digest carries file fate", () => {
  it("tells the reflection that a TV transfer left in staging was thrown away", async () => {
    const store = new InMemoryWorkflowRepository();
    const provider: ResourceProvider = {
      search: async ({ keyword }) => ({
        id: "snap_hades",
        provider: "pansou",
        keyword,
        createdAt: "2026-09-27T00:00:00.000Z",
        candidates:
          keyword === "黄泉的使者"
            ? [
                {
                  id: "cand_plain",
                  snapshotId: "snap_hades",
                  index: 0,
                  title: "黄泉的使者 (2026)",
                  type: "123",
                  source: "pansou",
                  providerPayload: { url: "https://www.123pan.com/s/Ab-cD_12" },
                },
              ]
            : [],
      }),
    };
    const files: VerifiedFile[] = ["e1", "e2"].map((id) => ({
      id,
      storageDirectoryId: "staging",
      name: `${id}.mkv`,
      sizeBytes: 10,
      episodeCode: "S01E01",
      providerFileId: id,
    }));
    let reflectionPrompt = "";
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const sys = String((options.prompt.find((m) => m.role === "system") as { content?: string } | undefined)?.content ?? "");
        if (sys.includes("reviewing an acquisition run")) {
          reflectionPrompt = JSON.stringify(options.prompt);
          return stop("nothing worth keeping");
        }
        i += 1;
        if (i === 1) return tool("viewResourceSnapshot", {}, i);
        if (i === 2) return tool("transferCandidate", { snapshotId: "s1", candidateId: "s1-1" }, i);
        if (i === 3) return tool("reportNoCoverage", { reason: "old pack" }, i);
        return stop("done");
      },
    });

    await runAcquisitionV2({
      provider,
      executor: new FakeStorageExecutor({
        directories: { staging: [], season: [] },
        transferOutcomes: { cand_plain: { status: "succeeded", providerMessage: "ok", files } },
      }),
      model,
      workflowRunId: "run-fate",
      target: { kind: "tv", title: "黄泉的使者", aliases: [], seasons: [1], missingEpisodes: ["S01E01"], qualityPreference: "1080p", tmdbId: 1 },
      stagingDirectoryId: "staging",
      targetSeasonDirectoryIds: { 1: "season" },
      memory: { store, accountId: "acct_1", now: () => "2026-09-27T00:00:00.000Z" },
    });

    expect(reflectionPrompt).toContain("黄泉的使者 (2026) → succeeded (2 files: 0 kept, 2 thrown away)");
  });
});

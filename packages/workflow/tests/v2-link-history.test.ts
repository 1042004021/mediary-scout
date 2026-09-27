import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionV2 } from "../src/acquisition-v2/orchestrator.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceSnapshot, VerifiedFile } from "../src/domain.js";

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

const stop = (text: string) => ({
  content: [{ type: "text" as const, text }],
  finishReason: { unified: "stop" as const, raw: "stop" as const },
  usage: USAGE,
  warnings: [],
});

const SHARE = "https://www.123pan.com/s/Ab-cD_12";
const OTHER = "https://www.123pan.com/s/OtherKey1";

function provider(): ResourceProvider {
  return {
    search: async ({ keyword }): Promise<ResourceSnapshot> => ({
      id: "snap_hades",
      provider: "pansou",
      keyword,
      createdAt: "2026-09-27T00:00:00.000Z",
      candidates: [
        {
          id: "cand_plain",
          snapshotId: "snap_hades",
          index: 0,
          title: "黄泉的使者 (2026)",
          type: "123",
          source: "pansou",
          providerPayload: { url: SHARE, datetime: "2026-09-01T00:00:00Z" },
        },
        {
          id: "cand_alias",
          snapshotId: "snap_hades",
          index: 1,
          title: "🎬 黄泉的使者 (2026) 已更新",
          type: "123",
          source: "pansou",
          providerPayload: { url: SHARE, datetime: "2026-09-01T00:00:00Z" },
        },
        {
          id: "cand_empty",
          snapshotId: "snap_hades",
          index: 2,
          title: "空的",
          type: "123",
          source: "pansou",
          providerPayload: { url: OTHER },
        },
      ],
    }),
  };
}

const files: VerifiedFile[] = ["e1", "e2"].map((id) => ({
  id,
  storageDirectoryId: "staging",
  name: `${id}.mkv`,
  sizeBytes: 10,
  episodeCode: "S01E01",
  providerFileId: id,
}));

function script(steps: Array<{ name: string; input: unknown }>) {
  let i = 0;
  let seen = "";
  const model = new MockLanguageModelV3({
    doGenerate: async (options) => {
      const blob = JSON.stringify(options.prompt);
      if (blob.includes("近 30 天")) seen = blob;
      const step = steps[i];
      i += 1;
      if (!step) return stop("done");
      return tool(step.name, step.input, i);
    },
  });
  return { model, seen: () => seen };
}

describe("runAcquisitionV2 link history", () => {
  it("reads history once before the pre-warm and annotates both titles of the link", async () => {
    let listCalls = 0;
    let searchesBeforeList = 0;
    let searches = 0;
    const { model, seen } = script([
      { name: "viewResourceSnapshot", input: {} },
      { name: "reportNoCoverage", input: { reason: "already had it" } },
    ]);
    const searching = provider();
    const wrapped: ResourceProvider = {
      search: async (input) => {
        searches += 1;
        return searching.search(input);
      },
    };

    await runAcquisitionV2({
      provider: wrapped,
      executor: new FakeStorageExecutor({ directories: { staging: [], season: [] } }),
      model,
      workflowRunId: "run-history",
      target: { kind: "tv", title: "黄泉的使者", aliases: [], seasons: [1], missingEpisodes: ["S01E01"], qualityPreference: "1080p", tmdbId: 1 },
      stagingDirectoryId: "staging",
      targetSeasonDirectoryIds: { 1: "season" },
      linkHistory: {
        list: async () => {
          listCalls += 1;
          searchesBeforeList = searches;
          return [
            {
              url: SHARE,
              startedAt: "2026-09-26T04:25:00.000Z",
              materializedCount: 12,
              fate: { kept: 0, thrownAway: 12 },
            },
          ];
        },
      },
    });

    expect(listCalls).toBe(1);
    expect(searchesBeforeList).toBe(0);
    expect(seen()).toContain("[s1-1] 黄泉的使者 (2026) · 发布 2026-09-01 · 近 30 天转过 1 次（最近 09-26），文件每次都被丢掉");
    expect(seen()).toContain("[s1-2] 🎬 黄泉的使者 (2026) 已更新 · 发布 2026-09-01 · 近 30 天转过 1 次（最近 09-26），文件每次都被丢掉");
    expect(seen()).not.toContain("空的 · 近 30 天");
  });

  it("a throwing history read does not fail the run", async () => {
    let listCalls = 0;
    const { model } = script([{ name: "reportNoCoverage", input: { reason: "no history" } }]);
    const result = await runAcquisitionV2({
      provider: provider(),
      executor: new FakeStorageExecutor({ directories: { staging: [], season: [] } }),
      model,
      workflowRunId: "run-history-down",
      target: { kind: "tv", title: "黄泉的使者", aliases: [], seasons: [1], missingEpisodes: ["S01E01"], qualityPreference: "1080p", tmdbId: 1 },
      stagingDirectoryId: "staging",
      targetSeasonDirectoryIds: { 1: "season" },
      linkHistory: {
        list: async () => {
          listCalls += 1;
          throw new Error("db down");
        },
      },
    });
    expect(listCalls).toBe(1);
    expect(result.outcome.transferAttempts).toEqual([]);
  });
});

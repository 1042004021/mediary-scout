import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionV2 } from "../src/acquisition-v2/orchestrator.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import type { ResourceProvider } from "../src/ports.js";
import type { VerifiedFile } from "../src/domain.js";

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
const text = (t: string) => ({
  content: [{ type: "text" as const, text: t }],
  finishReason: { unified: "stop" as const, raw: "stop" as const },
  usage: USAGE,
  warnings: [],
});

/** The JSON output of the most recent tool result named `toolName` in a model prompt. */
function lastToolOutput(prompt: unknown, toolName: string): any {
  const messages = prompt as Array<{ role: string; content: unknown }>;
  for (let m = messages.length - 1; m >= 0; m--) {
    const message = messages[m]!;
    if (message.role !== "tool" || !Array.isArray(message.content)) continue;
    for (const part of message.content as Array<{ type: string; toolName?: string; output?: { value?: unknown } }>) {
      if (part.type === "tool-result" && part.toolName === toolName) return part.output?.value;
    }
  }
  return undefined;
}

function file(id: string): VerifiedFile {
  return { id, storageDirectoryId: "staging", name: `${id}.mkv`, sizeBytes: 10, episodeCode: "S01E01", providerFileId: id };
}

/**
 * Two PanSou rows, two url spellings, one 123 share. linkOf has to go through
 * the registry + resourceLinkKey or the second alias transfers again.
 */
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
            {
              id: "cand_emoji",
              snapshotId: "snap_hades",
              index: 1,
              title: "🎬 黄泉的使者 (2026) 已更新",
              type: "123",
              source: "pansou",
              providerPayload: { url: "https://www.123684.com/s/Ab-cD_12?pwd=x9" },
            },
          ]
        : [],
  }),
};

describe("runAcquisitionV2 — same-link guard uses the registry", () => {
  it("refuses the second alias of one 123 share after the first alias landed", async () => {
    const exec = new FakeStorageExecutor({
      directories: { staging: [], season: [] },
      transferOutcomes: {
        cand_plain: { status: "succeeded", providerMessage: "ok", files: [file("ep1")] },
        cand_emoji: { status: "succeeded", providerMessage: "ok", files: [file("ep1b")] },
      },
    });
    let first = "";
    let second = "";
    let transferError: { error?: string } | undefined;
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return tool("viewResourceSnapshot", {}, i);
        if (i === 2) {
          const doc = String(lastToolOutput(options.prompt, "viewResourceSnapshot").document);
          const rows = [...doc.matchAll(/\[(s\d+-\d+)\]/g)].map((m) => m[1]!);
          first = rows[0]!;
          second = rows[1]!;
          return tool("transferCandidate", { snapshotId: first.split("-")[0], candidateId: first }, i);
        }
        if (i === 3) return tool("transferCandidate", { snapshotId: first.split("-")[0], candidateId: second }, i);
        if (i === 4) {
          transferError = lastToolOutput(options.prompt, "transferCandidate");
          return tool("reportNoCoverage", { reason: "same link" }, i);
        }
        return text("done");
      },
    });

    const result = await runAcquisitionV2({
      provider,
      executor: exec,
      model,
      workflowRunId: "run-same-link",
      target: { kind: "tv", title: "黄泉的使者", aliases: [], seasons: [1], missingEpisodes: ["S01E01"], qualityPreference: "1080p" },
      stagingDirectoryId: "staging",
      targetSeasonDirectoryIds: { 1: "season" },
    });

    expect(transferError?.error).toMatch(/^SANDBOX_SAME_LINK:/);
    expect(transferError?.error).toContain(first);
    expect(transferError?.error).toContain(second);
    expect(transferError?.error).toMatch(/already landed this run/);
    expect(result.outcome.transferAttempts.map((a) => a.candidateId)).toEqual(["cand_plain"]);
  });
});

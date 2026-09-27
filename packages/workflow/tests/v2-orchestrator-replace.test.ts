import { describe, expect, it } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { runAcquisitionV2, type RunAcquisitionV2Request } from "../src/acquisition-v2/orchestrator.js";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceCandidate, VerifiedFile } from "../src/domain.js";
import { FakeStorageExecutor } from "../src/fakes.js";
import { InMemoryWorkflowRepository } from "../src/repository.js";

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
const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], finishReason: { unified: "stop" as const, raw: "stop" as const }, usage: USAGE, warnings: [] });
const contentFilter = () => ({ content: [{ type: "text" as const, text: "" }], finishReason: { unified: "content-filter" as const, raw: "content-filter" as const }, usage: USAGE, warnings: [] });

const NOW = "2026-09-26T08:00:00.000Z";
const OLD_SIZE = Math.round(1.3 * 1024 ** 3);
const CR13_TITLE = "Show - 13 [CR 1080p] [1.3G]";
const NEKOMOE_TITLE = "[Nekomoe] Show 13 [1.0G]";

function seasonFiles(): VerifiedFile[] {
  return [
    { id: "old13", storageDirectoryId: "season", name: "Show - 13 [CR 1080p].mkv", sizeBytes: OLD_SIZE, episodeCode: "S01E13", providerFileId: "old13" },
    { id: "old24", storageDirectoryId: "season", name: "Show - 24 [CR 1080p].mkv", sizeBytes: OLD_SIZE, episodeCode: "S01E24", providerFileId: "old24" },
  ];
}

/** "Show" (the raw pre-search) and "Show 13" both return the look-alike of old13 and a new release. */
function provider(): ResourceProvider {
  return {
    search: async ({ keyword }) => {
      const snapshotId = `snap_${keyword}`;
      const candidates: ResourceCandidate[] =
        keyword === "Show" || keyword === "Show 13"
          ? [
              { id: "cand_cr13", snapshotId, index: 0, title: CR13_TITLE, type: "magnet", source: "pansou", providerPayload: { url: `magnet:?xt=urn:btih:${"a".repeat(40)}` } },
              { id: "cand_nekomoe", snapshotId, index: 1, title: NEKOMOE_TITLE, type: "magnet", source: "pansou", providerPayload: { url: `magnet:?xt=urn:btih:${"b".repeat(40)}` } },
            ]
          : [];
      return { id: snapshotId, provider: "pansou", keyword, candidates, createdAt: NOW };
    },
  };
}

function executor() {
  return new FakeStorageExecutor({
    directories: { staging: [], season: seasonFiles() },
    transferOutcomes: {
      cand_nekomoe: {
        status: "succeeded",
        providerMessage: "ok",
        files: [{ id: "new13", storageDirectoryId: "staging", name: "[Nekomoe] Show 13.mkv", sizeBytes: 1_000_000_000, episodeCode: "S01E13", providerFileId: "new13" }],
      },
      cand_cr13: {
        status: "succeeded",
        providerMessage: "ok",
        files: [{ id: "dup13", storageDirectoryId: "staging", name: "Show - 13 [CR 1080p].mkv", sizeBytes: OLD_SIZE, episodeCode: "S01E13", providerFileId: "dup13" }],
      },
    },
  });
}

type RejectedRow = { episode?: string; linkKey: string | null; label: string; sizeBytes: number | null };

function userRequest(rejectedRows: RejectedRow[]): NonNullable<RunAcquisitionV2Request["userRequest"]> {
  return {
    requestedEpisodes: ["S01E13", "S01E24"],
    prompt: { messages: [{ body: "13、24 发蓝", episodeTags: ["S01E13", "S01E24"], createdAt: NOW }], rejected: [], pending: [] },
    rejectedStore: {
      list: async () => rejectedRows,
      add: async (rows) => {
        rejectedRows.push(...rows);
      },
    },
  };
}

function baseRequest(model: MockLanguageModelV3, exec: FakeStorageExecutor, rejectedRows: RejectedRow[]): RunAcquisitionV2Request {
  return {
    provider: provider(),
    executor: exec,
    model,
    workflowRunId: "run-replace",
    target: { kind: "tv", title: "Show", aliases: [], seasons: [1], missingEpisodes: [], qualityPreference: "1080p", tmdbId: 42 },
    stagingDirectoryId: "staging",
    targetSeasonDirectoryIds: { 1: "season" },
    userRequest: userRequest(rejectedRows),
  };
}

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

describe("runAcquisitionV2 — user replace request", () => {
  it("rejects the current source, hides its copies from later searches, lands a different one beside the old file, and collects per-episode results", async () => {
    const rejectedRows: RejectedRow[] = [];
    const exec = executor();
    const systems: string[] = [];
    let seenTitlesOfShow13Search: string[] = [];
    let alias = "";
    let snapshotAlias = "";
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        systems.push(JSON.stringify(options.prompt.find((m) => m.role === "system") ?? ""));
        i += 1;
        if (i === 1) return tool("inspectTargetDir", { season: 1 }, i);
        if (i === 2) return tool("rejectCurrentSource", { episodes: ["S01E13"], fileIds: ["old13"], reason: "发蓝" }, i);
        // Every requested episode must be rejected before anything transfers.
        if (i === 3) return tool("rejectCurrentSource", { episodes: ["S01E24"], fileIds: ["old24"], reason: "发蓝" }, i);
        if (i === 4) return tool("searchResources", { keyword: "Show 13" }, i);
        if (i === 5) {
          const search = lastToolOutput(options.prompt, "searchResources");
          const candidates = search.snapshot.candidates as Array<{ id: string; title: string }>;
          seenTitlesOfShow13Search = candidates.map((c) => c.title);
          snapshotAlias = search.snapshot.id;
          alias = candidates.find((c) => c.title === NEKOMOE_TITLE)!.id;
          return tool("transferCandidate", { snapshotId: snapshotAlias, candidateId: alias }, i);
        }
        if (i === 6) return tool("moveToSeason", { moves: [{ season: 1, fileIds: ["new13"] }] }, i);
        if (i === 7) return tool("markObtained", { codes: ["S01E13"] }, i);
        if (i === 8) return tool("reportReplacement", { results: [{ episode: "S01E13", outcome: "replaced", candidateId: alias, fileIds: ["new13"], note: "喵萌版" }] }, i);
        if (i === 9) return tool("finish", {}, i);
        return text("done");
      },
    });

    const result = await runAcquisitionV2(baseRequest(model, exec, rejectedRows));

    // The user's words and the rules reached the prompt, and the tools were registered.
    expect(systems[0]).toContain("USER REQUESTS");
    expect(systems[0]).toContain("13、24 发蓝");
    expect(result.replacement?.results).toEqual([
      // candidateId is mapped back from the agent's short alias to the provider's real id,
      // with the resource title and link identity the episode_sources row needs.
      { episode: "S01E13", outcome: "replaced", candidateId: "cand_nekomoe", label: NEKOMOE_TITLE, linkKey: `magnet:${"b".repeat(40)}`, note: "喵萌版" },
      { episode: "S01E24", outcome: "not_found", note: "" },
    ]);
    expect(result.replacement?.rejected).toEqual([
      expect.objectContaining({ episode: "S01E13", label: "Show - 13 [CR 1080p].mkv" }),
      expect.objectContaining({ episode: "S01E24", label: "Show - 24 [CR 1080p].mkv" }),
    ]);
    expect(result.replacement?.oldFiles).toEqual(["Season 01/Show - 13 [CR 1080p].mkv", "Season 01/Show - 24 [CR 1080p].mkv"]);
    // The rejections were written to the store.
    expect(rejectedRows).toEqual([
      expect.objectContaining({ label: "Show - 13 [CR 1080p].mkv", sizeBytes: OLD_SIZE }),
      expect.objectContaining({ label: "Show - 24 [CR 1080p].mkv", sizeBytes: OLD_SIZE }),
    ]);
    // The look-alike of the rejected file never reached the agent:
    expect(seenTitlesOfShow13Search).not.toContain(CR13_TITLE);
    expect(seenTitlesOfShow13Search).toContain(NEKOMOE_TITLE);
    // The requested-but-already-obtained episode joined the need.
    expect(result.coverage.obtained).toContain("S01E13");
    // Old files survived:
    expect((await exec.listTree({ directoryId: "season" })).map((f) => f.providerFileId)).toEqual(
      expect.arrayContaining(["old13", "old24", "new13"]),
    );
  });

  it("a look-alike already in the raw pre-search snapshot is refused at transfer once rejected (nothing transferred)", async () => {
    const rejectedRows: RejectedRow[] = [];
    const exec = executor();
    let transferOutput: any;
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return tool("viewResourceSnapshot", {}, i);
        if (i === 2) return tool("rejectCurrentSource", { episodes: ["S01E13"], fileIds: ["old13"], reason: "发蓝" }, i);
        // Every requested episode must be rejected before anything transfers.
        if (i === 3) return tool("rejectCurrentSource", { episodes: ["S01E24"], fileIds: ["old24"], reason: "发蓝" }, i);
        if (i === 4) {
          // The raw snapshot document lists "[s1-1] <title>" rows.
          const doc = String(lastToolOutput(options.prompt, "viewResourceSnapshot").document);
          const lookAlike = /\[(s(\d+)-\d+)\] Show - 13 \[CR 1080p\]/.exec(doc)!;
          return tool("transferCandidate", { snapshotId: `s${lookAlike[2]}`, candidateId: lookAlike[1] }, i);
        }
        if (i === 5) {
          transferOutput = lastToolOutput(options.prompt, "transferCandidate");
          return tool("reportReplacement", { results: [{ episode: "S01E13", outcome: "not_found", note: "只有同一版本" }] }, i);
        }
        return text("done");
      },
    });

    const result = await runAcquisitionV2(baseRequest(model, exec, rejectedRows));

    expect(String(transferOutput?.error)).toMatch(/SANDBOX_CANDIDATE_REJECTED/);
    expect(result.outcome.transferAttempts).toEqual([]);
    expect((await exec.listTree({ directoryId: "staging" })).length).toBe(0);
    expect(result.replacement?.results).toEqual([
      { episode: "S01E13", outcome: "not_found", note: "只有同一版本" },
      { episode: "S01E24", outcome: "not_found", note: "" },
    ]);
  });

  it("an episode first reported not_found then upgraded to replaced keeps only the last result", async () => {
    const rejectedRows: RejectedRow[] = [];
    const exec = executor();
    let alias = "";
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return tool("rejectCurrentSource", { episodes: ["S01E13"], fileIds: ["old13"], reason: "发蓝" }, i);
        // Every requested episode must be rejected before anything transfers.
        if (i === 2) return tool("rejectCurrentSource", { episodes: ["S01E24"], fileIds: ["old24"], reason: "发蓝" }, i);
        if (i === 3) return tool("reportReplacement", { results: [{ episode: "S01E13", outcome: "not_found", note: "先没找到" }] }, i);
        if (i === 4) return tool("searchResources", { keyword: "Show 13" }, i);
        if (i === 5) {
          const search = lastToolOutput(options.prompt, "searchResources");
          alias = (search.snapshot.candidates as Array<{ id: string; title: string }>).find((c) => c.title === NEKOMOE_TITLE)!.id;
          return tool("transferCandidate", { snapshotId: search.snapshot.id, candidateId: alias }, i);
        }
        if (i === 6) return tool("moveToSeason", { moves: [{ season: 1, fileIds: ["new13"] }] }, i);
        if (i === 7) return tool("markObtained", { codes: ["S01E13"] }, i);
        if (i === 8) return tool("reportReplacement", { results: [{ episode: "S01E13", outcome: "replaced", candidateId: alias, fileIds: ["new13"], note: "喵萌版" }] }, i);
        return text("done");
      },
    });

    const result = await runAcquisitionV2(baseRequest(model, exec, rejectedRows));

    expect(result.replacement?.results.filter((r) => r.episode === "S01E13")).toEqual([
      expect.objectContaining({ outcome: "replaced", candidateId: "cand_nekomoe", note: "喵萌版" }),
    ]);
  });

  it("finalizes after a content-filter recovery turn: the recovery can report, unreported episodes become not_found", async () => {
    const rejectedRows: RejectedRow[] = [];
    const exec = executor();
    let alias = "";
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return tool("rejectCurrentSource", { episodes: ["S01E13"], fileIds: ["old13"], reason: "发蓝" }, i);
        // Every requested episode must be rejected before anything transfers.
        if (i === 2) return tool("rejectCurrentSource", { episodes: ["S01E24"], fileIds: ["old24"], reason: "发蓝" }, i);
        if (i === 3) return tool("searchResources", { keyword: "Show 13" }, i);
        if (i === 4) {
          const search = lastToolOutput(options.prompt, "searchResources");
          alias = (search.snapshot.candidates as Array<{ id: string; title: string }>).find((c) => c.title === NEKOMOE_TITLE)!.id;
          return tool("transferCandidate", { snapshotId: search.snapshot.id, candidateId: alias }, i);
        }
        if (i === 5) return contentFilter();
        // Recovery turn.
        if (i === 6) return tool("moveToSeason", { moves: [{ season: 1, fileIds: ["new13"] }] }, i);
        if (i === 7) return tool("markObtained", { codes: ["S01E13"] }, i);
        if (i === 8) return tool("reportReplacement", { results: [{ episode: "S01E13", outcome: "replaced", candidateId: alias, fileIds: ["new13"], note: "喵萌版" }] }, i);
        return text("done");
      },
    });

    const result = await runAcquisitionV2(baseRequest(model, exec, rejectedRows));

    expect(result.replacement?.results).toEqual([
      expect.objectContaining({ episode: "S01E13", outcome: "replaced", candidateId: "cand_nekomoe" }),
      { episode: "S01E24", outcome: "not_found", note: "" },
    ]);
  });

  it("a failing protected-file capture fails the run before any search (protection is the safety story)", async () => {
    const exec = executor();
    const searched: string[] = [];
    const req = baseRequest(new MockLanguageModelV3({ doGenerate: async () => text("done") }), exec, []);
    const inner = req.provider;
    req.provider = { search: async (input) => { searched.push(input.keyword); return inner.search(input); } };
    const original = exec.listTree.bind(exec);
    exec.listTree = async (input) => {
      if (input.directoryId === "season") throw new Error("drive unreachable");
      return original(input);
    };
    await expect(runAcquisitionV2(req)).rejects.toThrow(/drive unreachable/);
    expect(searched).toEqual([]);
  });

  it("a user request with nothing to say (no messages, nothing pending) is refused — tools are never registered without the rules", async () => {
    const req = baseRequest(new MockLanguageModelV3({ doGenerate: async () => text("done") }), executor(), []);
    req.userRequest = { ...req.userRequest!, prompt: { messages: [], rejected: [], pending: [] } };
    await expect(runAcquisitionV2(req)).rejects.toThrow(/USER_REQUEST_EMPTY/);
  });

  it("a failing rejected-list write never loses the rejection within this run", async () => {
    const exec = executor();
    let seen: string[] = [];
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return tool("rejectCurrentSource", { episodes: ["S01E13"], fileIds: ["old13"], reason: "发蓝" }, i);
        if (i === 2) return tool("searchResources", { keyword: "Show 13" }, i);
        if (i === 3) {
          seen = (lastToolOutput(options.prompt, "searchResources").snapshot.candidates as Array<{ title: string }>).map((c) => c.title);
        }
        return text("done");
      },
    });
    const req = baseRequest(model, exec, []);
    req.userRequest = {
      ...req.userRequest!,
      rejectedStore: {
        list: async () => { throw new Error("db down"); },
        add: async () => { throw new Error("db down"); },
      },
    };
    const result = await runAcquisitionV2(req);
    expect(seen).not.toContain(CR13_TITLE);
    expect(seen).toContain(NEKOMOE_TITLE);
    expect(result.replacement?.rejected).toEqual([expect.objectContaining({ episode: "S01E13" })]);
    expect(result.replacement?.rejectedPersistFailed).toBe(true);
  });

  it("the reflection digest carries the per-episode outcome and tells the model not to note rejections", async () => {
    let reflectionPrompt = "";
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const sys = JSON.stringify(options.prompt.find((m) => m.role === "system") ?? "");
        if (sys.includes("reviewing an acquisition run")) {
          reflectionPrompt = JSON.stringify(options.prompt.filter((m) => m.role === "user"));
          return text("nothing");
        }
        i += 1;
        if (i === 1) return tool("reportReplacement", { results: [{ episode: "S01E13", outcome: "not_found", note: "没有别的版本" }] }, i);
        return text("done");
      },
    });
    const req = baseRequest(model, executor(), []);
    req.memory = { store: new InMemoryWorkflowRepository(), accountId: "acct_1", now: () => NOW };
    await runAcquisitionV2(req);
    expect(reflectionPrompt).toContain("USER REQUEST: S01E13 not_found, S01E24 not_found");
    // The instruction is system text after the untrusted fence, not inside it.
    const close = reflectionPrompt.indexOf("</run_facts>");
    expect(reflectionPrompt.indexOf("USER REQUEST: S01E13")).toBeLessThan(close);
    expect(reflectionPrompt.indexOf("do not write a note about them")).toBeGreaterThan(close);
  });

  it("the reflection digest never carries an empty USER REQUEST line", async () => {
    let reflectionPrompt = "";
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const sys = JSON.stringify(options.prompt.find((m) => m.role === "system") ?? "");
        if (sys.includes("reviewing an acquisition run")) {
          reflectionPrompt = JSON.stringify(options.prompt.filter((m) => m.role === "user"));
          return text("nothing");
        }
        return text("done");
      },
    });
    const req = baseRequest(model, executor(), []);
    // Nothing requested by tag (the agent was to read episodes from the words) and nothing rejected.
    req.userRequest = { ...req.userRequest!, requestedEpisodes: [] };
    req.memory = { store: new InMemoryWorkflowRepository(), accountId: "acct_1", now: () => NOW };
    await runAcquisitionV2(req);
    expect(reflectionPrompt).toContain("USER REQUEST: (no episodes reported)");
  });

  it("rejecting the same file twice (or one already in the store) is recorded once", async () => {
    const rejectedRows: RejectedRow[] = [
      // Stored by an earlier run for S01E24.
      { episode: "S01E24", linkKey: null, label: "Show - 24 [CR 1080p].mkv", sizeBytes: OLD_SIZE },
    ];
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        i += 1;
        if (i === 1) return tool("rejectCurrentSource", { episodes: ["S01E13"], fileIds: ["old13"], reason: "发蓝" }, i);
        if (i === 2) return tool("rejectCurrentSource", { episodes: ["S01E13", "S01E24"], fileIds: ["old13", "old24"], reason: "发蓝" }, i);
        return text("done");
      },
    });
    const result = await runAcquisitionV2(baseRequest(model, executor(), rejectedRows));
    // old13 once for E13; old24 for E24 is already stored; old13×E24 and old24×E13 are new pairs.
    expect(result.replacement?.rejected.map((r) => [r.episode, r.label])).toEqual([
      ["S01E13", "Show - 13 [CR 1080p].mkv"],
      ["S01E24", "Show - 13 [CR 1080p].mkv"],
      ["S01E13", "Show - 24 [CR 1080p].mkv"],
    ]);
    expect(rejectedRows.map((r) => [r.episode, r.label])).toEqual([
      ["S01E24", "Show - 24 [CR 1080p].mkv"],
      ["S01E13", "Show - 13 [CR 1080p].mkv"],
      ["S01E24", "Show - 13 [CR 1080p].mkv"],
      ["S01E13", "Show - 24 [CR 1080p].mkv"],
    ]);
    // Every rejected file is still listed as an old file.
    expect(result.replacement?.oldFiles.sort()).toEqual(["Season 01/Show - 13 [CR 1080p].mkv", "Season 01/Show - 24 [CR 1080p].mkv"]);
  });

  it("a not_found result never carries a candidate, even when the agent passes one", async () => {
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return tool("searchResources", { keyword: "Show 13" }, i);
        if (i === 2) {
          const search = lastToolOutput(options.prompt, "searchResources");
          const alias = (search.snapshot.candidates as Array<{ id: string; title: string }>).find((c) => c.title === NEKOMOE_TITLE)!.id;
          return tool("reportReplacement", { results: [{ episode: "S01E13", outcome: "not_found", candidateId: alias, note: "试过没落地" }] }, i);
        }
        return text("done");
      },
    });
    const result = await runAcquisitionV2(baseRequest(model, executor(), []));
    expect(result.replacement?.results).toEqual([
      { episode: "S01E13", outcome: "not_found", note: "试过没落地" },
      { episode: "S01E24", outcome: "not_found", note: "" },
    ]);
  });

  it("a stored rejection matches by link key even when the title is different", async () => {
    const rejectedRows: RejectedRow[] = [];
    const exec = executor();
    let transferOutput: any;
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return tool("viewResourceSnapshot", {}, i);
        if (i === 2) {
          // Rejected (e.g. by an earlier run) under another name, same magnet.
          rejectedRows.push({ episode: "S01E13", linkKey: `magnet:${"a".repeat(40)}`, label: "Something Else Entirely.mkv", sizeBytes: 1 });
          const doc = String(lastToolOutput(options.prompt, "viewResourceSnapshot").document);
          const row = /\[(s(\d+)-\d+)\] Show - 13 \[CR 1080p\]/.exec(doc)!;
          return tool("transferCandidate", { snapshotId: `s${row[2]}`, candidateId: row[1] }, i);
        }
        if (i === 3) transferOutput = lastToolOutput(options.prompt, "transferCandidate");
        return text("done");
      },
    });
    const req = baseRequest(model, exec, rejectedRows);
    // Pending-only re-check (no NEW message this run): both requested episodes were
    // rejected by an earlier run, so no need to reject again first.
    req.userRequest = {
      ...req.userRequest!,
      prompt: {
        ...req.userRequest!.prompt,
        messages: [],
        pending: ["S01E13", "S01E24"],
        rejected: ["S01E13", "S01E24"].map((episode) => ({ episode, label: "x.mkv", sizeBytes: 1, reason: "发蓝" })),
      },
    };
    const result = await runAcquisitionV2(req);
    expect(String(transferOutput?.error)).toMatch(/SANDBOX_CANDIDATE_REJECTED/);
    expect(result.outcome.transferAttempts).toEqual([]);
  });

  it("pending-only re-check (stored rejection, no new message): transfer allowed without rejectCurrentSource", async () => {
    const rejectedRows: RejectedRow[] = [];
    const exec = executor();
    let transferOutput: any;
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return tool("searchResources", { keyword: "Show 13" }, i);
        if (i === 2) {
          const search = lastToolOutput(options.prompt, "searchResources");
          const alias = (search.snapshot.candidates as Array<{ id: string; title: string }>).find((c) => c.title === NEKOMOE_TITLE)!.id;
          return tool("transferCandidate", { snapshotId: search.snapshot.id, candidateId: alias }, i);
        }
        if (i === 3) transferOutput = lastToolOutput(options.prompt, "transferCandidate");
        return text("done");
      },
    });
    const req = baseRequest(model, exec, rejectedRows);
    req.userRequest = {
      ...req.userRequest!,
      requestedEpisodes: ["S01E13"],
      prompt: {
        // No new message this run — the stored rejection is why we are re-checking.
        messages: [],
        pending: ["S01E13"],
        rejected: [{ episode: "S01E13", label: "Show - 13 [CR 1080p].mkv", sizeBytes: OLD_SIZE, reason: "发蓝" }],
      },
    };
    const result = await runAcquisitionV2(req);
    expect(transferOutput?.attempt?.status).toBe("succeeded");
    expect(result.outcome.transferAttempts.some((a) => a.status === "succeeded")).toBe(true);
  });

  it("a NEW message naming an already-stored-rejected episode still requires rejectCurrentSource first (the current file may itself be an earlier replacement)", async () => {
    const rejectedRows: RejectedRow[] = [];
    const exec = executor();
    let transferOutput: any;
    let i = 0;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        i += 1;
        if (i === 1) return tool("searchResources", { keyword: "Show 13" }, i);
        if (i === 2) {
          const search = lastToolOutput(options.prompt, "searchResources");
          const alias = (search.snapshot.candidates as Array<{ id: string; title: string }>).find((c) => c.title === NEKOMOE_TITLE)!.id;
          return tool("transferCandidate", { snapshotId: search.snapshot.id, candidateId: alias }, i);
        }
        if (i === 3) transferOutput = lastToolOutput(options.prompt, "transferCandidate");
        return text("done");
      },
    });
    const req = baseRequest(model, exec, rejectedRows);
    req.userRequest = {
      ...req.userRequest!,
      requestedEpisodes: ["S01E13"],
      prompt: {
        // A NEW message about the same episode: the current file (which may be an
        // earlier replacement) must be rejected fresh — the old stored rejection
        // must not open the gate.
        messages: [{ body: "还是不对", episodeTags: ["S01E13"], createdAt: NOW }],
        pending: [],
        rejected: [{ episode: "S01E13", label: "Show - 13 [CR 1080p].mkv", sizeBytes: OLD_SIZE, reason: "发蓝" }],
      },
    };
    const result = await runAcquisitionV2(req);
    expect(String(transferOutput?.error)).toMatch(/SANDBOX_REJECT_FIRST/);
    expect(result.outcome.transferAttempts).toEqual([]);
  });

  it("no user request → no replace tools, no user-request block, no replacement result", async () => {
    let tools: string[] = [];
    let system = "";
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        tools = (options.tools ?? []).map((t) => t.name);
        system = JSON.stringify(options.prompt.find((m) => m.role === "system") ?? "");
        return text("done");
      },
    });
    const req = baseRequest(model, executor(), []);
    delete req.userRequest;
    const result = await runAcquisitionV2(req);
    expect(tools).not.toContain("rejectCurrentSource");
    expect(tools).not.toContain("reportReplacement");
    expect(system).not.toContain("USER REQUESTS");
    expect(result.replacement).toBeUndefined();
  });
});

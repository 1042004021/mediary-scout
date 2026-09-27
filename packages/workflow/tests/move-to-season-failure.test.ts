import { describe, expect, it } from "vitest";
import { buildSandboxToolSet } from "../src/acquisition-v2/agent-loop.js";
import { readSkillSection } from "../src/acquisition-v2/skill.js";
import { buildTvAnimeSystemPrompt } from "../src/acquisition-v2/task-agents.js";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import { Storage115Simulator } from "../src/acquisition-v2/storage-115-simulator.js";

const MOVE_FAILED_SENTENCE =
  "If moveToSeason fails, those files did NOT move — do not markObtained their episodes this run.";

async function stagedFile() {
  const provider = new FakeResourceProviderV2({
    results: { show: [{ id: "pack", title: "Show S01" }] },
  });
  const storage = new Storage115Simulator({
    packs: { pack: { files: [{ path: "Show/Show - 01.mkv", sizeBytes: 9 }] } },
  });
  const stagingDirectoryId = await storage.createDirectory({ name: "staging", parentId: "root" });
  const season = await storage.createDirectory({ name: "Season 1", parentId: "root" });
  const sandbox = new TaskSandbox({
    provider,
    storage,
    stagingDirectoryId,
    targetSeasonDirectoryIds: { 1: season },
    need: ["S01E01"],
  });
  const search = await sandbox.searchResources("show");
  const transfer = await sandbox.transferCandidate({
    snapshotId: search.snapshot!.id,
    candidateId: "pack",
  });
  return { sandbox, storage, fileId: transfer.staging[0]!.id };
}

describe("moveToSeason failure", () => {
  it("tells the agent the files did not move and must not be marked obtained", async () => {
    const { sandbox, storage, fileId } = await stagedFile();
    storage.moveFiles = async () => {
      throw new Error("PAN115_RATE_LIMIT: API call budget exhausted before moveItems; maxCallsPerOperation=295");
    };
    const tools = buildSandboxToolSet(sandbox);
    const execute = tools["moveToSeason"]!.execute as (args: {
      moves: Array<{ season?: number; fileIds: string[] }>;
    }) => Promise<{ error?: string }>;
    const result = await execute({ moves: [{ season: 1, fileIds: [fileId] }] });
    expect(result.error).toMatch(/did NOT move/);
    expect(result.error).toMatch(/markObtained/);
    expect(result.error).toMatch(/this run/);
    expect(result.error).toContain(fileId);
    expect(result.error).toContain("budget exhausted before moveItems");
    const season = await sandbox.inspectTargetDir({ season: 1 });
    expect(season).toEqual([]);
  });

  it("TV playbook and task prompt say a failed move must not be marked obtained", () => {
    expect(readSkillSection("tv")).toContain(MOVE_FAILED_SENTENCE);
    expect(buildTvAnimeSystemPrompt({})).toContain(MOVE_FAILED_SENTENCE);
  });
});

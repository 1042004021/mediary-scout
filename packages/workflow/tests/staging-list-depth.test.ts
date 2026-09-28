import { describe, expect, it } from "vitest";
import { TaskSandbox } from "../src/acquisition-v2/sandbox.js";
import { FakeResourceProviderV2 } from "../src/acquisition-v2/fake-provider.js";
import type { SimTreeFile, StorageV2 } from "../src/acquisition-v2/storage-115-simulator.js";
import { JANITOR_LIST_DEPTH } from "../src/staging-depth.js";

/** A file inside a directory entered at depth 8 (seven path segments). Executors
 *  default listTree to 6, so this file is invisible unless maxDepth is at least 8. */
const DEEP_FILE: SimTreeFile = {
  id: "deep-8",
  path: "L1/L2/L3/L4/L5/L6/L7/Show.S01E08.mkv",
  sizeBytes: 80,
  isVideo: true,
  isSubtitle: false,
};

function depthOfFile(): number {
  return DEEP_FILE.path.split("/").filter((segment) => segment.length > 0).length;
}

function storage(): StorageV2 & { depths: Array<number | undefined> } {
  const depths: Array<number | undefined> = [];
  const moved: string[] = [];
  return {
    depths,
    async createDirectory() {
      return "created";
    },
    async transferCandidate() {
      throw new Error("no transfer");
    },
    candidateLinkKind() {
      return "unknown";
    },
    async listTree(input: { directoryId: string; maxDepth?: number }) {
      depths.push(input.maxDepth);
      if (input.directoryId !== "stg") return [];
      // Entry depth of the file's directory is its segment count (the file name
      // is the last segment). Default 6 stops before depth 8.
      const entryDepth = depthOfFile() - 1 + 1;
      const limit = input.maxDepth ?? 6;
      return entryDepth <= limit ? [DEEP_FILE] : [];
    },
    async listSubdirectories() {
      return [];
    },
    async moveFiles(input: { fileIds: string[]; targetDirectoryId: string }) {
      moved.push(...input.fileIds);
      return { moved: input.fileIds };
    },
    async renameFile() {
      return undefined;
    },
    async deleteFiles() {
      return { deleted: [] };
    },
    async removeDirectory() {
      return { removed: [] };
    },
    async transferSubtitleUrls() {
      return [];
    },
  };
}

function sandbox(store: StorageV2, stagingListDepth?: number) {
  return new TaskSandbox({
    provider: new FakeResourceProviderV2({ results: {} }),
    storage: store,
    stagingDirectoryId: "stg",
    targetSeasonDirectoryIds: { 1: "season" },
    need: ["S01E08"],
    ...(stagingListDepth === undefined ? {} : { stagingListDepth }),
  });
}

describe("recovery staging depth", () => {
  it("a recovery sees and can move a video at depth 8; an ordinary inspection stays at the default", async () => {
    const recoveryStore = storage();
    const recovery = sandbox(recoveryStore, JANITOR_LIST_DEPTH);
    const seen = await recovery.inspectStaging();
    expect(seen.map((file) => file.id)).toEqual(["deep-8"]);
    expect(recoveryStore.depths).toEqual([JANITOR_LIST_DEPTH]);
    const moved = await recovery.moveToSeason({ moves: [{ season: 1, fileIds: ["deep-8"] }] });
    expect(moved.seasons[1]?.map((file) => file.id)).toEqual([]);
    expect(recoveryStore.depths.every((depth) => depth === JANITOR_LIST_DEPTH || depth === undefined)).toBe(true);
    expect(recoveryStore.depths.filter((depth) => depth === JANITOR_LIST_DEPTH).length).toBeGreaterThan(1);

    const ordinaryStore = storage();
    const ordinary = sandbox(ordinaryStore);
    expect(await ordinary.inspectStaging()).toEqual([]);
    expect(ordinaryStore.depths).toEqual([undefined]);
  });
});

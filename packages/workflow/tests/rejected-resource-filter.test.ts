import { describe, expect, it } from "vitest";
import { CandidateRegistry } from "../src/acquisition-v2/candidate-registry.js";
import { RealResourceProviderV2 } from "../src/acquisition-v2/real-provider-adapter.js";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceSnapshot } from "../src/domain.js";

function snapshotOf(rows: Array<{ id: string; title: string; url: string }>): ResourceSnapshot {
  return {
    id: "snap", provider: "pansou", keyword: "k", createdAt: "2026-09-26T00:00:00.000Z",
    candidates: rows.map((r, index) => ({ id: r.id, snapshotId: "snap", index, title: r.title, type: "115", source: "pansou", providerPayload: { url: r.url } })),
  };
}

describe("RealResourceProviderV2 — rejected resources", () => {
  it("drops a candidate whose link or label+size matches a rejected resource, re-reading the list each search", async () => {
    let rejected: Array<{ linkKey: string | null; label: string; sizeBytes: number | null }> = [];
    const provider: ResourceProvider = {
      search: async () => snapshotOf([
        { id: "same_link", title: "奥德赛 2026", url: "https://115.com/s/fake1" },
        { id: "same_file", title: "The Odyssey 2026 [2.3G]", url: "https://115.com/s/fake2" },
        { id: "real", title: "奥德赛 诺兰 2026 IMAX [30.5G]", url: "https://115.com/s/real" },
      ]),
    };
    const adapter = new RealResourceProviderV2({
      provider, registry: new CandidateRegistry(), workflowRunId: "r",
      rejectedResources: { list: async () => rejected },
    });
    expect((await adapter.search("奥德赛")).candidates).toHaveLength(3);

    rejected = [{ linkKey: "115:fake1", label: "The.Odyssey.2026.1080p.WEB-DL.mkv", sizeBytes: Math.round(2.3 * 1024 ** 3) }];
    const view = await adapter.search("奥德赛");
    expect(view.candidates.map((c) => c.title)).toEqual(["奥德赛 诺兰 2026 IMAX [30.5G]"]);
    // The persisted snapshot is the filtered one, like dead links.
    expect(adapter.snapshots().at(-1)!.candidates.map((c) => c.id)).toEqual(["real"]);
  });

  it("a failing rejected list never breaks the search", async () => {
    const adapter = new RealResourceProviderV2({
      provider: { search: async () => snapshotOf([{ id: "a", title: "x", url: "https://115.com/s/a" }]) },
      registry: new CandidateRegistry(), workflowRunId: "r",
      rejectedResources: { list: async () => { throw new Error("db down"); } },
    });
    expect((await adapter.search("x")).candidates).toHaveLength(1);
  });
});

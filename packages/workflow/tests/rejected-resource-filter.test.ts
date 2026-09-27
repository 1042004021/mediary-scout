import { describe, expect, it } from "vitest";
import { CandidateRegistry } from "../src/acquisition-v2/candidate-registry.js";
import { RealResourceProviderV2 } from "../src/acquisition-v2/real-provider-adapter.js";
import type { ResourceProvider } from "../src/ports.js";
import type { ResourceSnapshot } from "../src/domain.js";

function snapshotOf(id: string, rows: Array<{ id: string; title: string; url: string }>): ResourceSnapshot {
  return {
    id, provider: "pansou", keyword: "k", createdAt: "2026-09-26T00:00:00.000Z",
    candidates: rows.map((r, index) => ({ id: r.id, snapshotId: id, index, title: r.title, type: "115", source: "pansou", providerPayload: { url: r.url } })),
  };
}

describe("RealResourceProviderV2 — rejected resources", () => {
  it("drops a candidate whose link or label+size matches a rejected resource, re-reading the list each search", async () => {
    let rejected: Array<{ linkKey: string | null; label: string; sizeBytes: number | null }> = [];
    let n = 0;
    const provider: ResourceProvider = {
      search: async () => snapshotOf(`snap_${n++}`, [
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
    // A distinct snapshot id per call (as a real content-addressed provider would
    // NOT repeat here since the query returns a fresh snapshot each time), so the
    // persisted snapshot for THIS search is exactly the filtered view.
    expect(adapter.snapshots().at(-1)!.candidates.map((c) => c.id)).toEqual(["real"]);
    // The surviving candidate (third in the provider's own list) keeps its
    // positional alias — it is not renumbered to first after its two neighbours
    // are filtered out.
    expect(view.candidates.map((c) => c.id)).toEqual(["s2-3"]);
  });

  it("a failing rejected list never breaks the search", async () => {
    const adapter = new RealResourceProviderV2({
      provider: { search: async () => snapshotOf("snap_a", [{ id: "a", title: "x", url: "https://115.com/s/a" }]) },
      registry: new CandidateRegistry(), workflowRunId: "r",
      rejectedResources: { list: async () => { throw new Error("db down"); } },
    });
    expect((await adapter.search("x")).candidates).toHaveLength(1);
  });

  it("strict (a user replace run): a failing rejected list fails the search instead of showing what the user rejected", async () => {
    const adapter = new RealResourceProviderV2({
      provider: { search: async () => snapshotOf("snap_a", [{ id: "a", title: "x", url: "https://115.com/s/a" }]) },
      registry: new CandidateRegistry(), workflowRunId: "r",
      rejectedResources: { list: async () => { throw new Error("db down"); }, strict: true },
    });
    await expect(adapter.search("x")).rejects.toThrow(/db down/);
    expect(adapter.snapshots()).toEqual([]);
  });

  it("unions persisted snapshots by candidate id instead of overwriting — a candidate already surfaced (and possibly transferred) stays persisted even after a later rejection filters it from view", async () => {
    let rejected: Array<{ linkKey: string | null; label: string; sizeBytes: number | null }> = [];
    // Same snapshot id on every call, like a real content-addressed provider
    // repeating results across searches within one run.
    const snapshot = snapshotOf("snap_same", [{ id: "a", title: "A", url: "https://115.com/s/a" }]);
    const adapter = new RealResourceProviderV2({
      provider: { search: async () => snapshot },
      registry: new CandidateRegistry(), workflowRunId: "r",
      rejectedResources: { list: async () => rejected },
    });
    // First search: A is kept and visible — the agent could transfer it now,
    // recording a transfer attempt against candidate "a" in snapshot "snap_same".
    expect((await adapter.search("k")).candidates.map((c) => c.id)).toEqual(["s1-1"]);

    // A rejection made mid-run now filters A out of what the agent sees...
    rejected = [{ linkKey: "115:a", label: "A", sizeBytes: null }];
    const view = await adapter.search("k");
    expect(view.candidates).toHaveLength(0);

    // ...but the persisted snapshot (same id) must still contain A — dropping it
    // would make persist() throw "Transfer attempt … referenced an unknown
    // candidate" (validateWorkflowRunSnapshot in repository.ts) for the earlier
    // transfer attempt.
    expect(adapter.snapshots()).toHaveLength(1);
    expect(adapter.snapshots()[0]!.candidates.map((c) => c.id)).toEqual(["a"]);
  });
});

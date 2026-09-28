import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchCommitRelation, fetchReleaseFeed, invalidateReleaseFeedCache } from "./release-feed-server";

function fakeFetch(routes: Record<string, { status: number; body: string }>) {
  return vi.fn(async (url: string) => {
    const hit = routes[url];
    if (!hit) return new Response("not found", { status: 404 });
    return new Response(hit.body, { status: hit.status });
  }) as unknown as typeof fetch;
}

const TAGS = "https://api.github.com/repos/fancydirty/mediary-scout/tags?per_page=30";
const notes = (tag: string) =>
  `https://api.github.com/repos/fancydirty/mediary-scout/contents/release-notes/${tag}.md?ref=${tag}`;
const compare = (base: string, head: string) =>
  `https://api.github.com/repos/fancydirty/mediary-scout/compare/${base}...${head}`;

describe("fetchReleaseFeed", () => {
  beforeEach(() => invalidateReleaseFeedCache());

  it("keeps only valid release tags, newest first, with their notes", async () => {
    const fetchImpl = fakeFetch({
      [TAGS]: {
        status: 200,
        body: JSON.stringify([
          { name: "v1.4.1", commit: { sha: "a".repeat(40) } },
          { name: "v2026.09.28", commit: { sha: "b".repeat(40) } },
          { name: "v2026.10.02", commit: { sha: "c".repeat(40) } },
        ]),
      },
      [notes("v2026.10.02")]: { status: 200, body: "- 新增 一键更新" },
      [notes("v2026.09.28")]: { status: 404, body: "" },
    });
    const feed = await fetchReleaseFeed(fetchImpl);
    expect(feed.map((r) => r.tag)).toEqual(["v2026.10.02", "v2026.09.28"]);
    expect(feed[0]).toMatchObject({ commit: "c".repeat(40), notes: [{ kind: "add", text: "一键更新" }] });
    expect(feed[1]!.notes).toEqual([]);
  });

  it("returns [] when GitHub is unreachable, and caches the failure", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchReleaseFeed(fetchImpl)).toEqual([]);
    expect(await fetchReleaseFeed(fetchImpl)).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("fetchCommitRelation", () => {
  beforeEach(() => invalidateReleaseFeedCache());

  it("returns where head stands relative to base", async () => {
    const base = "b".repeat(40);
    const head = "d".repeat(40);
    const fetchImpl = fakeFetch({ [compare(base, head)]: { status: 200, body: JSON.stringify({ status: "ahead" }) } });
    expect(await fetchCommitRelation(base, head, fetchImpl)).toBe("ahead");
  });

  it("returns null on failure or an unknown status", async () => {
    const base = "b".repeat(40);
    const head = "d".repeat(40);
    expect(await fetchCommitRelation(base, head, fakeFetch({}))).toBeNull();
    const odd = fakeFetch({ [compare(base, head)]: { status: 200, body: JSON.stringify({ status: "weird" }) } });
    invalidateReleaseFeedCache();
    expect(await fetchCommitRelation(base, head, odd)).toBeNull();
  });
});

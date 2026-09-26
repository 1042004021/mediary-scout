import { describe, expect, it } from "vitest";
import {
  USER_MESSAGE_LIMITS,
  normalizeResourceLabel,
  parseSizeFromTitle,
  resourceFingerprintMatches,
  userMessageFromRow,
  validateUserMessageInput,
  type UserMessageRow,
} from "../src/user-requests.js";

describe("validateUserMessageInput", () => {
  it("accepts a normal message with episode tags", () => {
    expect(validateUserMessageInput({ body: "画面发蓝，换个别的版本", episodeTags: ["S01E13", "S01E24"] })).toBeNull();
  });
  it("rejects empty / too long / bad tags", () => {
    expect(validateUserMessageInput({ body: "  ", episodeTags: [] })).toMatch(/留言/);
    expect(validateUserMessageInput({ body: "x".repeat(USER_MESSAGE_LIMITS.bodyMax + 1), episodeTags: [] })).toMatch(/500/);
    expect(validateUserMessageInput({ body: "ok", episodeTags: ["E13"] })).toMatch(/集数/);
    expect(validateUserMessageInput({ body: "ok", episodeTags: Array.from({ length: 201 }, (_, i) => `S01E${i}`) })).toMatch(/集数/);
  });
  it("allows the movie anchor tag", () => {
    expect(validateUserMessageInput({ body: "假片", episodeTags: ["MOVIE"] })).toBeNull();
  });
});

describe("resource fingerprint", () => {
  it("normalizes release noise away", () => {
    expect(normalizeResourceLabel("The.Odyssey.2026.1080p.WEB-DL.H264.mkv")).toBe(normalizeResourceLabel("The Odyssey 2026 [2.3G]"));
    expect(normalizeResourceLabel("【喵萌奶茶屋】黄泉的使者 13 [1080p][简日双语]")).toBe(normalizeResourceLabel("黄泉的使者 13"));
  });
  it("reads a size out of a PanSou-style title", () => {
    expect(parseSizeFromTitle("肖申克的救赎 1080p [2.2G]")).toBe(Math.round(2.2 * 1024 ** 3));
    expect(parseSizeFromTitle("Movie 850MB")).toBe(850 * 1024 ** 2);
    expect(parseSizeFromTitle("Movie no size")).toBeNull();
  });
  it("matches only when label AND size (±2%) agree", () => {
    const rejected = { label: "The.Odyssey.2026.1080p.WEB-DL.mkv", sizeBytes: Math.round(2.3 * 1024 ** 3) };
    expect(resourceFingerprintMatches("The Odyssey 2026 [2.3G]", rejected)).toBe(true);
    expect(resourceFingerprintMatches("The Odyssey 2026 [4.6G]", rejected)).toBe(false);
    expect(resourceFingerprintMatches("The Odyssey 2026", rejected)).toBe(false); // no size in title → leave to agent
    expect(resourceFingerprintMatches("The Odyssey 2026 [2.3G]", { ...rejected, sizeBytes: null })).toBe(false);
  });
});

describe("userMessageFromRow", () => {
  const row: UserMessageRow = {
    id: "msg_1", account_id: "acct_a", drive: "cs_1", title_key: "tmdb_tv_1", body: "hi", episode_tags: "[]",
    status: "pending", urgent: 0, run_id: null, reply: null,
    created_at: "2026-09-26T00:00:00.000Z", updated_at: "2026-09-26T00:00:00.000Z", processed_at: null,
  };
  it("fails loud on an unknown status instead of treating it as pending", () => {
    expect(() => userMessageFromRow({ ...row, status: "archived" })).toThrow(/msg_1/);
  });
  it("reads a corrupt reply as null", () => {
    expect(userMessageFromRow({ ...row, status: "done", reply: "{not json" }).reply).toBeNull();
  });
});

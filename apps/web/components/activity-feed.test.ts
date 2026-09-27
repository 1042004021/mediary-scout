import { describe, expect, it } from "vitest";
import { cancelCopy } from "./activity-feed";

describe("cancelCopy — what cancelling a queued run says it does", () => {
  it("an acquisition goes with its title: 取消并移出", () => {
    expect(cancelCopy("type2_init")).toEqual({ action: "取消获取", confirm: "取消并移出", note: null });
    expect(cancelCopy("movie_init")).toEqual({ action: "取消获取", confirm: "取消并移出", note: null });
  });

  it("a replace run only drops this attempt: the library stays and the message waits for the next patrol", () => {
    expect(cancelCopy("replace_request")).toEqual({
      action: "取消这次换源",
      confirm: "取消这次换源",
      note: "留言等下次巡检再处理",
    });
  });
});

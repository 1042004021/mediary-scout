import { isValidElement, type ReactElement } from "react";
import { describe, expect, it } from "vitest";
import { ReleaseBlock } from "./update-section";

describe("ReleaseBlock", () => {
  it("gives every note a unique key, even when two notes share the same text", () => {
    const block = ReleaseBlock({
      release: {
        tag: "v2026.10.02",
        date: "2026-10-02",
        commit: "c".repeat(40),
        isCurrent: false,
        notes: [
          { kind: "fix", text: "修复 123 云盘的问题" },
          { kind: "fix", text: "修复 123 云盘的问题" },
        ],
      },
    });
    const list = (block.props as { children: ReactElement[] }).children.find(
      (child) => isValidElement(child) && child.type === "ul",
    ) as ReactElement<{ children: ReactElement[] }>;
    const keys = list.props.children.map((item) => item.key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
  });
});

import { describe, expect, it } from "vitest";
import { deadLinkKey } from "../src/acquisition-v2/dead-links.js";
import { resourceLinkKey } from "../src/acquisition-v2/resource-link.js";

describe("resourceLinkKey — a resource's link identity for rejections and recorded sources", () => {
  it("115 shares, magnets and 光鸭 shares: the same key dead-link tracking uses", () => {
    for (const url of [
      "https://115.com/s/sw3abcd1234?password=x1y2",
      `magnet:?xt=urn:btih:${"A".repeat(40)}&dn=x`,
      "https://www.guangyapan.com/s/AbCdEf123",
    ]) {
      expect(resourceLinkKey(url)).toBe(deadLinkKey(url)!.key);
    }
  });

  it("夸克 / 123 / 天翼 shares, which dead-link tracking leaves out, get a key of their own — the same share under any passcode or fragment", () => {
    expect(deadLinkKey("https://pan.quark.cn/s/1a2B3c4D")).toBeNull();
    expect(resourceLinkKey("https://pan.quark.cn/s/1a2B3c4D")).toBe("quark:1a2B3c4D");
    expect(resourceLinkKey("https://pan.quark.cn/s/1a2B3c4D?pwd=abcd#/list/share")).toBe("quark:1a2B3c4D");

    expect(resourceLinkKey("https://www.123pan.com/s/Ab-cD_12")).toBe("pan123:Ab-cD_12");
    expect(resourceLinkKey("https://www.123684.com/s/Ab-cD_12?pwd=x9")).toBe("pan123:Ab-cD_12");

    expect(resourceLinkKey("https://cloud.189.cn/t/QvEjYz3m")).toBe("tianyi:QvEjYz3m");
    expect(resourceLinkKey("https://cloud.189.cn/t/QvEjYz3m?accessCode=8fd2")).toBe("tianyi:QvEjYz3m");
    expect(resourceLinkKey("https://cloud.189.cn/web/share?code=QvEjYz3m&pwd=8fd2")).toBe("tianyi:QvEjYz3m");
  });

  it("different shares stay different; a link no drive transfers by has no key", () => {
    expect(resourceLinkKey("https://pan.quark.cn/s/aaaa1111")).not.toBe(resourceLinkKey("https://pan.quark.cn/s/bbbb2222"));
    expect(resourceLinkKey("https://example.com/The.Odyssey.2026.mkv")).toBeNull();
    expect(resourceLinkKey("")).toBeNull();
  });
});

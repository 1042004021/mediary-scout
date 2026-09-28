import { createElement, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UpdateView } from "../../lib/update-state";
import { ReleaseBlock, UpdateTab } from "./update-section";

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

const view = (overrides: Partial<UpdateView>): UpdateView => ({
  current: { label: "v2026.09.28", tag: "v2026.09.28" },
  available: null,
  status: "latest",
  releases: [],
  updater: null,
  download: null,
  ...overrides,
});
const newer = { tag: "v2026.10.02", date: "2026-10-02", commit: "c".repeat(40), notes: [] };
const DMG = "https://github.com/fancydirty/mediary-scout/releases/download/v2026.10.02/a.dmg";
const render = (props: { view: UpdateView; desktop: boolean }) => renderToStaticMarkup(createElement(UpdateTab, props));

describe("UpdateTab on desktop", () => {
  it("offers a one-click download of this platform's installer, and says how to install it", () => {
    const html = render({ desktop: true, view: view({ available: newer, status: "available", download: { url: DMG, file: "dmg" } }) });
    expect(html).toContain(`href="${DMG}"`);
    expect(html).toContain("下载新版本");
    expect(html).toContain("先从菜单栏图标退出巡影，再把新版拖进「应用程序」替换");
  });

  it("says what the Windows installer does", () => {
    const html = render({
      desktop: true,
      view: view({ available: newer, status: "available", download: { url: DMG.replace(".dmg", ".exe"), file: "exe" } }),
    });
    expect(html).toContain("下载后运行安装包，它会先关掉正在运行的巡影再安装");
  });

  it("shows nothing extra when already on the newest release", () => {
    const html = render({ desktop: true, view: view({}) });
    expect(html).not.toContain("下载新版本");
    expect(html).not.toContain("releases/latest");
  });

  it("points to the release page when it cannot tell", () => {
    expect(render({ desktop: true, view: view({ status: "offline" }) })).toContain("releases/latest");
    expect(render({ desktop: true, view: view({ status: "unknown" }) })).toContain("releases/latest");
  });

  it("never shows the desktop download on a Docker instance", () => {
    const html = render({ desktop: false, view: view({ available: newer, status: "available" }) });
    expect(html).not.toContain("下载新版本");
    expect(html).not.toContain("releases/latest");
  });
});

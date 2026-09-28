import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appVersionFromTag } from "../src/release-version.js";

const require = createRequire(import.meta.url);
const { stampRelease } = require("../scripts/stamp-release.cjs") as {
  stampRelease: (input: {
    tag: string;
    commit: string;
    desktopDir: string;
    standaloneWebDir: string;
    appVersionFromTag: (tag: string) => string | null;
  }) => { version: string };
};

const COMMIT = "a".repeat(40);

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "stamp-release-"));
  const desktopDir = path.join(root, "desktop");
  const standaloneWebDir = path.join(root, "standalone", "apps", "web");
  mkdirSync(desktopDir, { recursive: true });
  mkdirSync(standaloneWebDir, { recursive: true });
  const pkg = { name: "@media-track/desktop", private: true, version: "1.4.1", main: "dist/main.js" };
  writeFileSync(path.join(desktopDir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(path.join(standaloneWebDir, "server.js"), "// next standalone server\n");
  return { desktopDir, standaloneWebDir };
}

describe("stampRelease", () => {
  it("writes the tag's app version and the build commit", () => {
    const { desktopDir, standaloneWebDir } = fixture();
    expect(stampRelease({ tag: "v2026.09.28.2", commit: COMMIT, desktopDir, standaloneWebDir, appVersionFromTag })).toEqual({
      version: "2026.928.2",
    });
    expect(JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8"))).toEqual({
      name: "@media-track/desktop",
      private: true,
      version: "2026.928.2",
      main: "dist/main.js",
    });
    expect(readFileSync(path.join(standaloneWebDir, "BUILD_COMMIT"), "utf8")).toBe(`${COMMIT}\n`);
  });

  it("refuses a tag that is not a release tag, and writes nothing", () => {
    const { desktopDir, standaloneWebDir } = fixture();
    for (const tag of ["v1.5.0", "v2026.02.31", ""]) {
      expect(() => stampRelease({ tag, commit: COMMIT, desktopDir, standaloneWebDir, appVersionFromTag })).toThrow(
        /not a release tag/,
      );
    }
    expect(JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8")).version).toBe("1.4.1");
    expect(() => readFileSync(path.join(standaloneWebDir, "BUILD_COMMIT"))).toThrow();
  });

  it("refuses a malformed commit", () => {
    const { desktopDir, standaloneWebDir } = fixture();
    expect(() => stampRelease({ tag: "v2026.09.28", commit: "main", desktopDir, standaloneWebDir, appVersionFromTag })).toThrow(
      /commit/,
    );
  });

  it("refuses when the standalone server has not been built", () => {
    const { desktopDir, standaloneWebDir } = fixture();
    rmSync(path.join(standaloneWebDir, "server.js"));
    expect(() => stampRelease({ tag: "v2026.09.28", commit: COMMIT, desktopDir, standaloneWebDir, appVersionFromTag })).toThrow(
      /standalone server/,
    );
    expect(JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8")).version).toBe("1.4.1");
  });
});

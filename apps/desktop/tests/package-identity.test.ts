import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APP_ID } from "../src/app-identity.js";

const read = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");

describe("desktop app identity", () => {
  it("keeps the package name that picks the user-data folder", () => {
    const pkg = JSON.parse(read("../package.json")) as { name?: unknown; productName?: unknown };
    // Electron's userData = <appData>/<productName ?? name>. Installed apps keep their database
    // in ".../@media-track/desktop"; renaming the package, or adding a productName, would start
    // a new version on an empty folder and the user would see all their data gone.
    expect(pkg.name).toBe("@media-track/desktop");
    expect(pkg.productName).toBeUndefined();
  });

  it("keeps the appId and product name that make a new version replace the old one", () => {
    const builder = read("../electron-builder.yml");
    expect(builder).toMatch(new RegExp(`^appId: ${APP_ID.replaceAll(".", "\\.")}$`, "m"));
    expect(builder).toMatch(/^productName: Mediary Scout$/m);
  });
});

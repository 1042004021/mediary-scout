"use strict";
// CI step before packaging a release (see .github/workflows/release-desktop.yml):
// the desktop app version comes from the release tag, and the commit goes into the
// standalone server bundle as BUILD_COMMIT, which the settings 「更新」 tab reads.
// Usage: node apps/desktop/scripts/stamp-release.cjs <tag>
// Needs `npm run build:web` and `npm run build --workspace @media-track/desktop` first.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function stampRelease({ tag, commit, desktopDir, standaloneWebDir, appVersionFromTag }) {
  const version = appVersionFromTag(String(tag ?? ""));
  if (!version) {
    throw new Error(`${tag} is not a release tag (vYYYY.MM.DD or vYYYY.MM.DD.N with a real date)`);
  }
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error(`not a commit sha: ${commit}`);
  }
  if (!fs.existsSync(path.join(standaloneWebDir, "server.js"))) {
    throw new Error(`standalone server not built: ${path.join(standaloneWebDir, "server.js")} is missing`);
  }
  const packagePath = path.join(desktopDir, "package.json");
  const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
  // Only the version changes: the package name picks the user-data folder.
  pkg.version = version;
  fs.writeFileSync(packagePath, `${JSON.stringify(pkg, null, 2)}\n`);
  fs.writeFileSync(path.join(standaloneWebDir, "BUILD_COMMIT"), `${commit}\n`);
  return { version };
}

module.exports = { stampRelease };

if (require.main === module) {
  const desktopDir = path.resolve(__dirname, "..");
  const repoRoot = path.resolve(desktopDir, "..", "..");
  try {
    const { appVersionFromTag } = require(path.join(desktopDir, "dist", "release-version.js"));
    const tag = process.argv[2];
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const { version } = stampRelease({
      tag,
      commit,
      desktopDir,
      standaloneWebDir: path.join(repoRoot, "apps", "web", ".next", "standalone", "apps", "web"),
      appVersionFromTag,
    });
    console.log(`stamped ${tag} as app version ${version}, BUILD_COMMIT ${commit}`);
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `app_version=${version}\n`);
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { configureForkRelease } = require("./configure-fork-release.cjs");

test("configures the CLI index and both installers together, refusing an unknown source", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "t3-fork-release-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = ["packages/shared/src/cliRelease.ts", "scripts/install.sh", "scripts/install.ps1"];
  for (const relative of paths) {
    const dest = path.join(root, relative);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.resolve(__dirname, "../..", relative), dest);
  }
  const broken = path.join(root, paths[2]);
  const original = fs.readFileSync(broken, "utf8");
  fs.writeFileSync(broken, original.replace('"pingdotgg/t3code"', '"other/source"'));
  assert.throws(() => configureForkRelease(root, "Karl-VonRichter/t3code"));
  assert.match(fs.readFileSync(path.join(root, paths[0]), "utf8"), /"pingdotgg\/t3code"/);
  fs.writeFileSync(broken, original);
  assert.throws(() => configureForkRelease(root, "owner/repo;command"));
  configureForkRelease(root, "Karl-VonRichter/t3code");
  configureForkRelease(root, "Karl-VonRichter/t3code");
  for (const relative of paths) {
    const content = fs.readFileSync(path.join(root, relative), "utf8");
    assert.ok(content.includes('"Karl-VonRichter/t3code"'));
    assert.ok(!content.includes('"pingdotgg/t3code"'));
  }
});

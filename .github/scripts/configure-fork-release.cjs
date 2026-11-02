const fs = require("node:fs");
const path = require("node:path");

function configureForkRelease(root, repository) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) {
    throw new Error("Expected an owner/repository update source.");
  }
  const files = [
    ["packages/shared/src/cliRelease.ts", "const CLI_RELEASE_REPOSITORY = "],
    ["scripts/install.sh", "repo="],
    ["scripts/install.ps1", "$repo = "],
  ];
  const edits = files.map(([relative, prefix]) => {
    const file = path.join(root, relative);
    const original = fs.readFileSync(file, "utf8");
    const expected = `${prefix}"pingdotgg/t3code"`;
    const selected = `${prefix}${JSON.stringify(repository)}`;
    if (original.includes(selected)) return [file, original];
    if (original.split(expected).length !== 2) {
      throw new Error(`Cannot identify the release repository in ${relative}.`);
    }
    return [file, original.replace(expected, selected)];
  });
  for (const [file, content] of edits) fs.writeFileSync(file, content);
}

if (require.main === module)
  configureForkRelease(path.resolve(__dirname, "../.."), process.argv[2]);
module.exports = { configureForkRelease };

import { expect, it } from "vite-plus/test";

import { forgejoCommit } from "./forgejoPullRequestJson.ts";

it("preserves the full Forgejo commit message alongside its headline", () => {
  const message =
    "Add history\n\n  Preserve <literal> text.\n\nSigned-off-by: Ada <ada@example.com>\n";
  expect(
    forgejoCommit({
      sha: "abc123",
      commit: { message, committer: { date: "2026-07-01T00:00:00Z" } },
      author: null,
      parents: [],
    }),
  ).toMatchObject({ messageHeadline: "Add history", message });
});

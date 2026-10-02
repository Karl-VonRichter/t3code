import { describe, expect, it } from "vite-plus/test";

import type { ReviewSectionItem, ReviewSectionKind } from "./reviewModel";
import { buildReviewSectionMenu } from "./review-section-menu";

function section(id: string, kind: ReviewSectionKind): ReviewSectionItem {
  return {
    id,
    kind,
    title: id,
    subtitle: null,
    diff: null,
    isLoading: false,
  };
}

describe("buildReviewSectionMenu", () => {
  it("exposes git scopes and the latest turn at the top level", () => {
    const turn28 = section("turn:28", "turn");
    const turn27 = section("turn:27", "turn");
    const workingTree = section("git:working-tree", "working-tree");
    const branchChanges = section("git:branch-range", "branch-range");

    expect(buildReviewSectionMenu([turn28, turn27, workingTree, branchChanges])).toEqual({
      workingTree,
      branchChanges,
      latestTurn: turn28,
      turns: [turn28, turn27],
      repositories: [],
      otherRepositories: [],
    });
  });

  it("keeps unavailable scopes empty while data loads", () => {
    expect(buildReviewSectionMenu([])).toEqual({
      workingTree: null,
      branchChanges: null,
      latestTurn: null,
      turns: [],
      repositories: [],
      otherRepositories: [],
    });
  });

  it("lists repository scopes once and keeps both scopes together for changed members", () => {
    const repositorySection = (
      repositoryId: string,
      kind: "working-tree" | "branch-range",
      changed: boolean,
    ): ReviewSectionItem => {
      const id = `${repositoryId}:${kind}`;
      const files = changed
        ? [{ path: `${repositoryId}/file.txt`, previousPath: null, additions: 1, deletions: 0 }]
        : [];
      return {
        ...section(id, kind),
        files,
        source: {
          id,
          kind,
          title: id,
          repository: { id: repositoryId, path: repositoryId },
          baseRef: null,
          headRef: null,
          diff: "",
          diffHash: id,
          truncated: true,
          files,
        },
      };
    };
    const working = repositorySection("app", "working-tree", true);
    const branch = repositorySection("app", "branch-range", false);
    const clean = repositorySection("vendor", "working-tree", false);
    const menu = buildReviewSectionMenu([working, branch, clean]);
    expect(menu.workingTree).toBeNull();
    expect(menu.branchChanges).toBeNull();
    expect(menu.repositories).toEqual([working, branch]);
    expect(menu.otherRepositories).toEqual([clean]);
  });
});

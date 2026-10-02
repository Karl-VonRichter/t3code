import type { ReviewSectionItem } from "./reviewModel";

export interface ReviewSectionMenu {
  readonly workingTree: ReviewSectionItem | null;
  readonly branchChanges: ReviewSectionItem | null;
  readonly latestTurn: ReviewSectionItem | null;
  readonly turns: ReadonlyArray<ReviewSectionItem>;
  readonly repositories: ReadonlyArray<ReviewSectionItem>;
  readonly otherRepositories: ReadonlyArray<ReviewSectionItem>;
}

export function buildReviewSectionMenu(
  sections: ReadonlyArray<ReviewSectionItem>,
): ReviewSectionMenu {
  const turns = sections.filter((section) => section.kind === "turn");
  const repositories = sections.filter((section) => section.source?.repository);
  const changed = new Set(
    repositories
      .filter((section) => section.files?.length)
      .map((section) => section.source!.repository!.id),
  );
  return {
    workingTree:
      sections.find((section) => section.kind === "working-tree" && !section.source?.repository) ??
      null,
    branchChanges:
      sections.find((section) => section.kind === "branch-range" && !section.source?.repository) ??
      null,
    latestTurn: turns[0] ?? null,
    turns,
    repositories: repositories.filter((section) => changed.has(section.source!.repository!.id)),
    otherRepositories: repositories.filter(
      (section) => !changed.has(section.source!.repository!.id),
    ),
  };
}

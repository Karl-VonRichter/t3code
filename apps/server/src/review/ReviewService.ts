import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  type WorkspaceRepository,
  WorkspaceDiscoveryError,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as RepositoryDiscovery from "../workspace/RepositoryDiscovery.ts";
import * as ReviewWorkspaceRoots from "./ReviewWorkspaceRoots.ts";

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly getDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, ReviewDiffPreviewError>;
  }
>()("t3/review/ReviewService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const discovery = yield* RepositoryDiscovery.RepositoryDiscovery;
  const reviewRoots = yield* ReviewWorkspaceRoots.ReviewWorkspaceRoots;

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.assertWorkspaceBoundCwd.canonicalizePath",
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the review workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  const isWithinRoot = (candidate: string, root: string) => {
    const relative = path.relative(root, candidate);
    return (
      relative === "" ||
      (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
    );
  };

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    operation: "ReviewService.getDiffPreview" | "ReviewService.getDiffFileContents",
    cwd: string,
  ) {
    const [candidate, workspaceRoot, worktreesRoot] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
      canonicalizePath(config.worktreesDir),
    ]);

    if (isWithinRoot(candidate, workspaceRoot) || isWithinRoot(candidate, worktreesRoot)) {
      return;
    }

    const projectRoots = yield* reviewRoots.list();
    for (const root of projectRoots) {
      if (isWithinRoot(candidate, yield* canonicalizePath(root))) return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation,
      cwd,
      detail:
        operation === "ReviewService.getDiffPreview"
          ? "Review diff preview cwd must stay within the configured workspace root."
          : "Review diff file contents cwd must stay within the configured workspace root.",
    });
  });

  const repositoryCwd = Effect.fn("ReviewService.repositoryCwd")(function* (
    root: string,
    repository: WorkspaceRepository,
  ) {
    const cwd = yield* canonicalizePath(path.join(root, repository.path));
    if (!isWithinRoot(cwd, root)) {
      return yield* new WorkspaceDiscoveryError({
        cwd: root,
        detail: `Repository ${repository.path} escapes the workspace.`,
      });
    }
    return cwd;
  });

  const localFilePath = (cwd: string, repository: WorkspaceRepository, filePath: string) => {
    const prefix = repository.path === "." ? "" : `${repository.path}/`;
    const local = filePath.startsWith(prefix) ? filePath.slice(prefix.length) : null;
    if (!local || path.isAbsolute(local) || local.split(/[\\/]/).includes("..")) {
      return Effect.fail(
        new WorkspaceDiscoveryError({
          cwd,
          detail: `File ${filePath} is outside repository ${repository.path}.`,
        }),
      );
    }
    return Effect.succeed(local);
  };

  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffPreview", input.cwd);

    const workspace = yield* discovery.discover(
      input.cwd,
      input.file ? input.repositoryId : undefined,
    );
    if (workspace) {
      yield* assertWorkspaceBoundCwd("ReviewService.getDiffPreview", workspace.root);
      if (
        input.file &&
        input.repositoryId &&
        !workspace.repositories.some((repository) => repository.id === input.repositoryId)
      ) {
        return yield* new WorkspaceDiscoveryError({
          cwd: input.cwd,
          detail: "The selected repository is unavailable. Refresh the workspace.",
        });
      }
      if (input.file && !input.repositoryId) {
        return yield* new WorkspaceDiscoveryError({
          cwd: input.cwd,
          detail: "Select a repository to preview a workspace file.",
        });
      }
      const previews = yield* Effect.forEach(
        workspace.repositories,
        (repository) =>
          Effect.gen(function* () {
            const cwd = yield* repositoryCwd(workspace.root, repository);
            const file = input.file
              ? {
                  ...input.file,
                  path: yield* localFilePath(input.cwd, repository, input.file.path),
                  previousPath: input.file.previousPath
                    ? yield* localFilePath(input.cwd, repository, input.file.previousPath)
                    : null,
                }
              : undefined;
            const baseRef =
              (input.repositoryId === repository.id ? input.baseRef : undefined) ??
              (repository.branch ? undefined : repository.checkoutSha);
            const preview = yield* git.getReviewDiffPreview(
              {
                cwd,
                ...(baseRef ? { baseRef } : {}),
                ...(input.ignoreWhitespace === undefined
                  ? {}
                  : { ignoreWhitespace: input.ignoreWhitespace }),
                ...(file ? { file } : {}),
              },
              {
                ...(repository.path === "." ? {} : { pathPrefix: repository.path }),
                metadataOnly: !input.file,
              },
            );
            return preview.sources.map((source) => ({
              ...source,
              id: `${repository.id}:${source.kind}`,
              title: `${repository.path} · ${source.title}`,
              repository: { id: repository.id, path: repository.path },
              ...(source.files
                ? {
                    files: source.files.map((entry) => ({
                      ...entry,
                      path:
                        repository.path === "." ? entry.path : `${repository.path}/${entry.path}`,
                      previousPath: entry.previousPath
                        ? repository.path === "."
                          ? entry.previousPath
                          : `${repository.path}/${entry.previousPath}`
                        : null,
                    })),
                  }
                : {}),
            }));
          }),
        { concurrency: 4 },
      );
      return {
        cwd: workspace.root,
        workspace,
        generatedAt: yield* DateTime.now,
        sources: previews.flat(),
      };
    }

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    const getDriverDiffPreview = handle.driver.getDiffPreview;
    if (!getDriverDiffPreview) {
      if (handle.kind === "git") {
        return yield* git.getReviewDiffPreview(input);
      }
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffPreview",
        kind: handle.kind,
        detail: `The ${handle.kind} VCS driver does not support review diff previews.`,
      });
    }

    return yield* getDriverDiffPreview(input);
  });

  const getDiffFileContents: ReviewService["Service"]["getDiffFileContents"] = Effect.fn(
    "ReviewService.getDiffFileContents",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffFileContents", input.cwd);

    const workspace = yield* discovery.discover(input.cwd, input.repositoryId);
    if (workspace) {
      yield* assertWorkspaceBoundCwd("ReviewService.getDiffFileContents", workspace.root);
      const repository = workspace.repositories.find((member) => member.id === input.repositoryId);
      if (!repository) {
        return yield* new WorkspaceDiscoveryError({
          cwd: input.cwd,
          detail: "Select an available repository to expand a workspace file.",
        });
      }
      return yield* git.getReviewDiffFileContents({
        ...input,
        cwd: yield* repositoryCwd(workspace.root, repository),
        oldPath: yield* localFilePath(input.cwd, repository, input.oldPath),
        newPath: yield* localFilePath(input.cwd, repository, input.newPath),
      });
    }

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffFileContents",
        kind: handle?.kind ?? "unknown",
        detail: "Unchanged diff expansion currently requires a Git repository.",
      });
    }

    return yield* git.getReviewDiffFileContents(input);
  });

  return ReviewService.of({
    getDiffPreview,
    getDiffFileContents,
  });
});

export const layer = Layer.effect(ReviewService, make);

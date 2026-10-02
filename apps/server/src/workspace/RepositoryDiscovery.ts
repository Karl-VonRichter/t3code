// @effect-diagnostics nodeBuiltinImport:off - FileSystem.readDirectory cannot return dirents without a stat per source file.
import { type RepositoryWorkspace, WorkspaceDiscoveryError } from "@t3tools/contracts";
import * as NodeFSP from "node:fs/promises";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

// Avoid walking metadata, installed dependencies, and generated output on review refreshes.
const excludedDirectories = new Set([
  ".git",
  ".west",
  ".t3",
  ".repos",
  ".venv",
  "node_modules",
  "build",
  "dist",
  "target",
  "coverage",
]);

export class RepositoryDiscovery extends Context.Service<
  RepositoryDiscovery,
  {
    readonly discover: (
      cwd: string,
      repositoryId?: string,
    ) => Effect.Effect<RepositoryWorkspace | null, WorkspaceDiscoveryError>;
    readonly isContainer: (cwd: string) => Effect.Effect<boolean, WorkspaceDiscoveryError>;
  }
>()("t3/workspace/RepositoryDiscovery") {}

const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;

  const listRepositories = Effect.fn("RepositoryDiscovery.listRepositories")(
    function* (root: string) {
      const repositories: string[] = [];
      let directories = [root];
      while (directories.length > 0) {
        const children = yield* Effect.forEach(
          directories,
          (directory) =>
            Effect.gen(function* () {
              const entries = yield* Effect.tryPromise(() =>
                NodeFSP.readdir(directory, { withFileTypes: true }),
              );
              if (
                entries.some(
                  (entry) => entry.name === ".git" && (entry.isFile() || entry.isDirectory()),
                )
              )
                repositories.push(directory);
              // Dirents avoid a stat per source file and exclude symlinks, including loops and outside links.
              return entries
                .filter((entry) => entry.isDirectory() && !excludedDirectories.has(entry.name))
                .map((entry) => path.join(directory, entry.name));
            }),
          { concurrency: 4 },
        );
        directories = children.flat();
      }
      return repositories.toSorted();
    },
    (effect, root) =>
      effect.pipe(
        Effect.mapError(
          (cause) =>
            new WorkspaceDiscoveryError({
              cwd: root,
              detail: "Cannot inspect repositories in the project folder.",
              cause,
            }),
        ),
      ),
  );

  const cache = yield* Cache.make({
    capacity: 128,
    timeToLive: "5 seconds",
    lookup: listRepositories,
  });
  const resolveRoot = (cwd: string) =>
    fs.realPath(path.resolve(cwd)).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        cause.reason._tag === "NotFound" ? Effect.succeed(null) : Effect.fail(cause),
      ),
      Effect.mapError(
        (cause) =>
          new WorkspaceDiscoveryError({
            cwd,
            detail: "Cannot inspect the project folder.",
            cause,
          }),
      ),
    );
  const isContainer = Effect.fn("RepositoryDiscovery.isContainer")(function* (cwd: string) {
    // An ordinary Git checkout keeps its existing Git controls, including nested submodules.
    const skipDiscovery = yield* Effect.gen(function* () {
      if (!(yield* fs.exists(cwd))) return true;
      return yield* fs.exists(path.join(cwd, ".git"));
    }).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceDiscoveryError({
            cwd,
            detail: "Cannot inspect the project folder.",
            cause,
          }),
      ),
    );
    if (skipDiscovery) return false;
    const root = yield* resolveRoot(cwd);
    if (root === null) return false;
    return (yield* Cache.get(cache, root)).length > 0;
  });
  const discover = Effect.fn("RepositoryDiscovery.discover")(function* (
    cwd: string,
    repositoryId?: string,
  ) {
    const root = yield* resolveRoot(cwd);
    if (root === null) return null;
    const roots = yield* Cache.get(cache, root);
    // Preserve the existing single-repository review path.
    if (roots.length === 0 || (roots.length === 1 && roots[0] === root)) return null;
    const members = roots.map((repositoryRoot) => ({
      repositoryRoot,
      relative: path.relative(root, repositoryRoot).split(path.sep).join("/") || ".",
    }));
    // Lazy file requests need only their member; overview requests read all current branches and SHAs.
    const repositories = yield* Effect.forEach(
      members.filter((member) => repositoryId === undefined || member.relative === repositoryId),
      ({ repositoryRoot, relative }) =>
        Effect.gen(function* () {
          const run = (args: string[]) =>
            git.execute({
              cwd: repositoryRoot,
              args,
              operation: "RepositoryDiscovery.discover",
              allowNonZeroExit: true,
            });
          const topLevel = yield* run(["rev-parse", "--show-toplevel"]);
          if (
            topLevel.exitCode !== 0 ||
            (yield* fs.realPath(topLevel.stdout.trim())) !== repositoryRoot
          ) {
            return yield* new WorkspaceDiscoveryError({
              cwd,
              detail: `Invalid Git repository at ${repositoryRoot}.`,
            });
          }
          const [head, branch] = yield* Effect.all(
            [
              run(["rev-parse", "--verify", "HEAD"]),
              run(["symbolic-ref", "--quiet", "--short", "HEAD"]),
            ],
            { concurrency: 2 },
          );
          return {
            id: relative,
            path: relative,
            checkoutSha: head.exitCode === 0 ? head.stdout.trim() : null,
            branch: branch.exitCode === 0 ? branch.stdout.trim() : null,
          };
        }),
      { concurrency: 4 },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new WorkspaceDiscoveryError({
            cwd,
            detail: "Cannot read repository branches and checkout commits.",
            cause,
          }),
      ),
    );
    return { kind: "directory" as const, root, repositories };
  });
  return RepositoryDiscovery.of({ discover, isContainer });
});

export const layer = Layer.effect(RepositoryDiscovery, make);

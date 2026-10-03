import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  CheckpointScopeId,
  NodeId,
  ProviderThreadId,
  RunId,
  ThreadId,
  type OrchestrationV2CheckpointScope,
} from "@t3tools/contracts";
import { parsePatch } from "diff";
import { unquoteGitPatchPath } from "@t3tools/shared/gitPatchPath";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as RepositoryDiscovery from "../workspace/RepositoryDiscovery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import * as WorkspaceCheckpointStore from "./WorkspaceCheckpointStore.ts";
import { parseTurnDiffFilesFromNumstat } from "./Diffs.ts";
import { checkpointRefForScopeOrdinal } from "../orchestration-v2/CheckpointService.ts";
import * as CheckpointService from "../orchestration-v2/CheckpointService.ts";
import * as IdAllocator from "../orchestration-v2/IdAllocator.ts";
import * as CheckpointDiffQuery from "./CheckpointDiffQuery.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as VcsProjectConfig from "../vcs/VcsProjectConfig.ts";

const TestLayer = WorkspaceCheckpointStore.layer.pipe(
  Layer.provideMerge(RepositoryDiscovery.layer.pipe(Layer.provide(GitVcsDriver.layer))),
  Layer.provideMerge(
    CheckpointStore.layer.pipe(
      Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer))),
    ),
  ),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-workspace-checkpoints-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const process = yield* VcsProcess.VcsProcess;
    return (yield* process.run({
      operation: "workspace-checkpoint-test",
      command: "git",
      cwd,
      args,
    })).stdout;
  });

const createRepository = Effect.fnUntraced(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.makeDirectory(cwd, { recursive: true });
  yield* git(cwd, ["init", "--initial-branch=main"]);
  yield* git(cwd, ["config", "user.name", "Checkpoint Test"]);
  yield* git(cwd, ["config", "user.email", "checkpoint@example.test"]);
  yield* git(cwd, ["config", "commit.gpgsign", "false"]);
  yield* fs.writeFileString(path.join(cwd, "file.txt"), "baseline\n");
  yield* git(cwd, ["add", "."]);
  yield* git(cwd, ["commit", "-m", "baseline"]);
});

const fixture = Effect.fnUntraced(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "workspace-checkpoint-fixture-" });
  const sdk = path.join(cwd, "sdk");
  const library = path.join(cwd, "deps", "library");
  yield* createRepository(sdk);
  yield* createRepository(library);
  const store = yield* WorkspaceCheckpointStore.WorkspaceCheckpointStore;
  const ref = (count: number) =>
    checkpointRefForScopeOrdinal({
      scopeId: CheckpointScopeId.make("workspace-test"),
      ordinalWithinScope: count,
    });
  const capture = (count: number) =>
    store.captureCheckpoint({
      cwd,
      checkpointRef: ref(count),
      ...(count > 0 ? { previousCheckpointRef: ref(count - 1) } : {}),
    });
  const diff = (from: number, to: number, format?: "numstat") =>
    store.diffCheckpoints({
      cwd,
      fromCheckpointRef: ref(from),
      toCheckpointRef: ref(to),
      ignoreWhitespace: false,
      ...(format ? { format } : {}),
    });
  return { fs, path, cwd, sdk, library, store, ref, capture, diff };
});

it.layer(TestLayer)("Repository-folder checkpoints", (it) => {
  it.effect("captures repository-folder changes through the V2 checkpoint service", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const scope: OrchestrationV2CheckpointScope = {
        id: CheckpointScopeId.make("scope:workspace-capture"),
        threadId: ThreadId.make("thread:workspace-capture"),
        runId: RunId.make("run:workspace-capture"),
        nodeId: NodeId.make("node:workspace-capture"),
        providerThreadId: ProviderThreadId.make("provider-thread:workspace-capture"),
        parentScopeId: null,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: f.cwd,
        createdAt: DateTime.makeUnsafe("2026-10-03T00:00:00.000Z"),
      };
      yield* Effect.gen(function* () {
        const checkpoints = yield* CheckpointService.CheckpointServiceV2;
        yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });
        yield* f.fs.writeFileString(f.path.join(f.sdk, "file.txt"), "V2 folder change\n");
        // Repeating the baseline must keep the original repository snapshots.
        yield* checkpoints.captureBaseline({ scope, ordinalWithinScope: 0 });
        const checkpoint = yield* checkpoints.capture({
          scope,
          runId: RunId.make("run:workspace-capture"),
          nodeId: NodeId.make("node:workspace-capture"),
          ordinalWithinScope: 1,
          appRunOrdinal: 1,
          capturedAt: scope.createdAt,
        });
        expect(checkpoint.status).toBe("ready");
        expect(checkpoint.files).toEqual([
          { path: "sdk/file.txt", kind: "modified", additions: 1, deletions: 1 },
        ]);
      }).pipe(Effect.provide(CheckpointService.layer.pipe(Layer.provide(IdAllocator.layer))));
    }),
  );

  it.effect(
    "serves repository-folder turn and full-thread diffs through the orchestration query",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.capture(0);
        yield* f.fs.writeFileString(f.path.join(f.sdk, "file.txt"), "turn one\n");
        yield* f.capture(1);
        yield* f.fs.writeFileString(f.path.join(f.library, "file.txt"), "turn two\n");
        yield* f.capture(2);
        const threadId = ThreadId.make("workspace-test");
        const scopeId = CheckpointScopeId.make("workspace-test");
        const query = yield* CheckpointDiffQuery.CheckpointDiffQuery.pipe(
          Effect.provide(
            CheckpointDiffQuery.layer.pipe(
              Layer.provide(
                Layer.mock(ThreadManagement.ThreadManagementService)({
                  getCheckpointContext: () =>
                    Effect.succeed({
                      runs: [1, 2].map((count) => ({
                        id: RunId.make(`run-${count}`),
                        ordinal: count,
                        status: "completed" as const,
                      })),
                      checkpointScopes: [
                        {
                          id: scopeId,
                          runId: RunId.make("run-1"),
                          kind: "root_run" as const,
                          cwd: f.cwd,
                        },
                      ],
                      checkpoints: [1, 2].map((count) => ({
                        scopeId,
                        runId: RunId.make(`run-${count}`),
                        appRunOrdinal: count,
                        ref: f.ref(count),
                        status: "ready" as const,
                      })),
                    }),
                }),
              ),
            ),
          ),
        );
        expect(
          (yield* query.getTurnDiff({
            threadId,
            fromTurnCount: 1,
            toTurnCount: 2,
            ignoreWhitespace: false,
          })).diff,
        ).toBe(yield* f.diff(1, 2));
        expect(
          (yield* query.getFullThreadDiff({ threadId, toTurnCount: 2, ignoreWhitespace: false }))
            .diff,
        ).toBe(yield* f.diff(0, 2));
      }),
  );

  it.effect(
    "captures nested repositories and separates matching filenames across turn ranges",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        expect(yield* f.store.isCheckpointWorkspace(f.cwd)).toBe(true);
        yield* f.capture(0);
        yield* f.fs.writeFileString(f.path.join(f.sdk, "file.txt"), "sdk first\n");
        yield* f.fs.writeFileString(f.path.join(f.library, "file.txt"), "library first\n");
        const index = yield* f.fs.readFile(f.path.join(f.sdk, ".git", "index"));
        yield* f.capture(1);
        expect(parseTurnDiffFilesFromNumstat(yield* f.diff(0, 1, "numstat"))).toEqual([
          { path: "deps/library/file.txt", additions: 1, deletions: 1 },
          { path: "sdk/file.txt", additions: 1, deletions: 1 },
        ]);
        const parsed = parsePatch(yield* f.diff(0, 1));
        expect(
          parsed.map((file) => unquoteGitPatchPath(file.newFileName ?? "").replace(/^b\//, "")),
        ).toEqual(["deps/library/file.txt", "sdk/file.txt"]);
        expect(parsed[0]?.hunks.flatMap((hunk) => hunk.lines).join("\n")).toContain(
          "library first",
        );
        expect(parsed[1]?.hunks.flatMap((hunk) => hunk.lines).join("\n")).toContain("sdk first");
        yield* f.fs.writeFileString(f.path.join(f.sdk, "file.txt"), "sdk second\n");
        yield* f.capture(2);
        expect(parseTurnDiffFilesFromNumstat(yield* f.diff(1, 2, "numstat"))).toEqual([
          { path: "sdk/file.txt", additions: 1, deletions: 1 },
        ]);
        expect(yield* f.diff(0, 2)).toContain("-baseline\n+sdk second");
        expect(yield* f.fs.readFile(f.path.join(f.sdk, ".git", "index"))).toEqual(index);
        // Later working changes must not leak into the completed turn's diff.
        yield* f.fs.writeFileString(f.path.join(f.library, "file.txt"), "after snapshot\n");
        expect(yield* f.diff(0, 1)).not.toContain("after snapshot");
      }),
  );

  it.effect("uses independent checkpoint refs for worktrees sharing one Git database", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const worktree = f.path.join(f.cwd, "sdk-linked");
      yield* git(f.sdk, ["worktree", "add", "-b", "linked", worktree]);
      yield* f.capture(0);
      yield* f.fs.writeFileString(f.path.join(f.sdk, "file.txt"), "main change\n");
      yield* f.fs.writeFileString(f.path.join(worktree, "file.txt"), "linked change\n");
      yield* f.capture(1);
      const parsed = parsePatch(yield* f.diff(0, 1));
      expect(
        parsed.map((file) => [
          unquoteGitPatchPath(file.newFileName ?? "").replace(/^b\//, ""),
          file.hunks
            .flatMap((hunk) => hunk.lines)
            .filter((line) => line.startsWith("+"))
            .join("\n"),
        ]),
      ).toEqual([
        ["sdk/file.txt", "+main change"],
        ["sdk-linked/file.txt", "+linked change"],
      ]);
    }),
  );

  it.effect("preserves quoted rename paths in patches and summaries", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const oldName = "old café.txt";
      const newName = "new café.txt";
      yield* f.fs.writeFileString(f.path.join(f.sdk, oldName), "one\ntwo\nthree\nfour\n");
      yield* f.capture(0);
      yield* f.fs.rename(f.path.join(f.sdk, oldName), f.path.join(f.sdk, newName));
      yield* f.capture(1);
      const patch = yield* f.diff(0, 1);
      expect(patch).toContain("rename from sdk/old café.txt");
      expect(patch).toContain("rename to sdk/new café.txt");
      expect(parseTurnDiffFilesFromNumstat(yield* f.diff(0, 1, "numstat"))).toEqual([
        { path: `sdk/${newName}`, additions: 0, deletions: 0 },
      ]);
    }),
  );

  it.effect(
    "extends a pre-turn baseline for new repositories without changing existing snapshots",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.capture(0);
        yield* f.fs.writeFileString(f.path.join(f.sdk, "file.txt"), "first turn\n");
        yield* f.capture(1);
        const newRepo = f.path.join(f.cwd, "new-repo");
        yield* createRepository(newRepo);
        yield* f.fs.writeFileString(f.path.join(f.sdk, "file.txt"), "between turns\n");
        yield* f.store.captureCheckpoint({
          cwd: f.cwd,
          checkpointRef: f.ref(1),
          preserveExisting: true,
        });
        expect(yield* f.diff(0, 1)).toContain("-baseline\n+first turn");
        expect(yield* f.diff(0, 1)).not.toContain("between turns");
        yield* f.fs.writeFileString(f.path.join(newRepo, "file.txt"), "new repository turn\n");
        yield* f.capture(2);
        expect(yield* f.diff(1, 2)).toContain("-baseline\n+new repository turn");
        expect(yield* f.diff(0, 2)).toContain("-baseline\n+new repository turn");
      }),
  );

  it.effect(
    "starts new repositories at their first snapshot without inventing earlier changes",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.capture(0);
        const newRepo = f.path.join(f.cwd, "new-repo");
        yield* createRepository(newRepo);
        yield* f.fs.writeFileString(f.path.join(newRepo, "file.txt"), "created during turn\n");
        yield* f.capture(1);
        expect(yield* f.diff(0, 1)).toBe("");
        yield* f.fs.writeFileString(f.path.join(newRepo, "file.txt"), "next turn\n");
        yield* f.capture(2);
        expect(yield* f.diff(1, 2)).toContain("diff --git a/new-repo/file.txt b/new-repo/file.txt");
        expect(yield* f.diff(1, 2)).toContain("-created during turn\n+next turn");
        expect(yield* f.diff(0, 2)).toContain("-created during turn\n+next turn");
      }),
  );

  it.effect("bounds the combined patch in bytes while preserving complete file summaries", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.capture(0);
      for (const cwd of [f.sdk, f.library]) {
        yield* f.fs.writeFileString(f.path.join(cwd, "file.txt"), `${"é".repeat(3_000_000)}\n`);
      }
      yield* f.capture(1);
      expect((yield* Effect.flip(f.diff(0, 1))).message).toContain("10 MB output limit");
      expect(parseTurnDiffFilesFromNumstat(yield* f.diff(0, 1, "numstat"))).toEqual([
        { path: "deps/library/file.txt", additions: 1, deletions: 1 },
        { path: "sdk/file.txt", additions: 1, deletions: 1 },
      ]);
    }),
  );

  it.effect("reports unavailable members and baselines instead of an empty or HEAD diff", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.capture(0);
      yield* f.capture(1);
      expect((yield* Effect.flip(f.diff(9, 1)))._tag).toBe("WorkspaceCheckpointError");
      yield* f.fs.remove(f.library, { recursive: true });
      const error = yield* Effect.flip(f.diff(0, 1));
      expect(error.message).toContain("deps/library");
      yield* f.capture(2);
      expect((yield* Effect.flip(f.diff(1, 2))).message).toContain("deps/library");
    }),
  );

  it.effect(
    "retains snapshots across service restarts and cleans only the requested turn refs",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* f.capture(0);
        yield* f.fs.writeFileString(f.path.join(f.sdk, "file.txt"), "snapshot\n");
        yield* f.capture(1);
        const restarted = yield* WorkspaceCheckpointStore.WorkspaceCheckpointStore.pipe(
          Effect.provide(WorkspaceCheckpointStore.layer),
        );
        expect(yield* restarted.hasCheckpointRef({ cwd: f.cwd, checkpointRef: f.ref(1) })).toBe(
          true,
        );
        expect(
          yield* restarted.diffCheckpoints({
            cwd: f.cwd,
            fromCheckpointRef: f.ref(0),
            toCheckpointRef: f.ref(1),
            ignoreWhitespace: false,
          }),
        ).toContain("+snapshot");
        const restoreError = yield* Effect.flip(
          restarted.restoreCheckpoint({ cwd: f.cwd, checkpointRef: f.ref(0) }),
        );
        expect(restoreError._tag).toBe("VcsUnsupportedOperationError");
        expect(yield* f.fs.readFileString(f.path.join(f.sdk, "file.txt"))).toBe("snapshot\n");
        yield* restarted.deleteCheckpointRefs({ cwd: f.cwd, checkpointRefs: [f.ref(1)] });
        expect(yield* restarted.hasCheckpointRef({ cwd: f.cwd, checkpointRef: f.ref(1) })).toBe(
          false,
        );
        expect(yield* restarted.hasCheckpointRef({ cwd: f.cwd, checkpointRef: f.ref(0) })).toBe(
          true,
        );
        expect(
          yield* git(f.sdk, ["for-each-ref", "--format=%(refname)", "refs/t3/"]),
        ).not.toContain(`${f.ref(1)}-`);
      }),
  );

  it.effect("keeps single-repository checkpoint refs and paths unchanged", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.store.captureCheckpoint({ cwd: f.sdk, checkpointRef: f.ref(0) });
      yield* f.fs.writeFileString(f.path.join(f.sdk, "file.txt"), "single repo\n");
      yield* f.store.captureCheckpoint({ cwd: f.sdk, checkpointRef: f.ref(1) });
      expect(yield* git(f.sdk, ["show", `${f.ref(1)}:file.txt`])).toBe("single repo\n");
      expect(
        yield* f.store.diffCheckpoints({
          cwd: f.sdk,
          fromCheckpointRef: f.ref(0),
          toCheckpointRef: f.ref(1),
          ignoreWhitespace: false,
        }),
      ).toContain("diff --git a/file.txt b/file.txt");
    }),
  );

  it.effect("preserves Git-root baseline and restore behavior with nested repositories", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.store.captureCheckpoint({ cwd: f.sdk, checkpointRef: f.ref(0) });
      const nested = f.path.join(f.sdk, "nested");
      yield* createRepository(nested);
      yield* f.fs.writeFileString(f.path.join(f.sdk, "file.txt"), "root first\n");
      yield* f.store.captureCheckpoint({
        cwd: f.sdk,
        checkpointRef: f.ref(0),
        preserveExisting: true,
      });
      yield* f.store.captureCheckpoint({
        cwd: f.sdk,
        checkpointRef: f.ref(1),
        previousCheckpointRef: f.ref(0),
      });
      const diff = (from: number, to: number) =>
        f.store.diffCheckpoints({
          cwd: f.sdk,
          fromCheckpointRef: f.ref(from),
          toCheckpointRef: f.ref(to),
          ignoreWhitespace: false,
        });
      expect(yield* diff(0, 1)).toContain("-baseline\n+root first");
      expect(yield* f.store.restoreCheckpoint({ cwd: f.sdk, checkpointRef: f.ref(0) })).toBe(true);
      expect(yield* f.fs.readFileString(f.path.join(f.sdk, "file.txt"))).toBe("baseline\n");
      expect(yield* f.fs.readFileString(f.path.join(nested, "file.txt"))).toBe("baseline\n");
    }),
  );
});

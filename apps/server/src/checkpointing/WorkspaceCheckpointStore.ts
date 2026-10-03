import { CheckpointRef, VcsUnsupportedOperationError } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as RepositoryDiscovery from "../workspace/RepositoryDiscovery.ts";
import * as CheckpointStore from "./CheckpointStore.ts";
import { WorkspaceCheckpointError, type CheckpointStoreError } from "./Errors.ts";

const WorkspaceSnapshot = Schema.Array(
  Schema.Struct({
    path: Schema.String,
    checkpointRef: CheckpointRef,
    baselineCheckpointRef: CheckpointRef,
  }),
);
type WorkspaceSnapshot = typeof WorkspaceSnapshot.Type;
const SnapshotJson = Schema.fromJsonString(WorkspaceSnapshot);
const decodeSnapshot = Schema.decodeEffect(SnapshotJson);
const encodeSnapshot = Schema.encodeEffect(SnapshotJson);
type WorkspaceStoreError = CheckpointStoreError | WorkspaceCheckpointError;

/** Captures folder members without changing the single-repository checkpoint adapter. */
export class WorkspaceCheckpointStore extends Context.Service<
  WorkspaceCheckpointStore,
  {
    readonly isCheckpointWorkspace: (cwd: string) => Effect.Effect<boolean, WorkspaceStoreError>;
    readonly captureCheckpoint: (
      input: CheckpointStore.CaptureCheckpointInput & {
        readonly previousCheckpointRef?: CheckpointRef;
        readonly preserveExisting?: boolean;
      },
    ) => Effect.Effect<void, WorkspaceStoreError>;
    readonly hasCheckpointRef: (
      input: Omit<CheckpointStore.RestoreCheckpointInput, "fallbackToHead">,
    ) => Effect.Effect<boolean, WorkspaceStoreError>;
    readonly diffCheckpoints: (
      input: CheckpointStore.DiffCheckpointsInput,
    ) => Effect.Effect<string, WorkspaceStoreError>;
    readonly restoreCheckpoint: (
      input: CheckpointStore.RestoreCheckpointInput,
    ) => Effect.Effect<boolean, WorkspaceStoreError>;
    readonly deleteCheckpointRefs: (
      input: CheckpointStore.DeleteCheckpointRefsInput,
    ) => Effect.Effect<void, WorkspaceStoreError>;
  }
>()("t3/checkpointing/WorkspaceCheckpointStore") {}

const make = Effect.gen(function* () {
  const store = yield* CheckpointStore.CheckpointStore;
  const discovery = yield* RepositoryDiscovery.RepositoryDiscovery;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const config = yield* ServerConfig.ServerConfig;
  const directory = path.join(config.stateDir, "workspace-checkpoints");
  const hash = (value: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(value)).pipe(Effect.map(Hex.encode));
  const memberCwd = (cwd: string, member: WorkspaceSnapshot[number]) => path.join(cwd, member.path);

  const readSnapshot = Effect.fn("WorkspaceCheckpointStore.readSnapshot")(function* (
    cwd: string,
    checkpointRef: CheckpointRef,
  ) {
    const root = yield* fs.realPath(cwd);
    const key = yield* hash(`${root}\0${checkpointRef}`);
    const file = path.join(directory, `${key}.json`);
    const contents = yield* fs
      .readFileString(file)
      .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(null)));
    const snapshot = contents === null ? null : yield* decodeSnapshot(contents);
    return { root, file, snapshot };
  });

  const protect = <A, E, R>(operation: string, cwd: string, effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) => new WorkspaceCheckpointError({ operation, cwd, cause })),
    );

  const isCheckpointWorkspace: WorkspaceCheckpointStore["Service"]["isCheckpointWorkspace"] = (
    cwd,
  ) =>
    Effect.gen(function* () {
      return (yield* store.isGitRepository(cwd)) || (yield* discovery.isContainer(cwd));
    }).pipe((effect) => protect("detect", cwd, effect));

  const captureCheckpoint: WorkspaceCheckpointStore["Service"]["captureCheckpoint"] = Effect.fn(
    "WorkspaceCheckpointStore.captureCheckpoint",
  )(function* (input) {
    if (yield* store.isGitRepository(input.cwd)) {
      if (input.preserveExisting && (yield* store.hasCheckpointRef(input))) return;
      return yield* store.captureCheckpoint(input);
    }
    const { root, file, snapshot } = yield* protect(
      "read snapshot",
      input.cwd,
      readSnapshot(input.cwd, input.checkpointRef),
    );
    const workspace = yield* protect(
      "discover",
      root,
      discovery.discover(root, undefined, { fresh: true }),
    );
    if (!workspace || workspace.repositories.length === 0) {
      return yield* new WorkspaceCheckpointError({
        operation: "capture",
        cwd: root,
        detail: "No repositories are available in the project folder.",
      });
    }
    const previous = input.previousCheckpointRef
      ? (yield* protect(
          "read previous snapshot",
          root,
          readSnapshot(root, input.previousCheckpointRef),
        )).snapshot
      : null;
    // Keep existing snapshots immutable when a missing member is added to a baseline.
    const added = yield* Effect.forEach(
      workspace.repositories.filter(
        (repository) => !snapshot?.some((member) => member.path === repository.path),
      ),
      (repository) =>
        Effect.gen(function* () {
          // Worktrees can share a Git ref database. Each folder member needs its own ref.
          const suffix = yield* protect("name snapshot", root, hash(`${root}\0${repository.path}`));
          const checkpointRef = CheckpointRef.make(`${input.checkpointRef}-${suffix}`);
          const member = {
            path: repository.path,
            checkpointRef,
            baselineCheckpointRef:
              previous?.find((entry) => entry.path === repository.path)?.baselineCheckpointRef ??
              checkpointRef,
          };
          yield* store.captureCheckpoint({ cwd: memberCwd(root, member), checkpointRef });
          return member;
        }),
      { concurrency: 4 },
    );
    if (snapshot !== null && added.length === 0) return;
    const members = [...(snapshot ?? []), ...added];
    // A manifest is published only after every member has a durable Git snapshot.
    yield* protect(
      "save snapshot",
      root,
      Effect.gen(function* () {
        yield* fs.makeDirectory(directory, { recursive: true });
        const id = yield* crypto.randomUUIDv4;
        const temporary = `${file}.${id}.tmp`;
        const contents = yield* encodeSnapshot(members);
        yield* fs
          .writeFileString(temporary, contents)
          .pipe(
            Effect.andThen(fs.rename(temporary, file)),
            Effect.ensuring(fs.remove(temporary, { force: true }).pipe(Effect.ignore)),
          );
      }),
    );
  });

  const hasCheckpointRef: WorkspaceCheckpointStore["Service"]["hasCheckpointRef"] = Effect.fn(
    "WorkspaceCheckpointStore.hasCheckpointRef",
  )(function* (input) {
    const { root, snapshot } = yield* protect(
      "read snapshot",
      input.cwd,
      readSnapshot(input.cwd, input.checkpointRef),
    );
    if (snapshot === null) {
      return (yield* store.isGitRepository(root)) ? yield* store.hasCheckpointRef(input) : false;
    }
    for (const member of snapshot) {
      if (!(yield* protect("check repository", root, fs.exists(memberCwd(root, member)))))
        return false;
      if (
        !(yield* store.hasCheckpointRef({
          cwd: memberCwd(root, member),
          checkpointRef: member.checkpointRef,
        }))
      )
        return false;
    }
    return snapshot.length > 0;
  });

  const diffCheckpoints: WorkspaceCheckpointStore["Service"]["diffCheckpoints"] = Effect.fn(
    "WorkspaceCheckpointStore.diffCheckpoints",
  )(function* (input) {
    const from = yield* protect(
      "read baseline",
      input.cwd,
      readSnapshot(input.cwd, input.fromCheckpointRef),
    );
    const to = yield* protect(
      "read snapshot",
      input.cwd,
      readSnapshot(input.cwd, input.toCheckpointRef),
    );
    if (from.snapshot === null && to.snapshot === null) return yield* store.diffCheckpoints(input);
    if (from.snapshot === null || to.snapshot === null) {
      return yield* new WorkspaceCheckpointError({
        operation: "diff",
        cwd: input.cwd,
        detail: "The repository-folder checkpoint baseline or target is unavailable.",
      });
    }
    for (const member of from.snapshot) {
      if (!to.snapshot.some((target) => target.path === member.path)) {
        return yield* new WorkspaceCheckpointError({
          operation: "diff",
          cwd: input.cwd,
          detail: `Repository '${member.path}' is unavailable at the target checkpoint.`,
        });
      }
    }
    let outputBytes = 0;
    const encoder = new TextEncoder();
    const diffs = yield* Effect.forEach(
      to.snapshot,
      (member) =>
        Effect.gen(function* () {
          const baseline = from.snapshot?.find((entry) => entry.path === member.path);
          // For repositories added after the range starts, compare from their first snapshot.
          const fromCheckpointRef = baseline?.checkpointRef ?? member.baselineCheckpointRef;
          const cwd = memberCwd(to.root, member);
          if (!(yield* protect("check repository", input.cwd, fs.exists(cwd)))) {
            return yield* new WorkspaceCheckpointError({
              operation: "diff",
              cwd: input.cwd,
              detail: `Repository '${member.path}' is no longer available.`,
            });
          }
          const diff = yield* store.diffCheckpoints({
            ...input,
            cwd,
            fromCheckpointRef,
            toCheckpointRef: member.checkpointRef,
            fallbackFromToHead: false,
            pathPrefix: member.path === "." ? "" : `${member.path}/`,
          });
          // Enforce the existing Git diff budget across the whole folder, while workers
          // are running, so neither retained patches nor the websocket response scale per repo.
          outputBytes += encoder.encode(diff).byteLength;
          if (outputBytes > 10_000_000) {
            return yield* new WorkspaceCheckpointError({
              operation: "diff",
              cwd: input.cwd,
              detail: "The combined repository diff exceeds the 10 MB output limit.",
            });
          }
          return diff;
        }),
      { concurrency: 4 },
    );
    return diffs.join("");
  });

  const restoreCheckpoint: WorkspaceCheckpointStore["Service"]["restoreCheckpoint"] = Effect.fn(
    "WorkspaceCheckpointStore.restoreCheckpoint",
  )(function* (input) {
    const { snapshot } = yield* protect(
      "read snapshot",
      input.cwd,
      readSnapshot(input.cwd, input.checkpointRef),
    );
    if (
      snapshot !== null ||
      (yield* protect("discover", input.cwd, discovery.isContainer(input.cwd)))
    ) {
      return yield* new VcsUnsupportedOperationError({
        operation: "WorkspaceCheckpointStore.restoreCheckpoint",
        kind: "git",
        detail:
          "File restore across repository folders is unavailable. Rewind the conversation without restoring files instead.",
      });
    }
    return yield* store.restoreCheckpoint(input);
  });

  const deleteCheckpointRefs: WorkspaceCheckpointStore["Service"]["deleteCheckpointRefs"] =
    Effect.fn("WorkspaceCheckpointStore.deleteCheckpointRefs")(function* (input) {
      for (const checkpointRef of input.checkpointRefs) {
        const { root, file, snapshot } = yield* protect(
          "read snapshot",
          input.cwd,
          readSnapshot(input.cwd, checkpointRef),
        );
        if (snapshot === null) {
          if (yield* store.isGitRepository(root))
            yield* store.deleteCheckpointRefs({ ...input, checkpointRefs: [checkpointRef] });
          continue;
        }
        for (const member of snapshot) {
          const cwd = memberCwd(root, member);
          if (yield* protect("check repository", input.cwd, fs.exists(cwd))) {
            yield* store.deleteCheckpointRefs({ cwd, checkpointRefs: [member.checkpointRef] });
          }
        }
        yield* protect("delete snapshot", input.cwd, fs.remove(file));
      }
    });

  return WorkspaceCheckpointStore.of({
    isCheckpointWorkspace,
    captureCheckpoint,
    hasCheckpointRef,
    diffCheckpoints,
    restoreCheckpoint,
    deleteCheckpointRefs,
  });
});

export const layer = Layer.effect(WorkspaceCheckpointStore, make);

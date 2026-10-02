import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as VcsDriver from "./VcsDriver.ts";
import * as RepositoryDiscovery from "../workspace/RepositoryDiscovery.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";
import * as VcsProvisioningService from "./VcsProvisioningService.ts";

const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");

function makeDriver(calls: string[]): VcsDriver.VcsDriver["Service"] {
  return {
    capabilities: {
      kind: "git",
      supportsWorktrees: true,
      supportsBookmarks: false,
      supportsAtomicSnapshot: false,
      supportsPushDefaultRemote: true,
      ignoreClassifier: "native",
    },
    execute: () =>
      Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
      }),
    detectRepository: () => Effect.succeed(null),
    isInsideWorkTree: () => Effect.succeed(false),
    listWorkspaceFiles: () =>
      Effect.succeed({
        paths: [],
        truncated: false,
        freshness: {
          source: "live-local",
          observedAt: TEST_EPOCH,
          expiresAt: Option.none(),
        },
      }),
    listRemotes: () =>
      Effect.succeed({
        remotes: [],
        freshness: {
          source: "live-local",
          observedAt: TEST_EPOCH,
          expiresAt: Option.none(),
        },
      }),
    filterIgnoredPaths: (_cwd, relativePaths) => Effect.succeed(relativePaths),
    initRepository: (input) =>
      Effect.sync(() => {
        calls.push(`${input.kind ?? "default"}:${input.cwd}`);
      }),
  };
}

it.effect("routes repository initialization through an explicit VCS driver kind", () => {
  const calls: string[] = [];
  const driver = makeDriver(calls);
  const testLayer = VcsProvisioningService.layer.pipe(
    Layer.provide(
      Layer.mock(RepositoryDiscovery.RepositoryDiscovery)({
        isContainer: () => Effect.succeed(false),
      }),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: (kind) => (kind === "git" ? Effect.succeed(driver) : Effect.die("unexpected kind")),
      }),
    ),
  );

  return Effect.gen(function* () {
    const provisioning = yield* VcsProvisioningService.VcsProvisioningService;
    yield* provisioning.initRepository({ cwd: "/repo", kind: "git" });

    assert.deepStrictEqual(calls, ["git:/repo"]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("defaults repository initialization to Git until callers choose a VCS kind", () => {
  const calls: string[] = [];
  const driver = makeDriver(calls);
  const testLayer = VcsProvisioningService.layer.pipe(
    Layer.provide(
      Layer.mock(RepositoryDiscovery.RepositoryDiscovery)({
        isContainer: () => Effect.succeed(false),
      }),
    ),
    Layer.provide(NodeServices.layer),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        get: (kind) => (kind === "git" ? Effect.succeed(driver) : Effect.die("unexpected kind")),
      }),
    ),
  );

  return Effect.gen(function* () {
    const provisioning = yield* VcsProvisioningService.VcsProvisioningService;
    yield* provisioning.initRepository({ cwd: "/repo" });

    assert.deepStrictEqual(calls, ["default:/repo"]);
  }).pipe(Effect.provide(testLayer));
});

it.effect("keeps the repository folder separate from its member Git repositories", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-folder-init-" });
    yield* fs.makeDirectory(path.join(root, "app", ".git"), { recursive: true });
    const calls: string[] = [];
    const driver = makeDriver(calls);
    const error = yield* Effect.gen(function* () {
      const provisioning = yield* VcsProvisioningService.VcsProvisioningService;
      return yield* provisioning.initRepository({ cwd: root }).pipe(Effect.flip);
    }).pipe(
      Effect.provide(
        VcsProvisioningService.layer.pipe(
          Layer.provide(
            Layer.mock(RepositoryDiscovery.RepositoryDiscovery)({
              isContainer: () => Effect.succeed(true),
            }),
          ),
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({ get: () => Effect.succeed(driver) }),
          ),
        ),
      ),
    );
    assert.strictEqual(error._tag, "VcsUnsupportedOperationError");
    assert.deepStrictEqual(calls, []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

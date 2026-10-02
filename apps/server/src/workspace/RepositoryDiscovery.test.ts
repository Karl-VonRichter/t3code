import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as RepositoryDiscovery from "./RepositoryDiscovery.ts";

const TestLayer = RepositoryDiscovery.layer.pipe(
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-discovery-config-" })),
  Layer.provideMerge(NodeServices.layer),
);

const createRepository = Effect.fnUntraced(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const run = (args: string[]) => git.execute({ cwd, args, operation: "discovery-test-fixture" });
  yield* fs.makeDirectory(cwd, { recursive: true });
  yield* run(["init", "--initial-branch=main"]);
  yield* run(["config", "user.name", "Discovery Test"]);
  yield* run(["config", "user.email", "discovery@example.test"]);
  yield* run(["config", "commit.gpgsign", "false"]);
  yield* fs.writeFileString(path.join(cwd, "file.txt"), "baseline\n");
  yield* run(["add", "."]);
  yield* run(["commit", "-m", "baseline"]);
  return run;
});

it.layer(TestLayer)("Repository discovery", (it) => {
  it.effect("discovers nested repositories and worktree .git files with independent branches", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-discovery-" });
      const app = yield* createRepository(path.join(root, "app"));
      const platform = yield* createRepository(path.join(root, "modules", "platform"));
      const platformSha = (yield* platform(["rev-parse", "HEAD"])).stdout.trim();
      yield* platform(["checkout", "--detach"]);
      yield* app(["worktree", "add", "-b", "task", path.join(root, "task")]);
      const discovery = yield* RepositoryDiscovery.RepositoryDiscovery;
      const workspace = yield* discovery.discover(root);
      assert.deepStrictEqual(
        workspace?.repositories.map((repository) => [repository.id, repository.branch]),
        [
          ["app", "main"],
          ["modules/platform", null],
          ["task", "task"],
        ],
      );
      assert.strictEqual(workspace?.repositories[1]?.checkoutSha, platformSha);
      assert.strictEqual(yield* discovery.isContainer(root), true);
      assert.strictEqual(yield* discovery.isContainer(path.join(root, "app")), false);
    }),
  );

  it.effect("returns no workspace for a missing project folder", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-discovery-missing-" });
      const discovery = yield* RepositoryDiscovery.RepositoryDiscovery;
      assert.strictEqual(yield* discovery.discover(path.join(root, "missing")), null);
      assert.strictEqual(yield* discovery.isContainer(path.join(root, "missing")), false);
    }),
  );

  it.effect(
    "keeps discovery within the selected folder and skips generated output and symlinks",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-discovery-boundary-" });
        const outside = yield* fs.makeTempDirectoryScoped({ prefix: "t3-discovery-outside-" });
        yield* createRepository(path.join(root, "app"));
        yield* createRepository(path.join(root, "build", "generated"));
        yield* createRepository(path.join(root, "node_modules", "installed"));
        yield* createRepository(path.join(outside, "other"));
        yield* fs.symlink(outside, path.join(root, "outside-link"));
        yield* fs.symlink(root, path.join(root, "loop"));
        const discovery = yield* RepositoryDiscovery.RepositoryDiscovery;
        assert.deepStrictEqual(
          (yield* discovery.discover(root))?.repositories.map((repository) => repository.path),
          ["app"],
        );
        assert.strictEqual(yield* discovery.discover(path.join(root, "app")), null);
      }),
  );

  it.effect(
    "includes the root checkout alongside nested repositories without prefixing root files",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-discovery-root-" });
        yield* createRepository(root);
        yield* createRepository(path.join(root, "nested"));
        const discovery = yield* RepositoryDiscovery.RepositoryDiscovery;
        assert.deepStrictEqual(
          (yield* discovery.discover(root))?.repositories.map((repository) => repository.path),
          [".", "nested"],
        );
        assert.strictEqual(yield* discovery.isContainer(root), false);
      }),
  );

  it.effect(
    "returns no workspace for an empty folder and records an unborn branch without a SHA",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const git = yield* GitVcsDriver.GitVcsDriver;
        const empty = yield* fs.makeTempDirectoryScoped({ prefix: "t3-discovery-empty-" });
        const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-discovery-unborn-" });
        const cwd = path.join(root, "new-repo");
        yield* fs.makeDirectory(cwd);
        yield* git.execute({
          cwd,
          args: ["init", "--initial-branch=feature"],
          operation: "test.init",
        });
        const discovery = yield* RepositoryDiscovery.RepositoryDiscovery;
        assert.strictEqual(yield* discovery.discover(empty), null);
        assert.strictEqual(yield* discovery.isContainer(empty), false);
        assert.deepStrictEqual((yield* discovery.discover(root))?.repositories, [
          { id: "new-repo", path: "new-repo", branch: "feature", checkoutSha: null },
        ]);
      }),
  );
});

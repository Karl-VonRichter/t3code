import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ServerSettings from "../serverSettings.ts";
import { ServerConfig } from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as RepositoryDiscovery from "../workspace/RepositoryDiscovery.ts";
import * as ReviewService from "./ReviewService.ts";
import * as ReviewWorkspaceRoots from "./ReviewWorkspaceRoots.ts";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-repository-review-" });
  const baselines: Record<string, string> = {};
  for (const name of ["app", "platform", "vendor/lib"] as const) {
    const cwd = path.join(root, name);
    yield* fs.makeDirectory(cwd, { recursive: true });
    const run = (args: string[]) =>
      git.execute({ cwd, args, operation: "repository-test-fixture" });
    yield* run(["init", "--initial-branch=main"]);
    yield* run(["config", "user.name", "Repository Test"]);
    yield* run(["config", "user.email", "repository@example.test"]);
    yield* run(["config", "commit.gpgsign", "false"]);
    yield* fs.writeFileString(path.join(cwd, "file.txt"), "before\n");
    yield* run(["add", "."]);
    yield* run(["commit", "-m", "baseline"]);
    const sha = (yield* run(["rev-parse", "HEAD"])).stdout.trim();
    if (name === "platform") yield* run(["checkout", "--detach"]);
    baselines[name] = sha;
    yield* fs.writeFileString(path.join(cwd, "file.txt"), `${name} edited\n`);
  }
  return { root, baselines };
});

const TestLayer = GitVcsDriver.layer.pipe(
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-repository-test-config-" })),
  Layer.provideMerge(NodeServices.layer),
);

function reviewLayer(root: string) {
  return ReviewService.layer.pipe(
    Layer.provide(ServerSettings.ServerSettingsService.layerTest()),
    Layer.provide(RepositoryDiscovery.layer),
    Layer.provide(
      Layer.succeed(ReviewWorkspaceRoots.ReviewWorkspaceRoots, {
        list: () => Effect.succeed([root]),
      }),
    ),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: () => Effect.die("container review must route directly to member Git repositories"),
      }),
    ),
    Layer.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-repository-review-config-" }),
    ),
  );
}

it.layer(TestLayer)("Repository folder review", (it) => {
  it.effect(
    "collects changes from named, detached, and nested repositories with distinct paths",
    () =>
      Effect.gen(function* () {
        const { root } = yield* fixture;
        const preview = yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          return yield* review.getDiffPreview({ cwd: root });
        }).pipe(Effect.provide(reviewLayer(root)));
        assert.strictEqual(preview.workspace?.root, root);
        const dirty = preview.sources.filter((source) => source.kind === "working-tree");
        assert.deepStrictEqual(
          dirty.flatMap((source) => source.files?.map((file) => file.path) ?? []),
          ["app/file.txt", "platform/file.txt", "vendor/lib/file.txt"],
        );
        assert.isTrue(dirty.every((source) => source.truncated && source.diff === ""));
      }),
  );

  it.effect("loads a prefixed patch and full file contents from the selected repository", () =>
    Effect.gen(function* () {
      const { root } = yield* fixture;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      // An unrelated broken checkout must not prevent reading a healthy member.
      const broken = path.join(root, "broken");
      yield* fs.makeDirectory(broken);
      yield* fs.writeFileString(path.join(broken, ".git"), "gitdir: unavailable\n");
      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        const preview = yield* review.getDiffPreview({
          cwd: root,
          repositoryId: "platform",
          file: { path: "platform/file.txt", previousPath: null, sourceKind: "working-tree" },
        });
        const source = preview.sources.find((source) => source.kind === "working-tree")!;
        assert.deepStrictEqual(
          preview.workspace?.repositories.map((member) => member.id),
          ["platform"],
        );
        assert.include(source.diff, "a/platform/file.txt");
        assert.include(source.diff, "+platform edited");
        assert.deepStrictEqual(
          source.files?.map((file) => file.path),
          ["platform/file.txt"],
        );
        const contents = yield* review.getDiffFileContents({
          cwd: root,
          repositoryId: "platform",
          sourceKind: "working-tree",
          changeType: "change",
          baseRef: "HEAD",
          headRef: null,
          oldPath: "platform/file.txt",
          newPath: "platform/file.txt",
        });
        assert.deepStrictEqual(contents, {
          oldContents: "before\n",
          newContents: "platform edited\n",
        });
      }).pipe(Effect.provide(reviewLayer(root)));
    }),
  );

  it.effect("compares commits on detached HEAD to an explicitly selected commit", () =>
    Effect.gen(function* () {
      const { root, baselines } = yield* fixture;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const cwd = path.join(root, "platform");
      yield* git.execute({ cwd, args: ["add", "."], operation: "test.stage" });
      yield* git.execute({
        cwd,
        args: ["commit", "-m", "detached change"],
        operation: "test.commit",
      });
      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        const preview = yield* review.getDiffPreview({
          cwd: root,
          repositoryId: "platform",
          baseRef: baselines.platform,
        });
        const source = preview.sources.find(
          (source) => source.repository?.id === "platform" && source.kind === "branch-range",
        )!;
        assert.strictEqual(source.baseRef, baselines.platform);
        assert.deepStrictEqual(
          source.files?.map((file) => file.path),
          ["platform/file.txt"],
        );
        const contents = yield* review.getDiffFileContents({
          cwd: root,
          repositoryId: "platform",
          sourceKind: "branch-range",
          changeType: "change",
          baseRef: source.baseRef,
          headRef: source.headRef,
          oldPath: "platform/file.txt",
          newPath: "platform/file.txt",
        });
        assert.deepStrictEqual(contents, {
          oldContents: "before\n",
          newContents: "platform edited\n",
        });
      }).pipe(Effect.provide(reviewLayer(root)));
    }),
  );

  it.effect(
    "resolves a repository's recorded base branch and retains other repository changes",
    () =>
      Effect.gen(function* () {
        const { root } = yield* fixture;
        const path = yield* Path.Path;
        const git = yield* GitVcsDriver.GitVcsDriver;
        const cwd = path.join(root, "app");
        const run = (args: string[]) => git.execute({ cwd, args, operation: "test.branch" });
        yield* run(["checkout", "-b", "feature"]);
        yield* run(["config", "branch.feature.gh-merge-base", "main"]);
        yield* run(["add", "."]);
        yield* run(["commit", "-m", "app change"]);
        yield* Effect.gen(function* () {
          const review = yield* ReviewService.ReviewService;
          const preview = yield* review.getDiffPreview({ cwd: root, repositoryId: "app" });
          assert.strictEqual(
            preview.sources.find(
              (source) => source.repository?.id === "app" && source.kind === "branch-range",
            )?.baseRef,
            "main",
          );
          assert.deepStrictEqual(
            preview.sources
              .filter((source) => source.kind === "working-tree")
              .flatMap((source) => source.files?.map((file) => file.path) ?? []),
            ["platform/file.txt", "vendor/lib/file.txt"],
          );
          assert.deepStrictEqual(
            preview.sources
              .find((source) => source.repository?.id === "app" && source.kind === "branch-range")
              ?.files?.map((file) => file.path),
            ["app/file.txt"],
          );
        }).pipe(Effect.provide(reviewLayer(root)));
      }),
  );

  it.effect("loads unprefixed root patches and nested repository patches in one project", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const git = yield* GitVcsDriver.GitVcsDriver;
      const { root } = yield* fixture;
      const run = (args: string[]) => git.execute({ cwd: root, args, operation: "test.root" });
      yield* run(["init", "--initial-branch=main"]);
      yield* run(["config", "user.name", "Root Test"]);
      yield* run(["config", "user.email", "root@example.test"]);
      yield* run(["config", "commit.gpgsign", "false"]);
      yield* fs.writeFileString(path.join(root, "root.txt"), "root baseline\n");
      yield* fs.writeFileString(path.join(root, ".gitignore"), "app/\nplatform/\nvendor/\n");
      yield* run(["add", "root.txt", ".gitignore"]);
      yield* run(["commit", "-m", "root baseline"]);
      yield* fs.writeFileString(path.join(root, "root.txt"), "root edited\n");
      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        const preview = yield* review.getDiffPreview({ cwd: root });
        assert.deepStrictEqual(
          preview.workspace?.repositories.map((repository) => repository.path),
          [".", "app", "platform", "vendor/lib"],
        );
        const patch = yield* review.getDiffPreview({
          cwd: root,
          repositoryId: ".",
          file: { path: "root.txt", previousPath: null, sourceKind: "working-tree" },
        });
        assert.include(patch.sources[0]!.diff, "a/root.txt");
        assert.notInclude(patch.sources[0]!.diff, "a/./root.txt");
        const contents = yield* review.getDiffFileContents({
          cwd: root,
          repositoryId: ".",
          sourceKind: "working-tree",
          changeType: "change",
          baseRef: "HEAD",
          headRef: null,
          oldPath: "root.txt",
          newPath: "root.txt",
        });
        assert.deepStrictEqual(contents, {
          oldContents: "root baseline\n",
          newContents: "root edited\n",
        });
      }).pipe(Effect.provide(reviewLayer(root)));
    }),
  );

  it.effect("rejects files from another repository and traversal in renamed paths", () =>
    Effect.gen(function* () {
      const { root } = yield* fixture;
      yield* Effect.gen(function* () {
        const review = yield* ReviewService.ReviewService;
        for (const previousPath of ["app/file.txt", "platform/../app/file.txt"]) {
          const error = yield* review
            .getDiffPreview({
              cwd: root,
              repositoryId: "platform",
              file: { path: "platform/file.txt", previousPath, sourceKind: "working-tree" },
            })
            .pipe(Effect.flip);
          assert.strictEqual(error._tag, "WorkspaceDiscoveryError");
        }
      }).pipe(Effect.provide(reviewLayer(root)));
    }),
  );
});

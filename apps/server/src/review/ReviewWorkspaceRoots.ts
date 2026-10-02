import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { VcsRepositoryDetectionError } from "@t3tools/contracts";

/** Projects outside the server's launch directory are also valid review workspaces. */
export class ReviewWorkspaceRoots extends Context.Service<
  ReviewWorkspaceRoots,
  { readonly list: () => Effect.Effect<ReadonlyArray<string>, VcsRepositoryDetectionError> }
>()("t3/review/ReviewWorkspaceRoots") {}

const make = Effect.gen(function* () {
  const projects = yield* ProjectStore.ProjectStoreV2;
  const list = Effect.fn("ReviewWorkspaceRoots.list")(function* () {
    const rows = yield* projects.list().pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            operation: "ReviewWorkspaceRoots.list",
            cwd: "",
            detail: "Could not read project review roots.",
            cause,
          }),
      ),
    );
    return rows.map((row) => row.workspaceRoot);
  });
  return ReviewWorkspaceRoots.of({ list });
});

export const layer = Layer.effect(ReviewWorkspaceRoots, make);

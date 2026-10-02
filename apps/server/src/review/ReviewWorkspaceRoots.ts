import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { VcsRepositoryDetectionError } from "@t3tools/contracts";

/** Projects outside the server's launch directory are also valid review workspaces. */
export class ReviewWorkspaceRoots extends Context.Service<
  ReviewWorkspaceRoots,
  { readonly list: () => Effect.Effect<ReadonlyArray<string>, VcsRepositoryDetectionError> }
>()("t3/review/ReviewWorkspaceRoots") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const list = Effect.fn("ReviewWorkspaceRoots.list")(function* () {
    const rows = yield* sql<{ workspaceRoot: string }>`
      SELECT workspace_root AS "workspaceRoot" FROM projection_projects WHERE deleted_at IS NULL
    `.pipe(
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

import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const WorkspaceRepository = Schema.Struct({
  id: TrimmedNonEmptyString,
  path: TrimmedNonEmptyString,
  checkoutSha: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
});
export type WorkspaceRepository = typeof WorkspaceRepository.Type;

export const RepositoryWorkspace = Schema.Struct({
  kind: Schema.Literal("directory"),
  root: TrimmedNonEmptyString,
  repositories: Schema.Array(WorkspaceRepository),
});
export type RepositoryWorkspace = typeof RepositoryWorkspace.Type;

export class WorkspaceDiscoveryError extends Schema.TaggedError<WorkspaceDiscoveryError>()(
  "WorkspaceDiscoveryError",
  { cwd: Schema.String, detail: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return this.detail;
  }
}

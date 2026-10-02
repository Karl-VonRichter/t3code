import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  type VcsDriverKind,
  type VcsError,
  type VcsInitInput,
  VcsUnsupportedOperationError,
  VcsRepositoryDetectionError,
} from "@t3tools/contracts";
import * as RepositoryDiscovery from "../workspace/RepositoryDiscovery.ts";
import * as VcsDriverRegistry from "./VcsDriverRegistry.ts";

export class VcsProvisioningService extends Context.Service<
  VcsProvisioningService,
  {
    readonly initRepository: (input: VcsInitInput) => Effect.Effect<void, VcsError>;
  }
>()("t3/vcs/VcsProvisioningService") {}

function resolveRequestedKind(
  kind: VcsDriverKind | undefined,
): Effect.Effect<VcsDriverKind, VcsUnsupportedOperationError> {
  if (kind === undefined) {
    return Effect.succeed("git");
  }
  if (kind === "unknown") {
    return Effect.fail(
      new VcsUnsupportedOperationError({
        operation: "VcsProvisioningService.resolveRequestedKind",
        kind,
        detail: "A concrete VCS driver kind is required for repository provisioning.",
      }),
    );
  }
  return Effect.succeed(kind);
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const registry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const discovery = yield* RepositoryDiscovery.RepositoryDiscovery;

  const initRepository: VcsProvisioningService["Service"]["initRepository"] = Effect.fn(
    "VcsProvisioningService.initRepository",
  )(function* (input) {
    const kind = yield* resolveRequestedKind(input.kind);
    const isWorkspaceRoot = yield* discovery.isContainer(input.cwd).pipe(
      Effect.mapError(
        (cause) =>
          new VcsRepositoryDetectionError({
            operation: "VcsProvisioningService.initRepository",
            cwd: input.cwd,
            detail: "Cannot inspect the workspace directory.",
            cause,
          }),
      ),
    );
    if (isWorkspaceRoot)
      return yield* new VcsUnsupportedOperationError({
        operation: "VcsProvisioningService.initRepository",
        kind,
        detail: "This folder contains Git repositories. Initialize a member repository instead.",
      });
    const driver = yield* registry.get(kind);
    return yield* driver.initRepository(input);
  });

  return VcsProvisioningService.of({
    initRepository,
  });
});

export const layer = Layer.effect(VcsProvisioningService, make);

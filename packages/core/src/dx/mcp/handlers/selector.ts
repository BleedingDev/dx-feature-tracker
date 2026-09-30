import { Effect } from "effect";

import { InvalidInput } from "../../contracts/error-invalid-input.js";
import { FlightIdSchema, SnapshotIdSchema } from "../../model/ids.js";
import type { SnapshotId } from "../../model/ids.js";
import type { SnapshotSelector } from "../../model/snapshot.js";
import type { SelectorInput, SelectorResolver } from "./deps.js";

const MAX_TEXT = 1024;

const ISO_PREFIX =
  /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/u;

const cleanText = (
  field: string,
  value: string | undefined
): Effect.Effect<string | null, InvalidInput> => {
  if (value === undefined) {
    return Effect.succeed(null);
  }

  const trimmed = value.trim();

  if (trimmed === "" || trimmed.length > MAX_TEXT) {
    return Effect.fail(
      new InvalidInput({
        field,
        message: `${field} must be a non-empty string of at most ${MAX_TEXT} characters`,
      })
    );
  }

  return Effect.succeed(trimmed);
};

export const literalSelectorResolver: SelectorResolver = (
  input: SelectorInput
) =>
  Effect.succeed({
    branch: null,
    flightId: input.flight === null ? null : FlightIdSchema.make(input.flight),
    from: null,
    repoCommonDir: input.repo,
    to: null,
  } satisfies SnapshotSelector);

export interface QueryInput {
  readonly flight?: string | undefined;
  readonly repo?: string | undefined;
  readonly snapshotId?: string | undefined;
  readonly asOf?: string | undefined;
}

export interface ParsedQuery {
  readonly selector: SnapshotSelector;
  readonly snapshotId: SnapshotId | null;
  readonly asOf: string | null;
}

export const parseQuery = (
  input: QueryInput,
  resolver: SelectorResolver = literalSelectorResolver
): Effect.Effect<ParsedQuery, InvalidInput> =>
  Effect.gen(function* parseQueryInput() {
    const flight = yield* cleanText("flight", input.flight);
    const repo = yield* cleanText("repo", input.repo);
    const snapshotId = yield* cleanText("snapshotId", input.snapshotId);
    const asOf = yield* cleanText("asOf", input.asOf);

    if (
      asOf !== null &&
      (!ISO_PREFIX.test(asOf) || Number.isNaN(Date.parse(asOf)))
    ) {
      return yield* new InvalidInput({
        field: "asOf",
        message: "asOf must be an ISO-8601 timestamp",
      });
    }

    if (snapshotId !== null && asOf !== null) {
      return yield* new InvalidInput({
        field: "asOf",
        message:
          "snapshotId and asOf are mutually exclusive; a pinned snapshot is never re-bounded",
      });
    }

    const selector = yield* resolver({ flight, repo });

    return {
      asOf,
      selector,
      snapshotId:
        snapshotId === null ? null : SnapshotIdSchema.make(snapshotId),
    };
  });

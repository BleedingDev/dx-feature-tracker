import { Schema, Struct } from "effect";

import type {
  AgentBasisMetadataRead,
  AgentCursorRead,
  AgentResultMetadataRead,
  AgentStoreService,
} from "../contracts/agent-store.js";
import type { AgentHandle, AgentScope } from "../model/agent-common.js";
import {
  AgentRefResolutionSchema,
  AgentScopeSchema,
} from "../model/agent-common.js";
import {
  AgentCursorSchema,
  AgentResultMetadataSchema,
  AgentResultPageInputSchema,
  AgentResultPageSchema,
  AgentResultSchema,
  AnalysisBasisMetadataSchema,
  AnalysisBasisSchema,
} from "../model/agent-query.js";
import type {
  AgentCursor,
  AgentResult,
  AgentResultMetadata,
  AgentResultPage,
  AgentResultPageInput,
  AnalysisBasis,
  AnalysisBasisMetadata,
} from "../model/agent-query.js";
import { SourceCoverageSchema } from "../model/coverage.js";
import { DxEventEnvelopeSchema } from "../model/event.js";
import type { DxEventEnvelope } from "../model/event.js";
import { SnapshotSelectorSchema } from "../model/snapshot.js";
import type { SnapshotSelector } from "../model/snapshot.js";
import {
  agentDecoded,
  agentEncoded,
  agentError,
  agentHash,
  canonicalAgentJson,
  enforceAgentBytes,
} from "./agent-db.js";
import type { AgentDbContext } from "./agent-db.js";

type BasisStore = Pick<
  AgentStoreService,
  | "putBasis"
  | "getBasis"
  | "getBasisMetadata"
  | "readBasisMetadata"
  | "latestBasis"
  | "latestBasisMetadata"
  | "latestBasisForScope"
  | "readLatestBasisMetadataForScope"
  | "putResult"
  | "getResult"
  | "getResultMetadata"
  | "findResult"
  | "findResultMetadata"
  | "readResultMetadata"
  | "readMatchingResultMetadata"
  | "readResultPage"
  | "putCursor"
  | "getCursor"
  | "readCursor"
>;

const basisRow = Schema.decodeUnknownSync(
  Schema.Struct({
    body: Schema.String,
    content_available: Schema.Literals([0, 1]),
    content_digest: Schema.String,
  })
);

const resultRow = Schema.decodeUnknownSync(
  Schema.Struct({
    body: Schema.String,
    byte_count: Schema.Int,
    content_digest: Schema.String,
    projection: Schema.NullOr(Schema.String),
  })
);

const cursorRow = Schema.decodeUnknownSync(
  Schema.Struct({ body: Schema.String, epoch: Schema.String })
);

const measuredCursorRow = Schema.decodeUnknownSync(
  Schema.Struct({
    body: Schema.NullOr(Schema.String),
    byte_count: Schema.Int,
    epoch: Schema.String,
  })
);

const cursorViewRow = Schema.decodeUnknownSync(
  Schema.Struct({
    basis_id: Schema.String,
    content_available: Schema.Literals([0, 1]),
    item_count: Schema.Int,
    projection_version: Schema.String,
    query_digest: Schema.String,
    series_count: Schema.Int,
  })
);

const bodyRow = Schema.decodeUnknownSync(
  Schema.Struct({ body: Schema.String })
);

const retainedBytesRow = Schema.decodeUnknownSync(
  Schema.Struct({ bytes: Schema.Int })
);

const evictableRow = Schema.decodeUnknownSync(
  Schema.Struct({ byte_count: Schema.Int, id: Schema.String })
);

const availabilityRow = Schema.decodeUnknownSync(
  Schema.Struct({
    body: Schema.NullOr(Schema.String),
    byte_count: Schema.Int,
    content_available: Schema.Literals([0, 1]),
  })
);

const pageHeaderRow = Schema.decodeUnknownSync(
  Schema.Struct({
    byte_count: Schema.Int,
    content_available: Schema.Literals([0, 1]),
    disclosures: Schema.NullOr(Schema.String),
    item_count: Schema.Int,
    resolutions: Schema.NullOr(Schema.String),
    series_count: Schema.Int,
    summary: Schema.NullOr(Schema.String),
  })
);

const pageItemRow = Schema.decodeUnknownSync(
  Schema.Struct({ byte_count: Schema.Int, position: Schema.Int })
);

const captureRow = Schema.decodeUnknownSync(
  Schema.Struct({
    coverage: Schema.String,
    epoch: Schema.String,
    filters_body: Schema.String,
    generation: Schema.Int,
    scope_body: Schema.NullOr(Schema.String),
    selector_body: Schema.String,
    store_id: Schema.String,
    upper_seq: Schema.Int,
  })
);

const eventSourceRow = Schema.decodeUnknownSync(
  Schema.Struct({ body: Schema.String, seq: Schema.Int })
);

const resolutionsSchema = Schema.Array(AgentRefResolutionSchema).check(
  Schema.isMaxLength(500)
);

const projectionSchema = Schema.Struct({
  disclosures: Schema.Array(
    Schema.String.check(Schema.isMaxLength(4096))
  ).check(Schema.isMaxLength(64)),
  items: Schema.Array(Schema.Json),
  series: Schema.Array(Schema.Json),
  summary: Schema.Json,
});

const basisScopeKey = (scope: AgentScope): string =>
  agentHash(
    canonicalAgentJson({
      ...Struct.omit(scope, ["resolution"]),
      branchSelection: {
        ...scope.branchSelection,
        branches: [...new Set(scope.branchSelection.branches)].toSorted(),
      },
      sources: [...new Set(scope.sources)].toSorted(),
      tools: [...new Set(scope.tools)].toSorted(),
    })
  );

const basisMetadata = (basis: AnalysisBasis): AnalysisBasisMetadata =>
  Schema.decodeUnknownSync(AnalysisBasisMetadataSchema)({
    ...basis,
    interpretationBytes: Buffer.byteLength(basis.interpretationInputs, "utf-8"),
    priceSheets: basis.priceSheets.map((sheet) => ({
      contentHash: sheet.contentHash,
      effectiveFrom: sheet.effectiveFrom,
      effectiveUntil: sheet.effectiveUntil,
      id: sheet.id,
    })),
    retainedDecodedBytes: Buffer.byteLength(
      agentEncoded(AnalysisBasisSchema, basis),
      "utf-8"
    ),
    retainedEventCount: basis.retainedEvents.length,
  });

const assertCaptureScope = (
  basis: AnalysisBasis,
  selector: SnapshotSelector
): void => {
  if (
    selector.from !== basis.window.sinceInclusive ||
    selector.to !== basis.window.untilExclusive
  ) {
    throw agentError(
      "basis-incompatible",
      "The analysis window differs from its atomic event selection"
    );
  }

  if (
    (selector.repoCommonDir !== null &&
      selector.repoCommonDir !== basis.scope.repoId) ||
    (selector.flightId !== null && selector.flightId !== basis.scope.flightId)
  ) {
    throw agentError(
      "basis-incompatible",
      "The analysis scope differs from its atomic event selection"
    );
  }

  if (
    selector.branch !== null &&
    (!basis.scope.branchSelection.branches.includes(selector.branch) ||
      (basis.scope.branchSelection.kind !== "current" &&
        basis.scope.branchSelection.kind !== "selected"))
  ) {
    throw agentError(
      "basis-incompatible",
      "The analysis branch differs from its atomic event selection"
    );
  }
};

const assertScopedEvent = (scope: AgentScope, event: DxEventEnvelope): void => {
  if (
    (scope.repoId !== null && event.context.repoCommonDir !== scope.repoId) ||
    (scope.worktreeId !== null &&
      event.context.worktreePath !== scope.worktreeId) ||
    (scope.flightId !== null && event.context.flightId !== scope.flightId)
  ) {
    throw agentError(
      "basis-incompatible",
      "A retained observation is outside its captured repository, worktree or flight scope"
    );
  }

  if (scope.sources.length > 0 && !scope.sources.includes(event.adapterId)) {
    throw agentError(
      "basis-incompatible",
      "A retained observation is outside its captured source selection"
    );
  }

  if (
    scope.tools.length > 0 &&
    !scope.tools.includes(event.ai?.harness ?? "")
  ) {
    throw agentError(
      "basis-incompatible",
      "A retained observation is outside its captured tool selection"
    );
  }

  if (
    (scope.branchSelection.kind === "current" ||
      scope.branchSelection.kind === "selected") &&
    !scope.branchSelection.branches.includes(event.context.branch ?? "")
  ) {
    throw agentError(
      "basis-incompatible",
      "A retained observation is outside its captured branch scope"
    );
  }
};

const assertCapturedEvent = (
  basis: AnalysisBasis,
  selector: SnapshotSelector,
  event: DxEventEnvelope
): void => {
  if (
    (selector.repoCommonDir !== null &&
      event.context.repoCommonDir !== selector.repoCommonDir) ||
    (selector.flightId !== null &&
      event.context.flightId !== selector.flightId) ||
    (selector.branch !== null && event.context.branch !== selector.branch)
  ) {
    throw agentError(
      "basis-incompatible",
      "A retained observation is outside its captured repository, flight or branch selection"
    );
  }

  if (
    basis.scope.branchSelection.branches.length > 0 &&
    (event.context.branch === null ||
      !basis.scope.branchSelection.branches.includes(event.context.branch))
  ) {
    throw agentError(
      "basis-incompatible",
      "A retained observation is outside the analysis branch selection"
    );
  }

  const timestamp = event.occurredAt ?? event.observedAt;

  if (
    (selector.from !== null && timestamp < selector.from) ||
    (selector.to !== null && timestamp >= selector.to)
  ) {
    throw agentError(
      "basis-incompatible",
      "A retained observation is outside its captured time window"
    );
  }
};

const decodeBasisHeaderRead = (
  row: ReturnType<typeof availabilityRow> | undefined,
  maxDecodedBytes: number
): AgentBasisMetadataRead => {
  if (row === undefined) {
    return { decodedBytes: 0, factsExamined: 0, metadata: null };
  }

  if (row.content_available === 0) {
    throw agentError(
      "basis-content-unavailable",
      "The analysis basis was invalidated by scoped evidence deletion"
    );
  }

  if (row.body === null || row.byte_count > maxDecodedBytes) {
    return { decodedBytes: 0, factsExamined: 1, metadata: null };
  }

  return {
    decodedBytes: row.byte_count,
    factsExamined: 1,
    metadata: agentDecoded(AnalysisBasisMetadataSchema, row.body),
  };
};

const decodeResultHeaderRead = (
  row: ReturnType<typeof availabilityRow> | undefined,
  maxDecodedBytes: number
): AgentResultMetadataRead => {
  if (row === undefined) {
    return { decodedBytes: 0, factsExamined: 0, metadata: null };
  }

  if (row.content_available === 0) {
    throw agentError(
      "basis-content-unavailable",
      "The computed view basis was invalidated by scoped evidence deletion"
    );
  }

  if (row.body === null || row.byte_count > maxDecodedBytes) {
    return { decodedBytes: 0, factsExamined: 1, metadata: null };
  }

  return {
    decodedBytes: row.byte_count,
    factsExamined: 1,
    metadata: agentDecoded(AgentResultMetadataSchema, row.body),
  };
};

export const sqliteBasisMethods = (context: AgentDbContext): BasisStore => {
  const readMeasuredBasisHeader = (
    handle: AgentHandle,
    maxDecodedBytes: number
  ): AgentBasisMetadataRead => {
    context.assertHandle(handle);

    const raw = context.db
      .prepare(
        "SELECT CASE WHEN LENGTH(CAST(h.body AS BLOB)) <= ? THEN h.body ELSE NULL END AS body, LENGTH(CAST(h.body AS BLOB)) AS byte_count, b.content_available FROM agent_basis_headers h JOIN agent_bases b ON b.id = h.id WHERE h.id = ? AND b.store_id = ? AND b.generation = ?"
      )
      .get(maxDecodedBytes, handle.id, handle.storeId, handle.storeGeneration);

    return decodeBasisHeaderRead(
      raw === undefined ? undefined : availabilityRow(raw),
      maxDecodedBytes
    );
  };

  const readBasisHeader = (
    handle: AgentHandle,
    maxDecodedBytes = 67_108_864
  ): AnalysisBasisMetadata => {
    const read = readMeasuredBasisHeader(handle, maxDecodedBytes);

    if (read.metadata === null) {
      throw read.factsExamined === 0
        ? agentError(
            "basis-not-found",
            "The analysis basis metadata is not present in this store"
          )
        : agentError(
            "budget-exhausted",
            "The byte budget cannot decode the retained basis metadata"
          );
    }

    return read.metadata;
  };

  const readMeasuredResultHeader = (
    handle: AgentHandle,
    maxDecodedBytes: number
  ): AgentResultMetadataRead => {
    context.assertHandle(handle);

    const raw = context.db
      .prepare(
        "SELECT CASE WHEN LENGTH(CAST(h.body AS BLOB)) <= ? THEN h.body ELSE NULL END AS body, LENGTH(CAST(h.body AS BLOB)) AS byte_count,b.content_available FROM agent_result_headers h JOIN agent_results r ON r.id = h.id JOIN agent_bases b ON b.id = r.basis_id WHERE h.id = ? AND r.store_id = ? AND r.generation = ?"
      )
      .get(maxDecodedBytes, handle.id, handle.storeId, handle.storeGeneration);

    return decodeResultHeaderRead(
      raw === undefined ? undefined : availabilityRow(raw),
      maxDecodedBytes
    );
  };

  const readResultHeader = (
    handle: AgentHandle,
    maxDecodedBytes = 67_108_864
  ): AgentResultMetadata => {
    const read = readMeasuredResultHeader(handle, maxDecodedBytes);

    if (read.metadata === null) {
      throw read.factsExamined === 0
        ? agentError(
            "basis-content-unavailable",
            "The computed view metadata is not retained in this store"
          )
        : agentError(
            "budget-exhausted",
            "The byte budget cannot decode the retained result metadata"
          );
    }

    return read.metadata;
  };

  const readBasis = (handle: AgentHandle): AnalysisBasis => {
    context.assertHandle(handle);

    const raw = context.db
      .prepare(
        "SELECT body, content_available, content_digest FROM agent_bases WHERE id = ?"
      )
      .get(handle.id);

    if (raw === undefined) {
      throw agentError(
        "basis-not-found",
        "The analysis basis is not present in this store"
      );
    }

    const row = basisRow(raw);

    if (row.content_available === 0) {
      throw agentError(
        "basis-content-unavailable",
        "The retained analysis basis content is unavailable"
      );
    }

    const basis = agentDecoded(AnalysisBasisSchema, row.body);
    context.assertHandle(basis);

    if (agentHash(canonicalAgentJson(basis)) !== row.content_digest) {
      throw agentError(
        "basis-content-unavailable",
        "The retained analysis basis content failed its integrity check"
      );
    }

    return basis;
  };

  const readResultContent = (handle: AgentHandle) => {
    context.assertHandle(handle);

    const raw = context.db
      .prepare(
        "SELECT body, projection, byte_count, content_digest FROM agent_results WHERE id = ?"
      )
      .get(handle.id);

    if (raw === undefined) {
      throw agentError(
        "basis-content-unavailable",
        "The computed view is not retained in this store"
      );
    }

    const row = resultRow(raw);
    const result = agentDecoded(AgentResultSchema, row.body);
    context.assertHandle(result);

    return { result, row };
  };

  const readResult = (handle: AgentHandle): AgentResult => {
    readResultHeader(handle);
    const { result, row } = readResultContent(handle);

    if (row.projection === null) {
      throw agentError(
        "basis-content-unavailable",
        "The ordered computed view was evicted by the retention policy"
      );
    }

    const restored = Schema.decodeUnknownSync(AgentResultSchema)({
      ...result,
      orderedProjection: row.projection,
      resolutions: agentDecoded(
        resolutionsSchema,
        Schema.decodeUnknownSync(Schema.Struct({ resolutions: Schema.String }))(
          context.db
            .prepare(
              "SELECT resolutions FROM agent_result_headers WHERE id = ?"
            )
            .get(handle.id)
        ).resolutions
      ),
    });

    if (
      Buffer.byteLength(row.projection, "utf-8") !== row.byte_count ||
      agentHash(canonicalAgentJson(restored)) !== row.content_digest
    ) {
      throw agentError(
        "basis-content-unavailable",
        "The retained computed view failed its integrity check"
      );
    }

    return restored;
  };

  const trimProjections = (): void => {
    let retainedBytes = retainedBytesRow(
      context.db
        .prepare(
          "SELECT COALESCE((SELECT SUM(byte_count) FROM agent_results WHERE projection IS NOT NULL), 0) + COALESCE((SELECT SUM(byte_count) FROM agent_result_items), 0) + COALESCE((SELECT SUM(LENGTH(CAST(h.summary AS BLOB)) + LENGTH(CAST(h.disclosures AS BLOB)) + LENGTH(CAST(h.resolutions AS BLOB))) FROM agent_result_headers h JOIN agent_results r ON r.id = h.id WHERE r.projection IS NOT NULL), 0) AS bytes"
        )
        .get()
    ).bytes;

    if (retainedBytes <= context.limits.maxProjectionBytes) {
      return;
    }

    const rows = context.db
      .prepare(
        "SELECT r.id, r.byte_count + COALESCE((SELECT SUM(i.byte_count) FROM agent_result_items i WHERE i.result_id = r.id), 0) + COALESCE(LENGTH(CAST(h.summary AS BLOB)) + LENGTH(CAST(h.disclosures AS BLOB)) + LENGTH(CAST(h.resolutions AS BLOB)), 0) AS byte_count FROM agent_results r LEFT JOIN agent_result_headers h ON h.id = r.id WHERE r.projection IS NOT NULL ORDER BY r.seq ASC"
      )
      .all();

    for (const raw of rows) {
      if (retainedBytes <= context.limits.maxProjectionBytes) {
        break;
      }

      const row = evictableRow(raw);
      context.db
        .prepare("UPDATE agent_results SET projection = NULL WHERE id = ?")
        .run(row.id);
      context.db
        .prepare("DELETE FROM agent_result_items WHERE result_id = ?")
        .run(row.id);
      context.db
        .prepare(
          "UPDATE agent_result_headers SET summary = 'null', disclosures = '[]', resolutions = '[]' WHERE id = ?"
        )
        .run(row.id);
      retainedBytes -= row.byte_count;
    }
  };

  const captureSelection = (
    basis: AnalysisBasis
  ): {
    readonly upperSequence: number;
    readonly selector: SnapshotSelector;
    readonly scope: AgentScope | null;
  } | null => {
    if (!basis.eventWatermark.startsWith("read:")) {
      if (basis.reproducibility === "retained-inputs") {
        throw agentError(
          "basis-incompatible",
          "Retained-input reproducibility requires an atomic event selection watermark"
        );
      }

      return null;
    }

    const raw = context.db
      .prepare(
        "SELECT upper_seq, store_id, generation, epoch, coverage, selector_body, scope_body, filters_body FROM agent_event_reads WHERE id = ?"
      )
      .get(basis.eventWatermark.slice("read:".length));

    if (raw === undefined) {
      throw agentError(
        "basis-incompatible",
        "The atomic event selection watermark is unavailable"
      );
    }

    const capture = captureRow(raw);

    if (
      capture.store_id !== basis.storeId ||
      capture.generation !== basis.storeGeneration ||
      capture.epoch !== context.epoch()
    ) {
      throw agentError(
        "basis-incompatible",
        "The atomic event selection belongs to another store identity or epoch"
      );
    }

    const coverage = agentDecoded(
      Schema.Array(SourceCoverageSchema),
      capture.coverage
    );

    if (canonicalAgentJson(coverage) !== canonicalAgentJson(basis.coverage)) {
      throw agentError(
        "basis-incompatible",
        "The analysis basis coverage differs from its atomic event selection"
      );
    }

    const selector = agentDecoded(
      SnapshotSelectorSchema,
      capture.selector_body
    );

    const filters = agentDecoded(
      AnalysisBasisSchema.fields.normalizedFilters,
      capture.filters_body
    );

    if (
      canonicalAgentJson(filters) !==
      canonicalAgentJson(basis.normalizedFilters)
    ) {
      throw agentError(
        "basis-incompatible",
        "The normalized analysis filters differ from their atomic event selection"
      );
    }

    const scope =
      capture.scope_body === null
        ? null
        : agentDecoded(AgentScopeSchema, capture.scope_body);

    if (scope !== null && basisScopeKey(scope) !== basisScopeKey(basis.scope)) {
      throw agentError(
        "basis-incompatible",
        "The complete analysis scope differs from its atomic event selection"
      );
    }

    assertCaptureScope(basis, selector);

    return { scope, selector, upperSequence: capture.upper_seq };
  };

  const validateCursorView = (cursor: AgentCursor): void => {
    const rawBasis = context.db
      .prepare(
        "SELECT b.content_available FROM agent_bases b JOIN agent_basis_headers h ON h.id = b.id WHERE b.id = ? AND b.store_id = ? AND b.generation = ?"
      )
      .get(cursor.basisId, cursor.storeId, cursor.storeGeneration);

    if (rawBasis === undefined) {
      throw agentError(
        "basis-not-found",
        "The analysis basis metadata is not present in this store"
      );
    }

    if (
      Schema.decodeUnknownSync(
        Schema.Struct({ content_available: Schema.Literals([0, 1]) })
      )(rawBasis).content_available === 0
    ) {
      throw agentError(
        "basis-content-unavailable",
        "The analysis basis was invalidated by scoped evidence deletion"
      );
    }

    const raw = context.db
      .prepare(
        "SELECT r.basis_id, r.query_digest, r.projection_version, h.item_count, h.series_count, b.content_available FROM agent_results r JOIN agent_result_headers h ON h.id = r.id JOIN agent_bases b ON b.id = r.basis_id WHERE r.id = ? AND r.store_id = ? AND r.generation = ?"
      )
      .get(cursor.resultId, cursor.storeId, cursor.storeGeneration);

    if (raw === undefined) {
      throw agentError(
        "basis-content-unavailable",
        "The computed view metadata is not retained in this store"
      );
    }

    const result = cursorViewRow(raw);

    if (result.content_available === 0) {
      throw agentError(
        "basis-content-unavailable",
        "The computed view basis was invalidated by scoped evidence deletion"
      );
    }

    if (
      result.basis_id !== cursor.basisId ||
      result.query_digest !== cursor.queryDigest ||
      result.projection_version !== cursor.projectionVersion ||
      (cursor.axis === "items" && cursor.position > result.item_count) ||
      (cursor.axis === "series" && cursor.position > result.series_count) ||
      (cursor.kind === "output-page" && cursor.axis === "work") ||
      (cursor.kind === "work-continuation" && cursor.axis !== "work")
    ) {
      throw agentError(
        "cursor-mismatch",
        "The cursor does not match its pinned computed view"
      );
    }
  };

  const readMeasuredCursor = (
    handle: AgentHandle,
    maxDecodedBytes: number
  ): AgentCursorRead => {
    context.assertHandle(handle);

    const raw = context.db
      .prepare(
        "SELECT CASE WHEN LENGTH(CAST(body AS BLOB)) <= ? THEN body ELSE NULL END AS body, LENGTH(CAST(body AS BLOB)) AS byte_count, epoch FROM agent_cursors WHERE id = ? AND store_id = ? AND generation = ?"
      )
      .get(maxDecodedBytes, handle.id, handle.storeId, handle.storeGeneration);

    if (raw === undefined) {
      return { cursor: null, decodedBytes: 0, factsExamined: 0 };
    }

    const row = measuredCursorRow(raw);

    if (row.epoch !== context.epoch()) {
      throw agentError(
        "cursor-mismatch",
        "The cursor was invalidated by a store restore or reset"
      );
    }

    if (row.body === null || row.byte_count > maxDecodedBytes) {
      return { cursor: null, decodedBytes: 0, factsExamined: 1 };
    }

    const cursor = agentDecoded(AgentCursorSchema, row.body);
    context.assertHandle(cursor);
    validateCursorView(cursor);

    return { cursor, decodedBytes: row.byte_count, factsExamined: 1 };
  };

  const latestBasisHandle = (queryKey: string): AgentHandle | null => {
    const identity = context.identity();

    const raw = context.db
      .prepare(
        "SELECT id FROM agent_bases WHERE query_key = ? AND store_id = ? AND generation = ? ORDER BY seq DESC LIMIT 1"
      )
      .get(queryKey, identity.storeId, identity.storeGeneration);

    return raw === undefined
      ? null
      : {
          ...identity,
          id: Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
            raw
          ).id,
        };
  };

  const readLatestBasisHeader = (
    input: AgentScope,
    maxDecodedBytes: number
  ): AgentBasisMetadataRead => {
    const scope = Schema.decodeUnknownSync(AgentScopeSchema)(input);
    const identity = context.identity();
    const scopeKey = basisScopeKey(scope);

    const raw = context.db
      .prepare(
        "SELECT CASE WHEN LENGTH(CAST(h.body AS BLOB)) <= ? THEN h.body ELSE NULL END AS body, LENGTH(CAST(h.body AS BLOB)) AS byte_count, b.content_available FROM agent_bases b JOIN agent_basis_headers h ON h.id = b.id WHERE b.store_id = ? AND b.generation = ? AND b.scope_key = ? AND b.content_available = 1 ORDER BY b.created_at DESC, b.id DESC LIMIT 1"
      )
      .get(
        maxDecodedBytes,
        identity.storeId,
        identity.storeGeneration,
        scopeKey
      );

    return decodeBasisHeaderRead(
      raw === undefined ? undefined : availabilityRow(raw),
      maxDecodedBytes
    );
  };

  const assertResultBasisAvailable = (basis: AgentHandle): void => {
    context.assertHandle(basis);

    const available = context.db
      .prepare(
        "SELECT content_available FROM agent_bases WHERE id = ? AND store_id = ? AND generation = ?"
      )
      .get(basis.id, basis.storeId, basis.storeGeneration);

    if (available === undefined) {
      throw agentError(
        "basis-not-found",
        "The result basis is not present in this store"
      );
    }

    if (
      Schema.decodeUnknownSync(
        Schema.Struct({ content_available: Schema.Int })
      )(available).content_available !== 1
    ) {
      throw agentError(
        "basis-content-unavailable",
        "The result basis content is unavailable"
      );
    }
  };

  const readMatchingResultHeader = (
    basis: AgentHandle,
    capability: AgentResult["capability"],
    queryDigest: string,
    maxDecodedBytes: number
  ): AgentResultMetadataRead => {
    assertResultBasisAvailable(basis);

    const raw = context.db
      .prepare(
        "SELECT CASE WHEN LENGTH(CAST(h.body AS BLOB)) <= ? THEN h.body ELSE NULL END AS body, LENGTH(CAST(h.body AS BLOB)) AS byte_count, 1 AS content_available FROM agent_results r JOIN agent_result_headers h ON h.id = r.id WHERE r.basis_id = ? AND r.capability = ? AND r.query_digest = ? AND r.store_id = ? AND r.generation = ? ORDER BY r.seq DESC LIMIT 1"
      )
      .get(
        maxDecodedBytes,
        basis.id,
        capability,
        queryDigest,
        basis.storeId,
        basis.storeGeneration
      );

    return decodeResultHeaderRead(
      raw === undefined ? undefined : availabilityRow(raw),
      maxDecodedBytes
    );
  };

  const findResultHandle = (
    basis: AgentHandle,
    capability: AgentResult["capability"],
    queryDigest: string
  ): AgentHandle | null => {
    assertResultBasisAvailable(basis);

    const raw = context.db
      .prepare(
        "SELECT id FROM agent_results WHERE basis_id = ? AND capability = ? AND query_digest = ? AND store_id = ? AND generation = ? ORDER BY seq DESC LIMIT 1"
      )
      .get(
        basis.id,
        capability,
        queryDigest,
        basis.storeId,
        basis.storeGeneration
      );

    return raw === undefined
      ? null
      : {
          ...basis,
          id: Schema.decodeUnknownSync(Schema.Struct({ id: Schema.String }))(
            raw
          ).id,
        };
  };

  const readPage = (
    handle: AgentHandle,
    input: AgentResultPageInput
  ): AgentResultPage => {
    const startedAt = performance.now();
    context.assertHandle(handle);
    const page = Schema.decodeUnknownSync(AgentResultPageInputSchema)(input);

    const raw = context.db
      .prepare(
        "SELECT CASE WHEN byte_count <= ? THEN summary ELSE NULL END AS summary, CASE WHEN byte_count <= ? THEN disclosures ELSE NULL END AS disclosures, CASE WHEN byte_count <= ? THEN resolutions ELSE NULL END AS resolutions, byte_count, item_count, series_count, content_available FROM (SELECT h.summary, h.disclosures, h.resolutions, LENGTH(CAST(h.summary AS BLOB)) + LENGTH(CAST(h.disclosures AS BLOB)) + LENGTH(CAST(h.resolutions AS BLOB)) AS byte_count, h.item_count, h.series_count, CASE WHEN r.projection IS NULL OR b.content_available = 0 THEN 0 ELSE 1 END AS content_available FROM agent_result_headers h JOIN agent_results r ON r.id = h.id JOIN agent_bases b ON b.id = r.basis_id WHERE h.id = ? AND r.store_id = ? AND r.generation = ?)"
      )
      .get(
        page.maxDecodedBytes,
        page.maxDecodedBytes,
        page.maxDecodedBytes,
        handle.id,
        handle.storeId,
        handle.storeGeneration
      );

    if (raw === undefined) {
      throw agentError(
        "basis-content-unavailable",
        "The ordered computed view is not retained in this store"
      );
    }

    const header = pageHeaderRow(raw);

    if (header.content_available === 0) {
      throw agentError(
        "basis-content-unavailable",
        "The ordered computed view content is unavailable"
      );
    }

    if (
      page.position > header.item_count ||
      page.seriesPosition > header.series_count
    ) {
      throw agentError(
        "cursor-mismatch",
        "The page position is beyond the retained ordered view"
      );
    }

    if (
      header.summary === null ||
      header.disclosures === null ||
      header.resolutions === null ||
      header.byte_count > page.maxDecodedBytes
    ) {
      throw agentError(
        "budget-exhausted",
        "The byte budget cannot decode the mandatory summary, disclosures and reference resolutions"
      );
    }

    let decodedBytes = header.byte_count;

    const summary = agentDecoded(Schema.Json, header.summary);
    const resolutions = agentDecoded(resolutionsSchema, header.resolutions);

    const disclosures = agentDecoded(
      projectionSchema.fields.disclosures,
      header.disclosures
    );

    let factsExamined = 1;

    const readItems = (
      kind: "item" | "series",
      position: number,
      limit: number
    ): readonly Schema.Json[] => {
      const items: Schema.Json[] = [];
      const count = kind === "item" ? header.item_count : header.series_count;

      while (items.length < limit && position + items.length < count) {
        if (
          factsExamined >= page.maxFacts ||
          performance.now() - startedAt >= page.maxElapsedMs
        ) {
          break;
        }

        const row = context.db
          .prepare(
            "SELECT position, byte_count FROM agent_result_items WHERE result_id = ? AND kind = ? AND position = ?"
          )
          .get(handle.id, kind, position + items.length);

        if (row === undefined) {
          throw agentError(
            "basis-content-unavailable",
            "An indexed computed view row is unavailable"
          );
        }

        const item = pageItemRow(row);
        factsExamined += 1;

        if (decodedBytes + item.byte_count > page.maxDecodedBytes) {
          break;
        }

        const { body } = bodyRow(
          context.db
            .prepare(
              "SELECT body FROM agent_result_items WHERE result_id = ? AND kind = ? AND position = ?"
            )
            .get(handle.id, kind, item.position)
        );

        const actualBytes = Buffer.byteLength(body, "utf-8");

        if (actualBytes !== item.byte_count) {
          throw agentError(
            "basis-content-unavailable",
            "An indexed computed view row failed its byte integrity check"
          );
        }

        decodedBytes += actualBytes;
        items.push(agentDecoded(Schema.Json, body));
      }

      return items;
    };

    const items =
      page.axis === "series"
        ? []
        : readItems("item", page.position, page.maxItems);

    const series =
      page.axis === "items"
        ? []
        : readItems("series", page.seriesPosition, page.maxSeriesBuckets);

    return Schema.decodeUnknownSync(AgentResultPageSchema)({
      decodedBytes,
      factsExamined,
      nextPosition:
        page.position + items.length < header.item_count
          ? page.position + items.length
          : null,
      nextSeriesPosition:
        page.seriesPosition + series.length < header.series_count
          ? page.seriesPosition + series.length
          : null,
      resolutions,
      view: {
        disclosures,
        items,
        nextCursor: null,
        nextSeriesCursor: null,
        series,
        summary,
      },
    });
  };

  return {
    findResult: (basis, capability, queryDigest) =>
      context.read("agent.findResult", () => {
        const handle = findResultHandle(basis, capability, queryDigest);

        return handle === null ? null : readResult(handle);
      }),
    findResultMetadata: (basis, capability, queryDigest, maxDecodedBytes) =>
      context.read("agent.findResultMetadata", () => {
        const read = readMatchingResultHeader(
          basis,
          capability,
          queryDigest,
          maxDecodedBytes ?? 67_108_864
        );

        if (read.metadata === null && read.factsExamined > 0) {
          throw agentError(
            "budget-exhausted",
            "The byte budget cannot decode the retained result metadata"
          );
        }

        return read.metadata;
      }),
    getBasis: (handle) =>
      context.read("agent.getBasis", () => readBasis(handle)),
    getBasisMetadata: (handle, maxDecodedBytes) =>
      context.read("agent.getBasisMetadata", () =>
        readBasisHeader(handle, maxDecodedBytes)
      ),
    getCursor: (handle) =>
      context.read("agent.getCursor", () => {
        const read = readMeasuredCursor(handle, 67_108_864);

        if (read.cursor === null) {
          throw read.factsExamined === 0
            ? agentError(
                "cursor-mismatch",
                "The cursor is not present in this store"
              )
            : agentError(
                "budget-exhausted",
                "The byte budget cannot decode the retained cursor"
              );
        }

        return read.cursor;
      }),
    getResult: (handle) =>
      context.read("agent.getResult", () => readResult(handle)),
    getResultMetadata: (handle, maxDecodedBytes) =>
      context.read("agent.getResultMetadata", () =>
        readResultHeader(handle, maxDecodedBytes)
      ),
    latestBasis: (queryKey) =>
      context.read("agent.latestBasis", () => {
        const handle = latestBasisHandle(queryKey);

        return handle === null ? null : readBasis(handle);
      }),
    latestBasisForScope: (scope, maxDecodedBytes) =>
      context.read("agent.latestBasisForScope", () => {
        const read = readLatestBasisHeader(
          scope,
          maxDecodedBytes ?? 67_108_864
        );

        if (read.metadata === null && read.factsExamined > 0) {
          throw agentError(
            "budget-exhausted",
            "The byte budget cannot decode the retained basis metadata"
          );
        }

        return read.metadata;
      }),
    latestBasisMetadata: (queryKey, maxDecodedBytes) =>
      context.read("agent.latestBasisMetadata", () => {
        const handle = latestBasisHandle(queryKey);

        return handle === null
          ? null
          : readBasisHeader(handle, maxDecodedBytes);
      }),
    putBasis: (input) =>
      context.write("agent.putBasis", () => {
        const basis = Schema.decodeUnknownSync(AnalysisBasisSchema)(input);
        context.assertHandle(basis);
        const body = agentEncoded(AnalysisBasisSchema, basis);
        enforceAgentBytes(body, context.limits.maxBasisBytes);
        const digest = agentHash(canonicalAgentJson(basis));

        const previous = context.db
          .prepare(
            "SELECT body, content_available, content_digest FROM agent_bases WHERE id = ?"
          )
          .get(basis.id);

        if (previous !== undefined) {
          if (basisRow(previous).content_digest !== digest) {
            throw agentError(
              "idempotency-conflict",
              "The analysis basis identifier already binds different immutable content"
            );
          }

          return;
        }

        if (
          (basis.reproducibility === "retained-inputs" ||
            basis.retainedEvents.length > 0) &&
          agentHash(canonicalAgentJson(basis.retainedEvents)) !==
            basis.selectedEventDigest
        ) {
          throw agentError(
            "basis-incompatible",
            "The selected event digest does not match the retained raw observations"
          );
        }

        const eventIds = new Set<string>();
        const capture = captureSelection(basis);

        for (const event of basis.retainedEvents) {
          if (eventIds.has(event.eventId)) {
            throw agentError(
              "basis-incompatible",
              "The retained analysis basis contains a repeated event identifier"
            );
          }

          eventIds.add(event.eventId);

          const source = context.db
            .prepare("SELECT body, seq FROM events WHERE event_id = ?")
            .get(event.eventId);

          if (source === undefined) {
            throw agentError(
              "basis-content-unavailable",
              "A selected raw observation is absent from the source store"
            );
          }

          const selected = eventSourceRow(source);

          if (capture !== null && selected.seq > capture.upperSequence) {
            throw agentError(
              "basis-incompatible",
              "A retained observation arrived after the pinned event watermark"
            );
          }

          const original = agentDecoded(DxEventEnvelopeSchema, selected.body);

          if (capture !== null) {
            assertCapturedEvent(basis, capture.selector, original);

            if (capture.scope !== null) {
              assertScopedEvent(capture.scope, original);
            }
          }

          if (canonicalAgentJson(original) !== canonicalAgentJson(event)) {
            throw agentError(
              "basis-incompatible",
              "A retained observation differs from its immutable source event"
            );
          }
        }

        context.db
          .prepare(
            "INSERT INTO agent_bases (id, store_id, generation, query_key, repo_id, body, content_available, content_digest, scope_key, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)"
          )
          .run(
            basis.id,
            basis.storeId,
            basis.storeGeneration,
            basis.queryKey,
            basis.scope.repoId,
            body,
            digest,
            basisScopeKey(basis.scope),
            basis.createdAt
          );
        context.db
          .prepare("INSERT INTO agent_basis_headers (id, body) VALUES (?, ?)")
          .run(
            basis.id,
            agentEncoded(AnalysisBasisMetadataSchema, basisMetadata(basis))
          );

        for (const eventId of eventIds) {
          context.db
            .prepare(
              "INSERT INTO agent_basis_events (basis_id, event_id) VALUES (?, ?)"
            )
            .run(basis.id, eventId);
        }
      }),
    putCursor: (input) =>
      context.write("agent.putCursor", () => {
        const cursor = Schema.decodeUnknownSync(AgentCursorSchema)(input);
        context.assertHandle(cursor);
        const body = agentEncoded(AgentCursorSchema, cursor);

        const existing = context.db
          .prepare("SELECT body, epoch FROM agent_cursors WHERE id = ?")
          .get(cursor.id);

        if (existing !== undefined) {
          const row = cursorRow(existing);

          if (
            row.epoch !== context.epoch() ||
            canonicalAgentJson(agentDecoded(AgentCursorSchema, row.body)) !==
              canonicalAgentJson(cursor)
          ) {
            throw agentError(
              "cursor-mismatch",
              "The cursor identifier already binds another view or store epoch"
            );
          }

          return;
        }

        validateCursorView(cursor);

        if (
          cursor.kind === "work-continuation" &&
          cursor.storeRevision !== context.identity().revision
        ) {
          throw agentError(
            "cursor-mismatch",
            "The work continuation was created against another mutable store revision"
          );
        }

        context.db
          .prepare(
            "INSERT INTO agent_cursors (id, store_id, generation, epoch, body) VALUES (?, ?, ?, ?, ?)"
          )
          .run(
            cursor.id,
            cursor.storeId,
            cursor.storeGeneration,
            context.epoch(),
            body
          );
      }),
    putResult: (input) =>
      context.write("agent.putResult", () => {
        const result = Schema.decodeUnknownSync(AgentResultSchema)(input);
        context.assertHandle(result);
        const byteCount = Buffer.byteLength(result.orderedProjection, "utf-8");

        if (result.byteCount !== byteCount) {
          throw agentError(
            "basis-incompatible",
            "The computed view byte count differs from its retained ordered projection"
          );
        }

        const digest = agentHash(canonicalAgentJson(result));

        const previous = context.db
          .prepare(
            "SELECT body, projection, byte_count, content_digest FROM agent_results WHERE id = ?"
          )
          .get(result.id);

        if (previous !== undefined) {
          if (resultRow(previous).content_digest !== digest) {
            throw agentError(
              "idempotency-conflict",
              "The result identifier already binds different immutable content"
            );
          }

          return;
        }

        readBasisHeader({ ...result, id: result.basisId });

        const projection = agentDecoded(
          projectionSchema,
          result.orderedProjection
        );

        if (projection.items.length !== result.itemCount) {
          throw agentError(
            "basis-incompatible",
            "The computed view item count differs from its retained ordered projection"
          );
        }

        if (projection.series.length !== result.seriesCount) {
          throw agentError(
            "basis-incompatible",
            "The computed view series count differs from its retained ordered projection"
          );
        }

        const body = agentEncoded(AgentResultSchema, {
          ...result,
          orderedProjection: "",
          resolutions: [],
        });

        context.db
          .prepare(
            "INSERT INTO agent_results (id, store_id, generation, basis_id, capability, query_digest, projection_version, result_digest, body, projection, byte_count, content_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            result.id,
            result.storeId,
            result.storeGeneration,
            result.basisId,
            result.capability,
            result.queryDigest,
            result.projectionVersion,
            result.resultDigest,
            body,
            result.orderedProjection,
            byteCount,
            digest
          );

        const metadata = Schema.decodeUnknownSync(AgentResultMetadataSchema)(
          result
        );

        context.db
          .prepare(
            "INSERT INTO agent_result_headers (id, body, summary, disclosures, item_count, series_count, resolutions) VALUES (?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            result.id,
            agentEncoded(AgentResultMetadataSchema, metadata),
            canonicalAgentJson(projection.summary),
            canonicalAgentJson(projection.disclosures),
            projection.items.length,
            projection.series.length,
            canonicalAgentJson(result.resolutions)
          );

        for (const [kind, values] of [
          ["item", projection.items],
          ["series", projection.series],
        ] as const) {
          for (const [position, value] of values.entries()) {
            const itemBody = canonicalAgentJson(value);
            context.db
              .prepare(
                "INSERT INTO agent_result_items (result_id, kind, position, body, byte_count) VALUES (?, ?, ?, ?, ?)"
              )
              .run(
                result.id,
                kind,
                position,
                itemBody,
                Buffer.byteLength(itemBody, "utf-8")
              );
          }
        }

        trimProjections();
      }),
    readBasisMetadata: (handle, maxDecodedBytes) =>
      context.read("agent.readBasisMetadata", () =>
        readMeasuredBasisHeader(handle, maxDecodedBytes)
      ),
    readCursor: (handle, maxDecodedBytes) =>
      context.read("agent.readCursor", () =>
        readMeasuredCursor(handle, maxDecodedBytes)
      ),
    readLatestBasisMetadataForScope: (scope, maxDecodedBytes) =>
      context.read("agent.readLatestBasisMetadataForScope", () =>
        readLatestBasisHeader(scope, maxDecodedBytes)
      ),
    readMatchingResultMetadata: (
      basis,
      capability,
      queryDigest,
      maxDecodedBytes
    ) =>
      context.read("agent.readMatchingResultMetadata", () =>
        readMatchingResultHeader(
          basis,
          capability,
          queryDigest,
          maxDecodedBytes
        )
      ),
    readResultMetadata: (handle, maxDecodedBytes) =>
      context.read("agent.readResultMetadata", () =>
        readMeasuredResultHeader(handle, maxDecodedBytes)
      ),
    readResultPage: (handle, input) =>
      context.read("agent.readResultPage", () => readPage(handle, input)),
  };
};

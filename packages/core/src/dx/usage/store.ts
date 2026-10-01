import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";

import {
  Context,
  DateTime,
  Effect,
  Layer,
  Ref,
  Schema,
  Semaphore,
} from "effect";

import { StoreError } from "../contracts/error-store-error.js";
import { EventStore } from "../contracts/event-store.js";
import type { StoreFailure } from "../contracts/services.js";
import { DxEventEnvelopeSchema } from "../model/event.js";
import type { DxEventEnvelope } from "../model/event.js";
import { usageOfRows } from "./derive.js";
import type {
  DerivedRows,
  DerivedUsage,
  UsageDisagreement,
  UsageFact,
} from "./fact.js";
import {
  USAGE_DERIVATION_VERSION,
  UsageDisagreementSchema,
  UsageFactSchema,
} from "./fact.js";
import { NONE_VALUE, isSessionFigure, sessionKeyOf } from "./query.js";
import type { UsageFilters } from "./query.js";
import { UnionFind } from "./union-find.js";

export interface DisagreementCount {
  readonly count: number;
  readonly field: string;
  readonly tool: string | null;
}

export interface UsageSource {
  readonly derive: (
    events: readonly DxEventEnvelope[]
  ) => Effect.Effect<DerivedRows, StoreFailure>;
  readonly everything: Effect.Effect<readonly DxEventEnvelope[], StoreFailure>;
}

export interface FactSelection {
  readonly filters: UsageFilters;
  readonly sinceMs: number | null;
  readonly untilMs: number | null;
}

export interface UsageSummary {
  readonly builtAt: string | null;
  readonly facts: number;
  readonly tools: readonly string[];
  readonly unresolved: number;
}

export interface UsageFactStoreApi {
  readonly disagreements: Effect.Effect<
    readonly DisagreementCount[],
    StoreFailure
  >;
  readonly refresh: (source: UsageSource) => Effect.Effect<void, StoreFailure>;
  readonly select: (
    selection: FactSelection
  ) => Effect.Effect<readonly UsageFact[], StoreFailure>;
  readonly summary: Effect.Effect<UsageSummary, StoreFailure>;
}

export interface UsageStoreOptions {
  readonly batchEvents?: number;
}

const DEFAULT_BATCH_EVENTS = 20_000;

const decodeFact = Schema.decodeUnknownSync(
  Schema.fromJsonString(UsageFactSchema)
);

const decodeEvent = Schema.decodeUnknownSync(
  Schema.fromJsonString(DxEventEnvelopeSchema)
);

const decodeMetaRow = Schema.decodeUnknownSync(
  Schema.Struct({ key: Schema.String, value: Schema.String })
);

const decodeBodyRow = Schema.decodeUnknownSync(
  Schema.Struct({ body: Schema.String })
);

const decodeMemberRow = Schema.decodeUnknownSync(
  Schema.Struct({ body: Schema.String, component: Schema.Int })
);

const decodeComponentRow = Schema.decodeUnknownSync(
  Schema.Struct({ component: Schema.Int })
);

const decodeSizeRow = Schema.decodeUnknownSync(
  Schema.Struct({ component: Schema.Int, n: Schema.Int })
);

const decodeMemberSeqRow = Schema.decodeUnknownSync(
  Schema.Struct({ component: Schema.Int, seq: Schema.Int })
);

const decodeMarkRow = Schema.decodeUnknownSync(
  Schema.Struct({ n: Schema.Int, top: Schema.NullOr(Schema.Int) })
);

const decodeCountOnly = Schema.decodeUnknownSync(
  Schema.Struct({ n: Schema.Int })
);

const decodeHarnessRow = Schema.decodeUnknownSync(
  Schema.Struct({ harness: Schema.String })
);

const decodeCountRow = Schema.decodeUnknownSync(
  Schema.Struct({
    field: Schema.String,
    harness: Schema.NullOr(Schema.String),
    n: Schema.Int,
  })
);

const LINK_FIELDS = {
  i1: "$.identity.requestId",
  i2: "$.identity.generationId",
  i3: "$.usage.requestKey",
  i4: "$.payload.replacesRequestKey",
  s1: "$.identity.sessionId",
  s2: "$.ai.sessionId",
  s3: "$.ai.parentSessionId",
  s4: "$.payload.parentSessionId",
  t1: "$.payload.toolCallId",
  t2: "$.payload.parentToolCallId",
  worktree: "$.context.worktreePath",
} as const;

type LinkField = keyof typeof LINK_FIELDS;

const LINK_NAMESPACES: readonly (readonly [string, readonly LinkField[]])[] = [
  ["s", ["s1", "s2", "s3", "s4"]],
  ["i", ["i1", "i2", "i3", "i4"]],
  ["t", ["t1", "t2"]],
];

const Extracted = Schema.NullOr(Schema.String);

const decodeLinkRow = Schema.decodeUnknownSync(
  Schema.Struct({
    i1: Extracted,
    i2: Extracted,
    i3: Extracted,
    i4: Extracted,
    kind: Schema.String,
    s1: Extracted,
    s2: Extracted,
    s3: Extracted,
    s4: Extracted,
    seq: Schema.Int,
    t1: Extracted,
    t2: Extracted,
    worktree: Extracted,
  })
);

type LinkRow = ReturnType<typeof decodeLinkRow>;

const textOf = (value: string | null): string | null => {
  const text = value?.trim() ?? "";

  return text === "" ? null : text;
};

const linkKeysOf = (row: LinkRow): readonly string[] =>
  LINK_NAMESPACES.flatMap(([namespace, fields]) =>
    fields.flatMap((field) => {
      const value = textOf(row[field]);

      return value === null ? [] : [`${namespace}:${value}`];
    })
  );

const LINK_SELECT = `SELECT seq, kind, ${Object.entries(LINK_FIELDS)
  .map(
    ([name, path]) =>
      `CASE WHEN json_type(body, '${path}') = 'text' THEN json_extract(body, '${path}') END AS ${name}`
  )
  .join(", ")} FROM events WHERE seq > ? ORDER BY seq`;

const CONTEXT_KIND = "git.observation";

const COMPONENT_TABLES = [
  "usage_facts",
  "usage_disagreements",
  "usage_members",
  "usage_links",
  "usage_unresolved",
] as const;

const KEYED_COMPONENT_TABLES = ["usage_worktrees", "usage_dirty"] as const;

const USAGE_TABLES = [...COMPONENT_TABLES, ...KEYED_COMPONENT_TABLES] as const;

const encodeFact = Schema.encodeSync(Schema.fromJsonString(UsageFactSchema));

const encodeDisagreement = Schema.encodeSync(
  Schema.fromJsonString(UsageDisagreementSchema)
);

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

const attempt = <A>(
  operation: string,
  body: () => A
): Effect.Effect<A, StoreFailure> =>
  Effect.try({
    catch: (cause) =>
      Schema.is(StoreError)(cause)
        ? cause
        : new StoreError({ message: messageOf(cause), operation }),
    try: body,
  });

const trimmedPath = (path: string): string => path.replace(/\/+$/u, "");

const storedEventId = (eventId: string): string =>
  eventId.replace(/#split:\d+\/\d+$/u, "");

export const countDisagreements = (
  rows: readonly UsageDisagreement[]
): readonly DisagreementCount[] => {
  const counts = new Map<string, DisagreementCount>();

  for (const row of rows) {
    const key = `${row.harness ?? ""}|${row.field}`;
    const seen = counts.get(key);

    counts.set(key, {
      count: (seen?.count ?? 0) + 1,
      field: row.field,
      tool: row.harness,
    });
  }

  return [...counts.values()].toSorted(
    (a, b) =>
      (a.tool ?? "").localeCompare(b.tool ?? "") ||
      a.field.localeCompare(b.field)
  );
};

interface LinkState {
  readonly builtAt: string | null;
  readonly count: number;
  readonly epoch: number;
  readonly next: number;
  readonly seq: number;
  readonly version: number;
}

interface Mark {
  readonly count: number;
  readonly top: number;
}

interface Batch {
  readonly components: readonly number[];
  readonly epoch: number;
  readonly events: readonly DxEventEnvelope[];
  readonly owner: ReadonlyMap<string, number>;
}

const numberOr = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);

  return value === undefined || Number.isNaN(parsed) ? fallback : parsed;
};

const byStoreOrder = (a: DxEventEnvelope, b: DxEventEnvelope): number => {
  const at = a.occurredAt ?? a.observedAt;
  const bt = b.occurredAt ?? b.observedAt;

  if (at !== bt) {
    return at < bt ? -1 : 1;
  }

  if (a.eventId === b.eventId) {
    return 0;
  }

  return a.eventId < b.eventId ? -1 : 1;
};

interface Clause {
  readonly params: readonly SQLInputValue[];
  readonly sql: string;
}

const filterClause = (column: string, values: readonly string[]): Clause => {
  const named = values.filter((value) => value !== NONE_VALUE);

  const parts = [
    ...(named.length === 0
      ? []
      : [`${column} IN (${named.map(() => "?").join(", ")})`]),
    ...(values.includes(NONE_VALUE) ? [`${column} IS NULL`] : []),
  ];

  return { params: named, sql: `(${parts.join(" OR ")})` };
};

const SQL_FILTERS = [
  ["tool", "harness"],
  ["repo", "repo"],
  ["branch", "branch"],
  ["scope", "scope"],
] as const;

const selectionQuery = (selection: FactSelection): Clause => {
  const { sinceMs, untilMs } = selection;

  const narrowing: readonly Clause[] = [
    ...(sinceMs === null
      ? []
      : [{ params: [sinceMs], sql: "occurred_ms >= ?" }]),
    ...(untilMs === null
      ? []
      : [{ params: [untilMs], sql: "occurred_ms < ?" }]),
    ...SQL_FILTERS.flatMap(([dimension, column]) => {
      const values = selection.filters[dimension];

      return values === undefined || values.length === 0
        ? []
        : [filterClause(column, values)];
    }),
  ];

  const matching =
    narrowing.length === 0
      ? "1"
      : narrowing.map((clause) => clause.sql).join(" AND ");

  return {
    params: [
      sinceMs,
      sinceMs,
      untilMs,
      untilMs,
      ...narrowing.flatMap((clause) => clause.params),
    ],
    sql: [
      "WITH figures AS (SELECT DISTINCT session_key FROM usage_facts WHERE figure = 1 AND session_key IS NOT NULL),",
      "spans AS (SELECT session_key, MIN(occurred_ms) AS f, MAX(occurred_ms) AS t FROM usage_facts WHERE figure = 0 AND session_key IN (SELECT session_key FROM figures) GROUP BY session_key),",
      "open AS (SELECT session_key FROM spans WHERE f IS NOT NULL AND (? IS NULL OR t >= ?) AND (? IS NULL OR f < ?)),",
      "closed AS (SELECT session_key FROM spans WHERE f IS NOT NULL AND session_key NOT IN (SELECT session_key FROM open))",
      "SELECT body FROM usage_facts WHERE (figure = 0 AND occurred_ms IS NULL)",
      "OR (figure = 1 AND (session_key IS NULL OR session_key NOT IN (SELECT session_key FROM closed)))",
      "OR (figure = 0 AND session_key IN (SELECT session_key FROM open))",
      `OR (figure = 0 AND ${matching})`,
      "ORDER BY occurred_ms, fact_id",
    ].join(" "),
  };
};

interface AddedEvent {
  readonly context: boolean;
  readonly key: string | null;
  readonly seq: number;
  readonly worktree: string | null;
}

interface Scan {
  readonly added: readonly AddedEvent[];
  readonly sets: UnionFind;
}

const worktreeOf = (row: LinkRow): string | null => {
  const path = textOf(row.worktree);

  return path === null ? null : trimmedPath(path);
};

const existingByRoot = (sets: UnionFind): ReadonlyMap<string, number[]> => {
  const existing = new Map<string, number[]>();

  for (const node of sets.nodes()) {
    if (node.startsWith("c:")) {
      const root = sets.find(node);
      const list = existing.get(root) ?? [];

      list.push(Number(node.slice(2)));
      existing.set(
        root,
        list.toSorted((a, b) => a - b)
      );
    }
  }

  return existing;
};

const isCurrent = (state: LinkState, mark: Mark): boolean =>
  state.version === USAGE_DERIVATION_VERSION &&
  state.count === mark.count &&
  state.seq === mark.top;

const internPool = (): ((fact: UsageFact) => UsageFact) => {
  const texts = new Map<string, string>();
  const channels = new Map<string, readonly string[]>();

  const shared = (value: string): string => {
    const known = texts.get(value);

    if (known !== undefined) {
      return known;
    }

    texts.set(value, value);

    return value;
  };

  const text = (value: string | null): string | null =>
    value === null ? null : shared(value);

  return (fact) => {
    const key = fact.channels.join("\n");
    const list = channels.get(key) ?? fact.channels;

    channels.set(key, list);

    return {
      ...fact,
      agent: text(fact.agent),
      branch: text(fact.branch),
      channels: list,
      effort: text(fact.effort),
      harnessVersion: text(fact.harnessVersion),
      model: text(fact.model),
      modelRaw: text(fact.modelRaw),
      parentSession: text(fact.parentSession),
      repo: shared(fact.repo),
      serviceTier: text(fact.serviceTier),
      session: text(fact.session),
      speed: text(fact.speed),
      splitOf: text(fact.splitOf),
      via: text(fact.via),
      worktree: text(fact.worktree),
    };
  };
};

const sqliteUsageStore = (
  db: DatabaseSync,
  batchEvents: number,
  lock: Semaphore.Semaphore
): UsageFactStoreApi => {
  db.exec(
    "CREATE TEMP TABLE IF NOT EXISTS usage_batch (component INTEGER PRIMARY KEY)"
  );

  const transaction = <A>(body: () => A): A => {
    db.exec("BEGIN IMMEDIATE");

    try {
      const result = body();
      db.exec("COMMIT");

      return result;
    } catch (error) {
      if (db.isTransaction) {
        db.exec("ROLLBACK");
      }

      throw error;
    }
  };

  const readState = (): LinkState => {
    const meta = new Map(
      db
        .prepare("SELECT key, value FROM usage_meta")
        .all()
        .map((raw) => {
          const row = decodeMetaRow(raw);

          return [row.key, row.value] as const;
        })
    );

    return {
      builtAt: meta.get("builtAt") ?? null,
      count: numberOr(meta.get("count"), 0),
      epoch: numberOr(meta.get("epoch"), 0),
      next: numberOr(meta.get("next"), 1),
      seq: numberOr(meta.get("seq"), 0),
      version: numberOr(meta.get("version"), -1),
    };
  };

  const writeState = (state: LinkState): void => {
    const put = db.prepare(
      "INSERT OR REPLACE INTO usage_meta (key, value) VALUES (?, ?)"
    );

    for (const [key, value] of Object.entries(state)) {
      if (value !== null) {
        put.run(key, String(value));
      }
    }
  };

  const markOf = (): Mark => {
    const row = decodeMarkRow(
      db.prepare("SELECT COUNT(*) AS n, MAX(seq) AS top FROM events").get()
    );

    return { count: row.n, top: row.top ?? 0 };
  };

  const relabel = (from: number, to: number): void => {
    for (const table of COMPONENT_TABLES) {
      db.prepare(`UPDATE ${table} SET component = ? WHERE component = ?`).run(
        to,
        from
      );
    }

    for (const table of KEYED_COMPONENT_TABLES) {
      db.prepare(
        `UPDATE OR IGNORE ${table} SET component = ? WHERE component = ?`
      ).run(to, from);
      db.prepare(`DELETE FROM ${table} WHERE component = ?`).run(from);
    }
  };

  const forgetDeleted = (dirty: Set<number>): void => {
    const gone = db
      .prepare(
        "SELECT m.seq AS seq, m.component AS component FROM usage_members m WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.seq = m.seq)"
      )
      .all()
      .map((raw) => decodeMemberSeqRow(raw));

    const drop = db.prepare("DELETE FROM usage_members WHERE seq = ?");

    for (const row of gone) {
      dirty.add(row.component);
      drop.run(row.seq);
    }
  };

  const scanAdded = (after: number): Scan => {
    const sets = new UnionFind();
    const looked = new Set<string>();
    const paths = new Map<string, string>();
    const added: AddedEvent[] = [];

    const hasLinks =
      decodeCountOnly(
        db.prepare("SELECT EXISTS (SELECT 1 FROM usage_links) AS n").get()
      ).n === 1;

    const lookup = db.prepare(
      "SELECT component FROM usage_links WHERE link = ?"
    );

    const known = (key: string): void => {
      if (!hasLinks || looked.has(key)) {
        return;
      }

      looked.add(key);

      const hit = lookup.get(key);

      if (hit !== undefined) {
        const node = `c:${String(decodeComponentRow(hit).component)}`;
        sets.add(node);
        sets.union(key, node);
      }
    };

    for (const raw of db.prepare(LINK_SELECT).iterate(after)) {
      const row = decodeLinkRow(raw);
      const keys = linkKeysOf(row);
      const [head] = keys;

      for (const key of keys) {
        sets.add(key);
        sets.union(key, head ?? key);
        known(key);
      }

      const path = worktreeOf(row);
      const worktree = path === null ? null : (paths.get(path) ?? path);

      if (worktree !== null) {
        paths.set(worktree, worktree);
      }

      added.push({
        context: row.kind === CONTEXT_KIND,
        key: head ?? null,
        seq: row.seq,
        worktree,
      });
    }

    return { added, sets };
  };

  const linkNew = (state: LinkState, dirty: Set<number>): number => {
    const { added, sets } = scanAdded(state.seq);
    const existing = existingByRoot(sets);
    const chosen = new Map<string, number>();
    let { next } = state;

    const fresh = (): number => {
      const id = next;
      next += 1;

      return id;
    };

    const componentOf = (root: string): number => {
      const known = chosen.get(root);

      if (known !== undefined) {
        return known;
      }

      const [first, ...rest] = existing.get(root) ?? [];
      const id = first ?? fresh();

      for (const other of rest) {
        relabel(other, id);
        dirty.delete(other);
      }

      dirty.add(id);
      chosen.set(root, id);

      return id;
    };

    const member = db.prepare(
      "INSERT OR REPLACE INTO usage_members (seq, component) VALUES (?, ?)"
    );

    const place = db.prepare(
      "INSERT OR IGNORE INTO usage_worktrees (worktree, component) VALUES (?, ?)"
    );

    const observed = new Set<string>();

    for (const event of added) {
      const id =
        event.key === null ? fresh() : componentOf(sets.find(event.key));

      member.run(event.seq, id);
      dirty.add(id);

      if (event.worktree !== null && event.context) {
        observed.add(event.worktree);
      } else if (event.worktree !== null) {
        place.run(event.worktree, id);
      }
    }

    const link = db.prepare(
      "INSERT OR REPLACE INTO usage_links (link, component) VALUES (?, ?)"
    );

    for (const node of sets.nodes()) {
      if (!node.startsWith("c:")) {
        link.run(node, componentOf(sets.find(node)));
      }
    }

    const touching = db.prepare(
      "SELECT component FROM usage_worktrees WHERE worktree = ?"
    );

    for (const worktree of observed) {
      for (const raw of touching.all(worktree)) {
        dirty.add(decodeComponentRow(raw).component);
      }
    }

    return next;
  };

  const link = (): void => {
    if (isCurrent(readState(), markOf())) {
      return;
    }

    transaction(() => {
      const before = readState();
      const mark = markOf();

      if (isCurrent(before, mark)) {
        return;
      }

      const stale = before.version !== USAGE_DERIVATION_VERSION;

      if (stale) {
        for (const table of [...USAGE_TABLES, "usage_meta"]) {
          db.exec(`DELETE FROM ${table}`);
        }
      }

      const state: LinkState = stale
        ? {
            builtAt: null,
            count: 0,
            epoch: before.epoch,
            next: 1,
            seq: 0,
            version: USAGE_DERIVATION_VERSION,
          }
        : before;

      const dirty = new Set<number>();

      const added = decodeCountOnly(
        db
          .prepare("SELECT COUNT(*) AS n FROM events WHERE seq > ?")
          .get(state.seq)
      ).n;

      if (mark.count !== state.count + added) {
        forgetDeleted(dirty);
      }

      const next = linkNew(state, dirty);

      const flag = db.prepare(
        "INSERT OR IGNORE INTO usage_dirty (component) VALUES (?)"
      );

      for (const id of dirty) {
        flag.run(id);
      }

      writeState({
        ...state,
        count: mark.count,
        epoch: state.epoch + 1,
        next,
        seq: mark.top,
      });
    });
  };

  const contextEvents = (): readonly DxEventEnvelope[] =>
    db
      .prepare("SELECT body FROM events WHERE kind = ?")
      .all(CONTEXT_KIND)
      .map((raw) => decodeEvent(decodeBodyRow(raw).body));

  const nextBatch = (
    context: () => readonly DxEventEnvelope[]
  ): Batch | null => {
    const { epoch } = readState();

    const sizes = db
      .prepare(
        "SELECT d.component AS component, COUNT(m.seq) AS n FROM usage_dirty d LEFT JOIN usage_members m ON m.component = d.component GROUP BY d.component ORDER BY d.component"
      )
      .all()
      .map((raw) => decodeSizeRow(raw));

    if (sizes.length === 0) {
      return null;
    }

    const components: number[] = [];
    let total = 0;

    for (const size of sizes) {
      if (components.length > 0 && total + size.n > batchEvents) {
        break;
      }

      components.push(size.component);
      total += size.n;
    }

    db.exec("DELETE FROM temp.usage_batch");

    const put = db.prepare(
      "INSERT INTO temp.usage_batch (component) VALUES (?)"
    );

    for (const id of components) {
      put.run(id);
    }

    const owner = new Map<string, number>();
    const byId = new Map<string, DxEventEnvelope>();

    for (const raw of db
      .prepare(
        "SELECT e.body AS body, m.component AS component FROM temp.usage_batch b JOIN usage_members m ON m.component = b.component JOIN events e ON e.seq = m.seq"
      )
      .iterate()) {
      const row = decodeMemberRow(raw);
      const event = decodeEvent(row.body);

      owner.set(event.eventId, row.component);
      byId.set(event.eventId, event);
    }

    if (byId.size > 0) {
      for (const event of context()) {
        if (!byId.has(event.eventId)) {
          byId.set(event.eventId, event);
        }
      }
    }

    return {
      components,
      epoch,
      events: [...byId.values()].toSorted(byStoreOrder),
      owner,
    };
  };

  const write = (batch: Batch, derived: DerivedRows, builtAt: string) =>
    transaction(() => {
      const state = readState();

      if (state.epoch !== batch.epoch) {
        return false;
      }

      const [fallback = 0] = batch.components;
      const merged = new UnionFind();

      for (const id of batch.components) {
        merged.add(String(id));
      }

      const ownersOf = (sources: readonly string[]): number[] => [
        ...new Set(
          sources.flatMap((source) => {
            const id = batch.owner.get(storedEventId(source));

            return id === undefined ? [] : [id];
          })
        ),
      ];

      for (const row of derived.rows) {
        const [head, ...rest] = ownersOf(row.sources);

        for (const other of rest) {
          if (head !== undefined) {
            merged.union(String(other), String(head));
          }
        }
      }

      const target = new Map<number, number>();

      for (const id of batch.components) {
        const root = merged.find(String(id));

        const smallest = Math.min(
          ...batch.components.filter(
            (other) => merged.find(String(other)) === root
          )
        );

        target.set(id, smallest);

        if (smallest !== id) {
          relabel(id, smallest);
        }
      }

      const finalOf = (id: number | undefined): number =>
        target.get(id ?? fallback) ?? fallback;

      for (const table of [
        "usage_facts",
        "usage_disagreements",
        "usage_unresolved",
        "usage_dirty",
      ] as const) {
        const clear = db.prepare(`DELETE FROM ${table} WHERE component = ?`);

        for (const id of new Set(target.values())) {
          clear.run(id);
        }
      }

      const fact = db.prepare(
        "INSERT OR REPLACE INTO usage_facts (fact_id, component, harness, repo, branch, scope, session_key, figure, occurred_ms, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      );

      const place = db.prepare(
        "INSERT OR IGNORE INTO usage_worktrees (worktree, component) VALUES (?, ?)"
      );

      const factComponent = new Map<string, number>();

      for (const row of derived.rows) {
        const item = row.fact;
        const id = finalOf(ownersOf(row.sources)[0]);

        factComponent.set(item.factId, id);
        fact.run(
          item.factId,
          id,
          item.harness,
          item.repo,
          item.branch,
          item.scope,
          sessionKeyOf(item),
          isSessionFigure(item) ? 1 : 0,
          item.occurredMs,
          encodeFact(item)
        );

        if (item.worktree !== null) {
          place.run(trimmedPath(item.worktree), id);
        }
      }

      const disagreement = db.prepare(
        "INSERT OR REPLACE INTO usage_disagreements (fact_id, component, harness, field, body) VALUES (?, ?, ?, ?, ?)"
      );

      for (const item of derived.disagreements) {
        disagreement.run(
          item.factId,
          factComponent.get(item.factId) ?? fallback,
          item.harness,
          item.field,
          encodeDisagreement(item)
        );
      }

      const unresolved = db.prepare(
        "INSERT OR REPLACE INTO usage_unresolved (event_id, component) VALUES (?, ?)"
      );

      for (const eventId of derived.unresolved) {
        unresolved.run(eventId, finalOf(batch.owner.get(eventId)));
      }

      writeState({ ...state, builtAt });

      return true;
    });

  return {
    disagreements: attempt("usage.disagreements", () =>
      db
        .prepare(
          "SELECT harness, field, COUNT(*) AS n FROM usage_disagreements GROUP BY harness, field ORDER BY harness, field"
        )
        .all()
        .map((raw) => {
          const row = decodeCountRow(raw);

          return { count: row.n, field: row.field, tool: row.harness };
        })
    ),
    refresh: (source) =>
      Semaphore.withPermits(
        lock,
        1
      )(
        Effect.gen(function* refreshUsage() {
          let context: readonly DxEventEnvelope[] | null = null;

          const contextOnce = (): readonly DxEventEnvelope[] => {
            context ??= contextEvents();

            return context;
          };

          for (;;) {
            yield* attempt("usage.link", link);

            const batch = yield* attempt("usage.batch", () =>
              nextBatch(contextOnce)
            );

            if (batch === null) {
              return;
            }

            const derived = yield* source.derive(batch.events);
            const builtAt = DateTime.formatIso(yield* DateTime.now);

            yield* attempt("usage.write", () => write(batch, derived, builtAt));
          }
        })
      ),
    select: (selection) =>
      attempt("usage.select", () => {
        const query = selectionQuery(selection);
        const facts: UsageFact[] = [];
        const shared = internPool();

        for (const raw of db.prepare(query.sql).iterate(...query.params)) {
          facts.push(shared(decodeFact(decodeBodyRow(raw).body)));
        }

        return facts;
      }),
    summary: attempt("usage.summary", () => {
      const state = readState();

      return {
        builtAt: state.builtAt,
        facts: decodeCountOnly(
          db.prepare("SELECT COUNT(*) AS n FROM usage_facts").get()
        ).n,
        tools: db
          .prepare(
            "SELECT DISTINCT harness FROM usage_facts WHERE harness IS NOT NULL ORDER BY harness"
          )
          .all()
          .map((raw) => decodeHarnessRow(raw).harness),
        unresolved: decodeCountOnly(
          db.prepare("SELECT COUNT(*) AS n FROM usage_unresolved").get()
        ).n,
      };
    }),
  };
};

interface MemoryState {
  readonly builtAt: string | null;
  readonly derived: DerivedUsage | null;
}

const memoryUsageStore = (state: Ref.Ref<MemoryState>): UsageFactStoreApi => ({
  disagreements: Ref.get(state).pipe(
    Effect.map((current) =>
      countDisagreements(current.derived?.disagreements ?? [])
    )
  ),
  refresh: (source) =>
    Effect.gen(function* refreshMemory() {
      const events = yield* source.everything;
      const derived = usageOfRows(yield* source.derive(events));
      const builtAt = DateTime.formatIso(yield* DateTime.now);

      yield* Ref.set(state, { builtAt, derived });
    }),
  select: () =>
    Ref.get(state).pipe(Effect.map((current) => current.derived?.facts ?? [])),
  summary: Ref.get(state).pipe(
    Effect.map((current) => {
      const facts = current.derived?.facts ?? [];

      return {
        builtAt: current.builtAt,
        facts: facts.length,
        tools: [
          ...new Set(
            facts.flatMap((fact) =>
              fact.harness === null ? [] : [fact.harness]
            )
          ),
        ].toSorted(),
        unresolved: current.derived?.unresolved ?? 0,
      };
    })
  ),
});

export class UsageFactStore extends Context.Service<
  UsageFactStore,
  UsageFactStoreApi
>()("@rat-stack/core/dx/UsageFactStore") {
  static readonly sqlite = (
    path: string,
    options: UsageStoreOptions = {}
  ): Layer.Layer<UsageFactStore, StoreFailure, EventStore> =>
    Layer.effect(
      this,
      Effect.gen(function* openUsageStore() {
        yield* EventStore;

        const db = yield* Effect.acquireRelease(
          attempt(
            "usage.open",
            () => new DatabaseSync(path, { timeout: 5000 })
          ),
          (opened) =>
            Effect.sync(() => {
              opened.close();
            })
        );

        const lock = yield* Semaphore.make(1);

        return yield* attempt("usage.open", () =>
          sqliteUsageStore(
            db,
            options.batchEvents ?? DEFAULT_BATCH_EVENTS,
            lock
          )
        );
      })
    );

  static readonly memory: Layer.Layer<UsageFactStore> = Layer.effect(
    this,
    Effect.map(
      Ref.make<MemoryState>({ builtAt: null, derived: null }),
      memoryUsageStore
    )
  );
}

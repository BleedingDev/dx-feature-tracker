import { Schema } from "effect";

export const SCHEMA_SQL =
  "SELECT m.name AS tableName, p.name AS columnName FROM sqlite_master m JOIN pragma_table_info(m.name) p WHERE m.type = 'table' AND m.name IN ('session_v2', 'session', 'session_message', 'message', 'part')";

export const SchemaRowSchema = Schema.Struct({
  columnName: Schema.String,
  tableName: Schema.String,
});

export type SchemaRow = typeof SchemaRowSchema.Type;

export const BodyRowSchema = Schema.Struct({
  body: Schema.String,
  kind: Schema.String,
});

export type BodyRow = typeof BodyRowSchema.Type;

export type TableColumns = ReadonlyMap<string, ReadonlySet<string>>;

export const tableColumns = (rows: readonly SchemaRow[]): TableColumns => {
  const tables = new Map<string, Set<string>>();

  for (const row of rows) {
    const columns = tables.get(row.tableName) ?? new Set<string>();
    columns.add(row.columnName);
    tables.set(row.tableName, columns);
  }

  return tables;
};

const has = (tables: TableColumns, table: string, ...columns: string[]) => {
  const found = tables.get(table);

  return found !== undefined && columns.every((column) => found.has(column));
};

const column = (tables: TableColumns, table: string, name: string) =>
  has(tables, table, name) ? name : "NULL";

const tokenColumns = (tables: TableColumns, table: string) =>
  has(
    tables,
    table,
    "tokens_input",
    "tokens_output",
    "tokens_reasoning",
    "tokens_cache_read",
    "tokens_cache_write"
  )
    ? "json_object('input', tokens_input, 'output', tokens_output, 'reasoning', tokens_reasoning, 'cacheRead', tokens_cache_read, 'cacheWrite', tokens_cache_write)"
    : "NULL";

const SESSION_CORE = ["id", "directory", "time_created"];

const sessionSelect = (
  tables: TableColumns,
  table: "session_v2" | "session"
) => {
  const col = (name: string) => column(tables, table, name);

  return `SELECT 'session' AS kind, json_object('table', '${table}', 'id', id, 'parentId', ${col("parent_id")}, 'forkOf', ${col("fork_session_id")}, 'forkBoundary', ${col("fork_boundary")}, 'directory', directory, 'title', ${col("title")}, 'version', ${col("version")}, 'agent', ${col("agent")}, 'model', ${col("model")}, 'cost', ${col("cost")}, 'tokens', ${tokenColumns(tables, table)}, 'created', time_created, 'updated', ${col("time_updated")}, 'archived', ${col("time_archived")}) AS body FROM ${table}`;
};

const TOOL_PATH =
  "coalesce(json_extract(c.value, '$.state.input.filePath'), json_extract(c.value, '$.state.input.path'), json_extract(c.value, '$.state.input.workdir'))";

const V2_PATHS = `(SELECT json_group_array(p) FROM (SELECT ${TOOL_PATH} AS p FROM json_each(session_message.data, '$.content') c WHERE json_valid(session_message.data) AND json_extract(c.value, '$.type') = 'tool') WHERE p LIKE '/%')`;

const V2_TYPES =
  "('user', 'assistant', 'compaction', 'location-switched', 'model-switched', 'agent-switched')";

const v2MessageSelect = () =>
  `SELECT 'message' AS kind, json_object('table', 'session_message', 'id', id, 'sessionId', session_id, 'seq', seq, 'type', type, 'created', time_created, 'updated', time_updated, 'agent', json_extract(data, '$.agent'), 'model', json_extract(data, '$.model'), 'cost', json_extract(data, '$.cost'), 'tokens', json_extract(data, '$.tokens'), 'error', json_extract(data, '$.error.type'), 'finish', json_extract(data, '$.finish'), 'completed', json_extract(data, '$.time.completed'), 'directory', json_extract(data, '$.location.directory'), 'previousDirectory', json_extract(data, '$.previous.location.directory'), 'status', json_extract(data, '$.status'), 'paths', CASE WHEN type = 'assistant' THEN ${V2_PATHS} ELSE NULL END) AS body FROM session_message WHERE json_valid(data) AND type IN ${V2_TYPES}`;

const V1_TOOL_PATH =
  "coalesce(json_extract(part.data, '$.state.input.filePath'), json_extract(part.data, '$.state.input.path'), json_extract(part.data, '$.state.input.workdir'))";

const v1Paths = (tables: TableColumns) =>
  has(tables, "part", "message_id", "data")
    ? `(SELECT json_group_array(p) FROM (SELECT ${V1_TOOL_PATH} AS p FROM part WHERE part.message_id = message.id AND json_valid(part.data) AND json_extract(part.data, '$.type') = 'tool') WHERE p LIKE '/%')`
    : "NULL";

const v1MessageSelect = (tables: TableColumns) =>
  `SELECT 'message' AS kind, json_object('table', 'message', 'id', id, 'sessionId', session_id, 'seq', NULL, 'type', json_extract(data, '$.role'), 'created', time_created, 'updated', ${column(tables, "message", "time_updated")}, 'agent', coalesce(json_extract(data, '$.agent'), json_extract(data, '$.mode')), 'model', CASE WHEN json_extract(data, '$.modelID') IS NULL THEN json_extract(data, '$.model') ELSE json_object('id', json_extract(data, '$.modelID'), 'providerID', json_extract(data, '$.providerID'), 'variant', json_extract(data, '$.variant')) END, 'cost', json_extract(data, '$.cost'), 'tokens', json_extract(data, '$.tokens'), 'error', json_extract(data, '$.error.name'), 'finish', json_extract(data, '$.finish'), 'completed', json_extract(data, '$.time.completed'), 'cwd', json_extract(data, '$.path.cwd'), 'parentId', json_extract(data, '$.parentID'), 'summary', json_extract(data, '$.summary'), 'paths', CASE WHEN json_extract(data, '$.role') = 'assistant' THEN ${v1Paths(tables)} ELSE NULL END) AS body FROM message WHERE json_valid(data)`;

export const readSql = (tables: TableColumns): string | null => {
  const v2 = has(tables, "session_v2", ...SESSION_CORE);
  const v1 = has(tables, "session", ...SESSION_CORE);
  const v2Messages = has(tables, "session_message", "id", "session_id", "data");
  const v1Messages = has(tables, "message", "id", "session_id", "data");
  const parts: string[] = [];

  if (v2) {
    parts.push(sessionSelect(tables, "session_v2"));
  }

  if (v1) {
    parts.push(sessionSelect(tables, "session"));
  }

  if (v2Messages) {
    parts.push(v2MessageSelect());
  }

  if (v1Messages) {
    parts.push(v1MessageSelect(tables));
  }

  return parts.length === 0 ? null : parts.join(" UNION ALL ");
};

export const countSql = (tables: TableColumns): string | null => {
  const v2 = has(tables, "session_v2", "id");
  const v1 = has(tables, "session", "id");

  if (v2 && v1) {
    return "SELECT (SELECT count(*) FROM session_v2) + (SELECT count(*) FROM session WHERE id NOT IN (SELECT id FROM session_v2)) AS sessions";
  }

  if (v2) {
    return "SELECT count(*) AS sessions FROM session_v2";
  }

  return v1 ? "SELECT count(*) AS sessions FROM session" : null;
};

export const CountRowSchema = Schema.Struct({ sessions: Schema.Finite });

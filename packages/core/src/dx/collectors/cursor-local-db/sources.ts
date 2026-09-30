// @effect-diagnostics nodeBuiltinImport:off -- Auto-sync checks that the Cursor local databases exist before planning a read.
import { existsSync } from "node:fs";
import path from "node:path";

import { cursorStateDbPath } from "../cursor-usage-api/session.js";
import { CURSOR_LOCAL_DB_ADAPTER_ID } from "./descriptor.js";

export const aiTrackingDbPath = (home: string): string =>
  path.join(home, ".cursor", "ai-tracking", "ai-code-tracking.db");

export const localDbSources = (
  home: string
): readonly { readonly input: string; readonly source: string }[] =>
  [aiTrackingDbPath(home), cursorStateDbPath(home)].flatMap((input) =>
    existsSync(input) ? [{ input, source: CURSOR_LOCAL_DB_ADAPTER_ID }] : []
  );

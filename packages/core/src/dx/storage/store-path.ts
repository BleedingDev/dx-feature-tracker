// @effect-diagnostics-next-line nodeBuiltinImport:off -- Store path resolution is a pure node:path computation at the process boundary.
import path from "node:path";

import {
  DEFAULT_REPLAY_STORE_RELATIVE,
  DEFAULT_STORE_RELATIVE,
  STORE_ENV_VAR,
} from "../contracts/cli-params.js";

export type StoreKind = "live" | "replay";

export type StorePathSource = "flag" | "env" | "default";

export interface StorePathInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly replay: boolean;
  readonly store: string | null;
}

export interface ResolvedStorePath {
  readonly kind: StoreKind;
  readonly path: string;
  readonly source: StorePathSource;
}

const nonEmpty = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim() === ""
    ? null
    : value.trim();

export const resolveStorePath = (input: StorePathInput): ResolvedStorePath => {
  const kind: StoreKind = input.replay ? "replay" : "live";
  const flag = nonEmpty(input.store);

  if (flag !== null) {
    return { kind, path: path.resolve(flag), source: "flag" };
  }

  const fromEnv = input.replay ? null : nonEmpty(input.env[STORE_ENV_VAR]);

  if (fromEnv !== null) {
    return { kind, path: path.resolve(fromEnv), source: "env" };
  }

  return {
    kind,
    path: path.join(
      input.home,
      input.replay ? DEFAULT_REPLAY_STORE_RELATIVE : DEFAULT_STORE_RELATIVE
    ),
    source: "default",
  };
};

export const spoolDirFor = (storePath: string): string =>
  path.join(path.dirname(storePath), "spool");

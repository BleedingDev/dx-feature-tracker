import type { TimePrecision } from "../../model/common.js";
import type { FieldSemantics } from "../../model/event.js";

export type FeedbackSubroute =
  | "compiler"
  | "npm-timing"
  | "vite-hmr"
  | "ide-diagnostics"
  | "ide-terminal";

export type FeedbackValue =
  | string
  | number
  | boolean
  | null
  | readonly FeedbackValue[]
  | FeedbackObject;

export interface FeedbackObject {
  readonly [key: string]: FeedbackValue;
}

export interface FeedbackRecord {
  readonly fieldSemantics: readonly FieldSemantics[];
  readonly occurredAt: string | null;
  readonly occurredAtPrecision: TimePrecision;
  readonly payload: FeedbackObject;
  readonly sourceVersion: string | null;
}

export interface FeedbackAdapter {
  readonly detect: (name: string, content: string) => boolean;
  readonly id: string;
  readonly parse: (name: string, content: string) => readonly FeedbackRecord[];
  readonly subroute: FeedbackSubroute;
  readonly version: string;
}

export interface UnsupportedSubroute {
  readonly reason: string;
  readonly subroute: FeedbackSubroute;
}

export const UNSUPPORTED_SUBROUTES: readonly UnsupportedSubroute[] = [
  {
    reason:
      "No stable local export of IDE Problems-panel diagnostics exists on this host; Cursor/VS Code diagnostics are not read.",
    subroute: "ide-diagnostics",
  },
  {
    reason:
      "IDE integrated-terminal output is not persisted by the editor; only explicitly captured log files are imported.",
    subroute: "ide-terminal",
  },
];

const ANSI_PATTERN = new RegExp(`${String.fromCodePoint(27)}\\[[0-9;]*m`, "gu");

export const stripAnsi = (value: string): string =>
  value.replaceAll(ANSI_PATTERN, "");

export const linesOf = (content: string): readonly string[] =>
  stripAnsi(content).split(/\r?\n/u);

export const selectAdapter = (
  adapters: readonly FeedbackAdapter[],
  name: string,
  content: string
): FeedbackAdapter | null =>
  adapters.find((adapter) => adapter.detect(name, content)) ?? null;

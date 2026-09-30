export interface HistoryEntry {
  readonly command: string;
  readonly durationSeconds: number | null;
  readonly epochSeconds: number | null;
  readonly line: number;
}

const ZSH_EXTENDED = /^: (?<epoch>\d+):(?<elapsed>\d+);(?<command>.*)$/u;

const BASH_TIMESTAMP = /^#(?<epoch>\d{9,})$/u;

export const parseShellHistory = (text: string): readonly HistoryEntry[] => {
  const entries: HistoryEntry[] = [];
  let pendingEpoch: number | null = null;

  for (const [index, raw] of text.split("\n").entries()) {
    const line = raw.trimEnd();

    if (line.length === 0) {
      continue;
    }

    const zsh = ZSH_EXTENDED.exec(line);

    if (zsh !== null) {
      entries.push({
        command: zsh.groups?.command ?? "",
        durationSeconds: Number(zsh.groups?.elapsed),
        epochSeconds: Number(zsh.groups?.epoch),
        line: index + 1,
      });
      pendingEpoch = null;
      continue;
    }

    const bash = BASH_TIMESTAMP.exec(line);

    if (bash !== null) {
      pendingEpoch = Number(bash.groups?.epoch);
      continue;
    }

    entries.push({
      command: line,
      durationSeconds: null,
      epochSeconds: pendingEpoch,
      line: index + 1,
    });
    pendingEpoch = null;
  }

  return entries;
};

export const tokenize = (command: string): readonly string[] =>
  command.split(/\s+/u).filter((word) => word.length > 0);

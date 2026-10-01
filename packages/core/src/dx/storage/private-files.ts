// @effect-diagnostics nodeBuiltinImport:off -- dft keeps its store, backups, config and saved pages private to the user with synchronous node:fs mode changes at the process boundary.
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  mkdirSync,
  statSync,
  writeFileSync,
} from "node:fs";

export const PRIVATE_DIR_MODE = 0o700;

export const PRIVATE_FILE_MODE = 0o600;

const OWNER_BITS = 0o100;

const sharedBits = (mode: number): number => mode % OWNER_BITS;

const tighten = (target: string, mode: number): void => {
  const found = statSync(target, { throwIfNoEntry: false });

  if (found !== undefined && sharedBits(found.mode) !== 0) {
    chmodSync(target, mode);
  }
};

export const tightenPrivateDir = (dir: string): void => {
  tighten(dir, PRIVATE_DIR_MODE);
};

export const tightenPrivateFile = (file: string): void => {
  tighten(file, PRIVATE_FILE_MODE);
};

export const ensurePrivateDir = (dir: string): void => {
  mkdirSync(dir, { mode: PRIVATE_DIR_MODE, recursive: true });
};

export const writePrivateFile = (
  file: string,
  data: string | Uint8Array,
  flag = "w"
): void => {
  writeFileSync(file, data, { flag, mode: PRIVATE_FILE_MODE });
  tightenPrivateFile(file);
};

export const appendPrivateFile = (file: string, data: string): void => {
  appendFileSync(file, data, { mode: PRIVATE_FILE_MODE });
  tightenPrivateFile(file);
};

export const copyPrivateFile = (source: string, target: string): void => {
  copyFileSync(source, target);
  chmodSync(target, PRIVATE_FILE_MODE);
};

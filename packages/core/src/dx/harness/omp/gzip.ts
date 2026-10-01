// @effect-diagnostics nodeBuiltinImport:off -- OMP archives sessions as gzip files; node:zlib is the only decompressor available to the store at the file boundary.
import { gunzipSync } from "node:zlib";

import { Effect } from "effect";

import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import { harnessAdapterId } from "../pending.js";

export const gunzipSession = (
  file: string,
  bytes: Uint8Array
): Effect.Effect<Uint8Array, SourceUnavailable> =>
  Effect.try({
    catch: () =>
      new SourceUnavailable({
        adapterId: harnessAdapterId("omp"),
        message: `cannot decompress ${file}`,
      }),
    try: () => new Uint8Array(gunzipSync(bytes)),
  });

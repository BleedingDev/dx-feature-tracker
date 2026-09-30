// @effect-diagnostics-next-line nodeBuiltinImport:off -- Flight IDs are a synchronous deterministic sha256-derived UUID; Effect Crypto is effectful.
import { createHash } from "node:crypto";

import { FlightIdSchema } from "../../model/ids.js";
import type { FlightId } from "../../model/ids.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const isFlightUuid = (value: string): boolean =>
  UUID_PATTERN.test(value);

export const deriveFlightId = (parts: readonly string[]): FlightId => {
  const hex = createHash("sha256")
    .update(["dx.flight.v1", ...parts].join("\u0000"))
    .digest("hex");

  const variant = ((Number.parseInt(hex.slice(16, 17), 16) % 4) + 8).toString(
    16
  );

  return FlightIdSchema.make(
    [
      hex.slice(0, 8),
      hex.slice(8, 12),
      `5${hex.slice(13, 16)}`,
      `${variant}${hex.slice(17, 20)}`,
      hex.slice(20, 32),
    ].join("-")
  );
};

import { Schema } from "effect";

import { Cancelled } from "./error-cancelled.js";
import { ContractMismatch } from "./error-contract-mismatch.js";
import { InvalidInput } from "./error-invalid-input.js";
import { SnapshotNotFound } from "./error-snapshot-not-found.js";
import { SourceUnavailable } from "./error-source-unavailable.js";
import { StoreBusy } from "./error-store-busy.js";
import { StoreError } from "./error-store-error.js";
import { UnsupportedSource } from "./error-unsupported-source.js";

export const CollectFailureSchema = Schema.Union([
  InvalidInput,
  UnsupportedSource,
  SourceUnavailable,
  StoreBusy,
  StoreError,
  Cancelled,
]);

export type CollectFailure = typeof CollectFailureSchema.Type;

export const QueryFailureSchema = Schema.Union([
  InvalidInput,
  SnapshotNotFound,
  ContractMismatch,
  StoreBusy,
  StoreError,
]);

export type QueryFailure = typeof QueryFailureSchema.Type;

export const MarkFailureSchema = Schema.Union([
  InvalidInput,
  StoreBusy,
  StoreError,
  Cancelled,
]);

export type MarkFailure = typeof MarkFailureSchema.Type;

// @effect-diagnostics nodeBuiltinImport:off -- The shared agent folder is built in an owned temp home with synchronous node:fs before any layer is built.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { everywhere } from "../../../src/dx/harness/contract.js";
import type {
  ReadInput,
  SessionRef,
} from "../../../src/dx/harness/contract.js";
import { GitRunner } from "../../../src/dx/harness/git.js";
import { HarnessHome } from "../../../src/dx/harness/home.js";
import { LocalSqlite } from "../../../src/dx/harness/local-sqlite.js";
import { OmpHarness, OmpStore } from "../../../src/dx/harness/omp/index.js";
import { piFamilyToolOf } from "../../../src/dx/harness/pi-family.js";
import { PiHarness, PiStore } from "../../../src/dx/harness/pi/index.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import { deriveUsageFacts } from "../../../src/dx/usage/derive.js";

const FIXTURES = path.resolve(import.meta.dirname, "..", "fixtures", "harness");

const PI_SESSION = "01a0f718-e330-7250-b94b-fc0576b8089d";

const OMP_SESSION = "01a0f718-2039-7129-87be-130c086e4afa";

const piSource = path.join(
  FIXTURES,
  "pi/home/.pi/agent/sessions/--home-user-projects-pi-demo--",
  `2026-10-01T10-53-18-513Z_${PI_SESSION}.jsonl`
);

const ompSource = path.join(
  FIXTURES,
  "omp/sessions/-work-repo",
  `2026-10-01T10-52-28-601Z_${OMP_SESSION}.jsonl`
);

const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dft-pi-omp-")));

const agent = path.join(home, "agent");

const place = (folder: string, source: string, text: string): string => {
  const dir = path.join(agent, "sessions", folder);
  const file = path.join(dir, path.basename(source));

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, text);

  return file;
};

const piFile = place(
  "--pi--",
  piSource,
  readFileSync(piSource, "utf-8").replaceAll(
    /"responseId":"[^"]*"/gu,
    '"responseId":null'
  )
);

const ompFile = place("--omp--", ompSource, readFileSync(ompSource, "utf-8"));

afterAll(() => {
  rmSync(home, { force: true, recursive: true });
});

const sharedHome = HarnessHome.at(home, { PI_CODING_AGENT_DIR: agent });

const piLayer = PiHarness.layer.pipe(
  Layer.provide(PiStore.layer),
  Layer.provide(Layer.mergeAll(sharedHome, GitRunner.memory([]))),
  Layer.provide(NodeServices.layer)
);

const ompLayer = OmpHarness.layer.pipe(
  Layer.provide(OmpStore.layer),
  Layer.provide(Layer.mergeAll(sharedHome, LocalSqlite.layer)),
  Layer.provide(NodeServices.layer)
);

const input: ReadInput = {
  context: emptyFlightContext,
  cursor: null,
  origin: "fixture",
};

const readPi = Effect.gen(function* readPiShare() {
  const harness = yield* PiHarness;
  const refs = yield* harness.locate(everywhere);

  const batches = yield* Effect.forEach((ref: SessionRef) =>
    harness.read(ref, input)
  )(refs);

  return { events: batches.flatMap((batch) => batch.events), refs };
}).pipe(Effect.provide(piLayer));

const readOmp = Effect.gen(function* readOmpShare() {
  const harness = yield* OmpHarness;
  const refs = yield* harness.locate(everywhere);

  const batches = yield* Effect.forEach((ref: SessionRef) =>
    harness.read(ref, input)
  )(refs);

  return { events: batches.flatMap((batch) => batch.events), refs };
}).pipe(Effect.provide(ompLayer));

describe("Pi and OMP sharing PI_CODING_AGENT_DIR", () => {
  it("tells the two session formats apart", () => {
    expect(piFamilyToolOf(readFileSync(piFile, "utf-8"))).toBe("pi");
    expect(piFamilyToolOf(readFileSync(ompFile, "utf-8"))).toBe("omp");
  });

  it.effect("reads each session file with one tool only", () =>
    Effect.gen(function* shared() {
      const pi = yield* readPi;
      const omp = yield* readOmp;

      expect(pi.refs.map((ref) => ref.path)).toStrictEqual([piFile]);
      expect(omp.refs.map((ref) => ref.path)).toStrictEqual([ompFile]);

      const events = [...pi.events, ...omp.events];

      const owners = new Map(
        events.map((event) => [event.ai?.sessionId, event.ai?.harness])
      );

      expect(Object.fromEntries(owners)).toStrictEqual({
        [OMP_SESSION]: "omp",
        [PI_SESSION]: "pi",
      });

      const facts = deriveUsageFacts(events).facts.map((fact) => [
        fact.harness,
        fact.session,
      ]);

      expect(facts).toStrictEqual([
        ["pi", PI_SESSION],
        ["pi", PI_SESSION],
        ["pi", PI_SESSION],
      ]);
    })
  );
});

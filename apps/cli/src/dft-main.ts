#!/usr/bin/env node

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Approval } from "@rat-stack/capability";
import { FileInspector } from "@rat-stack/core";
import { Effect, Layer } from "effect";

import { runDft } from "./dft.js";

const program = runDft(process.argv.slice(2)).pipe(
  Effect.provide(
    Layer.mergeAll(
      Layer.provideMerge(FileInspector.layer, NodeServices.layer),
      Approval.denyAll
    )
  )
);

NodeRuntime.runMain(program);

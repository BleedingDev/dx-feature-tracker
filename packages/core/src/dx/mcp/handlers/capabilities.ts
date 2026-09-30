import { implement } from "@rat-stack/capability/define";

import {
  dxAnalyzeContract,
  dxEvidenceContract,
  dxExplainContract,
  dxStatusContract,
} from "../../contracts/capabilities.js";
import { handleAnalyze } from "./analyze.js";
import type { DxHandlerDeps } from "./deps.js";
import { handleEvidence } from "./evidence.js";
import { handleExplain } from "./explain.js";
import { handleStatus } from "./status.js";
import { isolateStdout } from "./stdio.js";

export const makeDxQueryCapabilities = (deps: DxHandlerDeps) =>
  [
    implement(dxStatusContract, () => isolateStdout(handleStatus(deps))),
    implement(dxAnalyzeContract, (input) =>
      isolateStdout(handleAnalyze(deps, input))
    ),
    implement(dxExplainContract, (input) =>
      isolateStdout(handleExplain(deps, input))
    ),
    implement(dxEvidenceContract, (input) =>
      isolateStdout(handleEvidence(deps, input))
    ),
  ] as const;

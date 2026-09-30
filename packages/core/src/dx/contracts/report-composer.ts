import { Context } from "effect";

import type { ReportComposerService } from "./services.js";

export class ReportComposer extends Context.Service<
  ReportComposer,
  ReportComposerService
>()("@rat-stack/core/dx/ReportComposer") {}

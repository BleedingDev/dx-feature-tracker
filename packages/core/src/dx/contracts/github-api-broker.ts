import { Context } from "effect";

import type { GitHubApiBrokerService } from "./services.js";

export class GitHubApiBroker extends Context.Service<
  GitHubApiBroker,
  GitHubApiBrokerService
>()("@rat-stack/core/dx/GitHubApiBroker") {}

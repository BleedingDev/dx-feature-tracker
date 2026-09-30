import { Context } from "effect";

import type { EventStoreService } from "./services.js";

export class EventStore extends Context.Service<
  EventStore,
  EventStoreService
>()("@rat-stack/core/dx/EventStore") {}

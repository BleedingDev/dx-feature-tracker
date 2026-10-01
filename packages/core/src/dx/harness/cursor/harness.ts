import { Context, Effect, Layer } from "effect";

import { cursorCliCollector } from "../../collectors/cursor-cli/collector.js";
import { cursorHooksCollector } from "../../collectors/cursor-hooks/collector.js";
import { cursorLocalDbCollector } from "../../collectors/cursor-local-db/collector.js";
import { cursorTranscriptCollector } from "../../collectors/cursor-transcripts/collector.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { DxCollector } from "../../contracts/services.js";
import type {
  HarnessScope,
  Harness,
  ReadInput,
  SessionRef,
} from "../contract.js";
import { harnessAdapterId } from "../pending.js";
import { CURSOR_CHANNELS } from "./meta.js";
import { channelOfSource } from "./sources.js";
import type { CursorSource } from "./sources.js";
import { CursorStore } from "./store.js";
import type { CursorCollectorServices } from "./store.js";

const COLLECTORS: readonly DxCollector<CursorCollectorServices>[] = [
  cursorHooksCollector,
  cursorTranscriptCollector,
  cursorCliCollector,
  cursorLocalDbCollector,
];

const adapterIdOf = (collector: DxCollector<CursorCollectorServices>) => {
  const { id } = collector.descriptor;

  return id.replace(/^collector[./]/u, "");
};

const collectorFor = (source: string) =>
  COLLECTORS.find(
    (collector) =>
      collector.descriptor.id === source || adapterIdOf(collector) === source
  );

const refOf = (source: CursorSource): SessionRef => ({
  channel: channelOfSource(source.source),
  harness: "cursor",
  id: `${source.source}:${source.input}`,
  mtimeMs: null,
  path: source.input,
  sessionId: null,
  size: null,
  source: source.source,
  worktree: source.worktree,
});

export class CursorHarness extends Context.Service<CursorHarness, Harness>()(
  "dx/harness/cursor/CursorHarness",
  {
    make: Effect.gen(function* makeCursorHarness() {
      const store = yield* CursorStore;

      const discover = Effect.gen(function* discoverCursor() {
        const roots = yield* store.roots;

        const present = yield* store.present;

        const transcripts = present
          ? yield* store.listSessions.pipe(Effect.orElseSucceed(() => []))
          : [];

        return {
          harness: "cursor" as const,
          present,
          reason: present ? null : `no Cursor folder at ${store.folder}`,
          roots,
          sessions: transcripts.length,
          version: null,
        };
      });

      const locate = (scope: HarnessScope) =>
        store.sources(scope).pipe(Effect.map((sources) => sources.map(refOf)));

      const read = (ref: SessionRef, input: ReadInput) => {
        const collector = collectorFor(ref.source);

        if (collector === undefined) {
          return Effect.fail(
            new SourceUnavailable({
              adapterId: harnessAdapterId("cursor"),
              message: `no Cursor reader for ${ref.source}`,
            })
          );
        }

        return collector
          .collect({
            adapterId: adapterIdOf(collector),
            context: input.context,
            cursor: input.cursor,
            origin: input.origin,
            scratchDir: null,
            selectedInput: ref.path,
          })
          .pipe(
            Effect.provide(store.reader),
            Effect.catchTags({
              Cancelled: (failure) =>
                Effect.fail(
                  new SourceUnavailable({
                    adapterId: harnessAdapterId("cursor"),
                    message: failure.message,
                  })
                ),
              GitHubApiError: (failure) =>
                Effect.fail(
                  new SourceUnavailable({
                    adapterId: harnessAdapterId("cursor"),
                    message: failure.message,
                  })
                ),
              UnsupportedSource: (failure) =>
                Effect.fail(
                  new SourceUnavailable({
                    adapterId: harnessAdapterId("cursor"),
                    message: failure.message,
                  })
                ),
            })
          );
      };

      return {
        capabilities: {
          branchSources: [
            "harness-recorded",
            "hook",
            "git-at-time",
            "session-recorded",
            "cwd-inferred",
            "tool-calls",
            "subagent-split",
            "unassigned",
          ],
          liveHooks: true,
          storedFigure: "charge",
          subagents: true,
        },
        channels: CURSOR_CHANNELS,
        discover,
        displayName: "Cursor",
        id: "cursor",
        locate,
        read,
      } satisfies Harness;
    }),
  }
) {
  static readonly layer = Layer.effect(this, this.make);

  static readonly mock = Layer.effect(this, this.make).pipe(
    Layer.provide(CursorStore.memory({ files: [], roots: [] }))
  );
}

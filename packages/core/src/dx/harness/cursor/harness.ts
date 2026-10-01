import { Context, Effect, FileSystem, Layer } from "effect";
import type { Crypto } from "effect";

import { cursorCliCollector } from "../../collectors/cursor-cli/collector.js";
import { cursorHooksCollector } from "../../collectors/cursor-hooks/collector.js";
import { cursorLocalDbCollector } from "../../collectors/cursor-local-db/collector.js";
import { cursorTranscriptCollector } from "../../collectors/cursor-transcripts/collector.js";
import { SourceUnavailable } from "../../contracts/error-source-unavailable.js";
import type { DxCollector } from "../../contracts/services.js";
import { defaultDftHome } from "../../registry/runtime.js";
import type {
  HarnessScope,
  Harness,
  ReadInput,
  SessionRef,
} from "../contract.js";
import { HarnessHome } from "../home.js";
import { harnessAdapterId } from "../pending.js";
import { CURSOR_CHANNELS } from "./meta.js";
import { channelOfSource, cursorSources } from "./sources.js";
import type { CursorSource } from "./sources.js";
import { CursorStore } from "./store.js";

export type CursorCollectorServices = FileSystem.FileSystem | Crypto.Crypto;

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
      const home = yield* HarnessHome;
      const fileSystem = yield* FileSystem.FileSystem;
      const services = yield* Effect.context<CursorCollectorServices>();

      const discover = Effect.gen(function* discoverCursor() {
        const roots = yield* store.roots;

        const present = yield* fileSystem
          .exists(home.dirs.cursor)
          .pipe(Effect.orElseSucceed(() => false));

        return {
          harness: "cursor" as const,
          present,
          reason: present ? null : `no Cursor folder at ${home.dirs.cursor}`,
          roots,
          sessions: 0,
          version: null,
        };
      });

      const locate = (scope: HarnessScope) =>
        Effect.sync(() =>
          cursorSources({
            dftHome: scope.dftHome ?? defaultDftHome(),
            home: home.home,
            repoCommonDir: scope.repoCommonDir,
            worktrees: scope.worktrees,
          }).map(refOf)
        );

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
            Effect.provide(services),
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
}

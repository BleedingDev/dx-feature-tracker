// @effect-diagnostics-next-line nodeBuiltinImport:off -- The integration fixture owns and removes its SQLite scratch directory.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The integration fixture builds its owned SQLite path.
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { vi } from "vitest";

import { makeDxCapabilities } from "../../src/dx/capabilities.js";
import { AgentStore } from "../../src/dx/contracts/agent-store.js";
import {
  AGENT_CONTRACT_DIGEST,
  AGENT_CONTRACT_VERSION,
} from "../../src/dx/contracts/agent-version.js";
import { EventStore } from "../../src/dx/contracts/event-store.js";
import { makeFakeAgentStore } from "../../src/dx/contracts/fake-agent-store.js";
import { handleEvidence } from "../../src/dx/mcp/handlers/evidence.js";
import { handleExplain } from "../../src/dx/mcp/handlers/explain.js";
import { handleStatus } from "../../src/dx/mcp/handlers/status.js";
import { AgentRequestSchema } from "../../src/dx/model/agent-common.js";
import { StatusReportSchema } from "../../src/dx/model/report.js";
import { buildRegistry } from "../../src/dx/registry/registry.js";
import * as Runtime from "../../src/dx/registry/runtime.js";
import { makeSqliteEventStore } from "../../src/dx/storage/sqlite-event-store.js";
import type { OpenedEventStore } from "../../src/dx/storage/sqlite-event-store.js";
import { emptyCoverage, makeFakeEventStore } from "./fakes.js";
import { consumerEvent, consumerRepo } from "./fixtures/r00/consumer.js";

const request = AgentRequestSchema.make({
  budget: {
    maxDecodedBytes: 1_048_576,
    maxElapsedMs: 5000,
    maxFacts: 1000,
    maxItems: 20,
    maxNetworkRequests: 0,
    maxOutputBytes: 16_384,
    maxSeriesBuckets: 32,
    maxStacks: 8,
  },
  detail: "summary",
  policies: {
    acquisition: "recorded-only",
    derivation: "ready-only",
    learning: "hidden",
    prices: "cached-only",
  },
  profileVersion: "dx.agent.v1",
});

const storeLayer = () =>
  Layer.mergeAll(
    Layer.succeed(EventStore, makeFakeEventStore()),
    Layer.succeed(AgentStore, makeFakeAgentStore())
  );

const deps = { descriptors: [], metrics: [] };

const withStore = <A, E>(
  use: (resource: {
    readonly storePath: string;
    opened: OpenedEventStore;
  }) => Effect.Effect<A, E>
) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      const directory = mkdtempSync(path.join(tmpdir(), "dft-r00-"));
      const storePath = path.join(directory, "labelled-fixture.sqlite");

      return {
        directory,
        opened: makeSqliteEventStore({ kind: "live", path: storePath }),
        storePath,
      };
    }),
    use,
    (resource) =>
      Effect.sync(() => {
        resource.opened.close();
        rmSync(resource.directory, { force: true, recursive: true });
      })
  );

const provideOpened = (opened: OpenedEventStore) =>
  Layer.mergeAll(
    Layer.succeed(EventStore, opened.service),
    Layer.succeed(AgentStore, opened.agentService)
  );

describe("R00 shared recorded reads", () => {
  it.effect(
    "orientation acknowledges the profile without reading events or initializing prices",
    () => {
      let priceReads = 0;
      let eventReads = 0;

      const agentStore = makeFakeAgentStore({
        readEventPage: () =>
          Effect.sync(() => {
            eventReads += 1;
            throw new Error("orientation must not read events");
          }),
      });

      const caps = makeDxCapabilities({
        collectors: [],
        defaultRepo: "/r00-labelled-fixture",
        registry: buildRegistry([], [], []),
        resolveCostOptions: () => {
          priceReads += 1;
          throw new Error("orientation must not initialize prices");
        },
        storePath: "/r00-labelled-fixture/store.db",
      });

      return Effect.gen(function* orient() {
        const status = yield* caps[0].handler({ agentQuery: request });
        expect(Schema.is(StatusReportSchema)(status)).toBe(true);
        expect(status.context?.profileVersion).toBe("dx.agent.v1");
        expect(status.contractVersion).toBe(AGENT_CONTRACT_VERSION);
        expect(status.contractDigest).toBe(AGENT_CONTRACT_DIGEST);
        expect(status.context?.effectivePolicies).toEqual(request.policies);
        expect(status.context?.effects.networkRequests).toBe(0);
        expect(status.context?.resources.factsExamined).toBe(0);
        expect(
          status.descriptors
            .filter((item) => item.id.startsWith("dx.service."))
            .map((item) => item.readiness)
        ).toEqual(["disabled", "disabled"]);
        expect(priceReads).toBe(0);
        expect(eventReads).toBe(0);
        expect(Buffer.byteLength(JSON.stringify(status))).toBeLessThanOrEqual(
          request.budget.maxOutputBytes
        );
        expect(status.context?.resources.outputBytes).toBe(
          Buffer.byteLength(JSON.stringify(status))
        );
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.succeed(EventStore, makeFakeEventStore()),
            Layer.succeed(AgentStore, agentStore)
          )
        )
      );
    }
  );

  it.effect(
    "orientation bounds current source metadata and never reads historical coverage",
    () =>
      Effect.gen(function* boundedMetadata() {
        const scope = {
          branchSelection: {
            branches: ["fixture-branch"],
            kind: "selected" as const,
          },
          flightId: null,
          repoId: consumerRepo,
          resolution: "labelled fixture selection",
          sources: [],
          tools: [],
          worktreeId: consumerRepo,
        };

        const current = emptyCoverage("dx.harness.codex");
        let limits: readonly number[] = [];

        const agent = makeFakeAgentStore({
          readCoverage: (_scope, maxSources, maxBytes) => {
            limits = [maxSources, maxBytes];

            return Effect.succeed({
              coverage: [current],
              decodedBytes: 125,
              factsExamined: 1,
              omitted: 4,
            });
          },
        });

        const legacy = {
          ...makeFakeEventStore(),
          coverage: () =>
            Effect.die(
              new Error(
                "Historical coverage must not be decoded by agent status"
              )
            ),
        };

        const output = yield* handleStatus(
          { ...deps, resolveScope: () => scope },
          {
            agentQuery: {
              ...request,
              budget: { ...request.budget, maxItems: 2 },
            },
          }
        ).pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.succeed(EventStore, legacy),
              Layer.succeed(AgentStore, agent)
            )
          )
        );

        expect(limits).toEqual([2, request.budget.maxDecodedBytes]);
        expect(output.context?.coverage).toEqual([current]);
        expect(output.context?.resources.factsExamined).toBe(1);
        expect(output.context?.resources.decodedBytes).toBe(125);
        expect(output.context?.completeness.aggregation).toBe("partial");
        expect(output.context?.completeness.omittedItems).toBe(4);
      })
  );

  it.effect(
    "shared usage continuation resumes after reopening without current prices or selector discovery",
    () =>
      withStore((resource) =>
        Effect.gen(function* consumerResume() {
          yield* resource.opened.service.append({
            coverage: emptyCoverage("dx.harness.codex"),
            cursor: null,
            events: [consumerEvent("r00-one"), consumerEvent("r00-two")],
          });
          let priceReads = 0;

          const caps = makeDxCapabilities({
            collectors: [],
            defaultRepo: "/missing-labelled-fixture",
            registry: buildRegistry([], [], []),
            resolveCostOptions: () => {
              priceReads += 1;

              return { priceTable: null, subscription: null };
            },
            storePath: resource.storePath,
          });

          const agent = {
            ...request,
            budget: { ...request.budget, maxItems: 1, maxOutputBytes: 131_072 },
            detail: "expanded" as const,
            policies: {
              ...request.policies,
              derivation: "bounded-refresh" as const,
            },
          };

          const initial = yield* caps[8]
            .handler({
              agentQuery: agent,
              groupBy: "tool",
              repo: [consumerRepo],
              since: "2026-10-02T00:00:00.000Z",
              until: "2026-10-03T00:00:00.000Z",
            })
            .pipe(Effect.provide(provideOpened(resource.opened)));

          expect(initial.view.nextCursor).not.toBeNull();
          expect(priceReads).toBe(1);
          yield* Effect.sync(() => {
            resource.opened.close();
            resource.opened = makeSqliteEventStore({
              kind: "live",
              path: resource.storePath,
            });
          });

          const resumed = yield* caps[8]
            .handler({
              agentQuery: {
                ...agent,
                basisId: initial.result.basisId,
                policies: {
                  ...agent.policies,
                  derivation: "ready-only",
                  prices: "pinned",
                },
              },
              cursor: initial.view.nextCursor ?? "",
              groupBy: "tool",
            })
            .pipe(Effect.provide(provideOpened(resource.opened)));

          expect(resumed.result.resultDigest).toBe(initial.result.resultDigest);
          expect(resumed.context.window).toEqual(initial.context.window);
          expect(resumed.context.scope).toEqual(initial.context.scope);
          expect(resumed.context.effects.basisWrites).toBe(0);
          expect(resumed.view.items).not.toEqual(initial.view.items);
          expect(priceReads).toBe(1);

          const status = yield* handleStatus(
            { ...deps, resolveScope: () => initial.context.scope },
            { agentQuery: request }
          ).pipe(Effect.provide(provideOpened(resource.opened)));

          expect(status.context?.basisId).toBe(initial.result.basisId);
          expect(status.context?.window).toEqual(initial.context.window);
          expect(status.context?.next[0]?.id).toBe(initial.result.basisId);
        })
      )
  );

  it.effect(
    "cursor-only usage replay retains aliases without Git, prices or catalog resolution",
    () =>
      withStore((resource) => {
        const repoResolver = vi.spyOn(Runtime, "contextForRepo");

        return Effect.gen(function* cursorOnlyResume() {
          const recordedAlias = `${consumerRepo}/recorded-worktree`;
          repoResolver.mockReturnValue({
            ...consumerEvent("r00-scope").context,
            worktreePath: recordedAlias,
          });

          yield* resource.opened.service.append({
            coverage: emptyCoverage("dx.harness.codex"),
            cursor: null,
            events: [
              consumerEvent("r00-cursor-one"),
              consumerEvent("r00-cursor-two"),
            ].map((event, index) => ({
              ...event,
              ai:
                event.ai === null
                  ? null
                  : {
                      ...event.ai,
                      model: `labelled-fixture-model-${index}`,
                      modelRaw: `labelled-fixture-model-${index}`,
                    },
              context: { ...event.context, worktreePath: recordedAlias },
            })),
          });

          const agent = {
            ...request,
            budget: { ...request.budget, maxItems: 1, maxOutputBytes: 131_072 },
            detail: "expanded" as const,
            policies: {
              ...request.policies,
              derivation: "bounded-refresh" as const,
            },
          };

          const initialCaps = makeDxCapabilities({
            collectors: [],
            defaultRepo: recordedAlias,
            registry: buildRegistry([], [], []),
            storePath: resource.storePath,
          });

          const initial = yield* initialCaps[8]
            .handler({
              agentQuery: agent,
              groupBy: "model",
              repo: [recordedAlias],
              since: "2026-10-02T00:00:00.000Z",
              until: "2026-10-03T00:00:00.000Z",
            })
            .pipe(Effect.provide(provideOpened(resource.opened)));

          expect(initial.context.scope.repoId).toBe(consumerRepo);
          expect(initial.context.scope.worktreeId).toBe(recordedAlias);
          expect(initial.view.nextCursor).not.toBeNull();

          yield* Effect.sync(() => {
            resource.opened.close();
            resource.opened = makeSqliteEventStore({
              kind: "live",
              path: resource.storePath,
            });
          });

          let priceReads = 0;
          let catalogReads = 0;
          repoResolver.mockClear();
          repoResolver.mockImplementation(() => {
            throw new Error("A retained cursor must not resolve current Git");
          });

          const resumedCaps = makeDxCapabilities({
            agentCatalog: () => {
              catalogReads += 1;

              return Effect.die(
                new Error("A retained cursor must not resolve the catalog")
              );
            },
            collectors: [],
            defaultRepo: "/unrelated-current-repository",
            registry: buildRegistry([], [], []),
            resolveCostOptions: () => {
              priceReads += 1;
              throw new Error(
                "A retained cursor must not resolve current prices"
              );
            },
            selector: { allRepos: true, from: "2099-01-01T00:00:00.000Z" },
            storePath: resource.storePath,
          });

          for (const prices of ["cached-only", "pinned"] as const) {
            for (const repo of [undefined, [recordedAlias]]) {
              const replayInput = {
                agentQuery: {
                  ...agent,
                  policies: {
                    ...agent.policies,
                    derivation: "ready-only" as const,
                    prices,
                  },
                },
                cursor: initial.view.nextCursor ?? "",
                groupBy: "model" as const,
              };

              const resumed = yield* resumedCaps[8]
                .handler(
                  repo === undefined ? replayInput : { ...replayInput, repo }
                )
                .pipe(Effect.provide(provideOpened(resource.opened)));

              expect(resumed.result.resultDigest).toBe(
                initial.result.resultDigest
              );
              expect(resumed.context.scope).toEqual(initial.context.scope);
              expect(resumed.context.window).toEqual(initial.context.window);
              expect(resumed.context.effects.basisWrites).toBe(0);
              expect(resumed.context.effects.networkRequests).toBe(0);
              expect(resumed.view.items).not.toEqual(initial.view.items);
            }
          }

          const mismatch = yield* Effect.flip(
            resumedCaps[8]
              .handler({
                agentQuery: {
                  ...agent,
                  policies: {
                    ...agent.policies,
                    derivation: "ready-only",
                    prices: "pinned",
                  },
                },
                cursor: initial.view.nextCursor ?? "",
                groupBy: "model",
                repo: ["/unrelated-selected-repository"],
              })
              .pipe(Effect.provide(provideOpened(resource.opened)))
          );

          expect(mismatch._tag).toBe("AgentError");
          expect(mismatch).toHaveProperty("code", "basis-incompatible");
          expect(repoResolver).not.toHaveBeenCalled();
          expect(priceReads).toBe(0);
          expect(catalogReads).toBe(0);
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              repoResolver.mockRestore();
            })
          )
        );
      })
  );

  it.effect(
    "evidence ID pages resume cursor-only and match the full retained view",
    () =>
      withStore((resource) =>
        Effect.gen(function* evidenceCursorResume() {
          const evidenceIds = [
            "r00-evidence-one",
            "r00-evidence-two",
            "r00-evidence-missing",
          ];

          yield* resource.opened.service.append({
            coverage: emptyCoverage("dx.harness.codex"),
            cursor: null,
            events: evidenceIds.slice(0, 2).map(consumerEvent),
          });

          const caps = makeDxCapabilities({
            collectors: [],
            defaultRepo: "/missing-labelled-fixture",
            registry: buildRegistry([], [], []),
            storePath: resource.storePath,
          });

          const prepared = yield* caps[8]
            .handler({
              agentQuery: {
                ...request,
                budget: { ...request.budget, maxOutputBytes: 131_072 },
                policies: {
                  ...request.policies,
                  derivation: "bounded-refresh",
                },
              },
              repo: [consumerRepo],
              since: "2026-10-02T00:00:00.000Z",
              until: "2026-10-03T00:00:00.000Z",
            })
            .pipe(Effect.provide(provideOpened(resource.opened)));

          const agent = {
            ...request,
            basisId: prepared.result.basisId,
            budget: { ...request.budget, maxItems: 1, maxOutputBytes: 131_072 },
            detail: "expanded" as const,
            policies: {
              ...request.policies,
              derivation: "bounded-refresh" as const,
              prices: "pinned" as const,
            },
          };

          const first = yield* caps[3]
            .handler({ agentQuery: agent, evidenceIds })
            .pipe(Effect.provide(provideOpened(resource.opened)));

          expect(first.view.nextCursor).not.toBeNull();
          expect(
            first.resolutions.map((resolution) => resolution.state)
          ).toEqual(["found", "over-budget", "missing-in-basis"]);

          yield* Effect.sync(() => {
            resource.opened.close();
            resource.opened = makeSqliteEventStore({
              kind: "live",
              path: resource.storePath,
            });
          });

          const { basisId: _basisId, ...cursorAgent } = agent;

          const resumed = yield* caps[3]
            .handler({
              agentQuery: {
                ...cursorAgent,
                policies: { ...cursorAgent.policies, derivation: "ready-only" },
              },
              cursor: first.view.nextCursor ?? "",
              evidenceIds,
            })
            .pipe(Effect.provide(provideOpened(resource.opened)));

          const full = yield* caps[3]
            .handler({
              agentQuery: {
                ...agent,
                budget: { ...agent.budget, maxItems: 20 },
                policies: { ...agent.policies, derivation: "ready-only" },
              },
              evidenceIds,
            })
            .pipe(Effect.provide(provideOpened(resource.opened)));

          expect([...first.view.items, ...resumed.view.items]).toEqual(
            full.view.items
          );
          expect(resumed.result.resultDigest).toBe(first.result.resultDigest);
          expect(full.result.resultDigest).toBe(first.result.resultDigest);
          expect(resumed.context.scope).toEqual(first.context.scope);
          expect(resumed.context.window).toEqual(first.context.window);
          expect(
            resumed.resolutions.map((resolution) => resolution.state)
          ).toEqual(["over-budget", "found", "missing-in-basis"]);
          expect(
            full.resolutions.map((resolution) => resolution.state)
          ).toEqual(["found", "found", "missing-in-basis"]);
          expect(
            resumed.resolutions.map((resolution) => resolution.ref)
          ).toEqual(first.resolutions.map((resolution) => resolution.ref));
          expect(resumed.resolutions.at(-1)).toEqual(full.resolutions.at(-1));
          expect(
            [...first.resolutions, ...resumed.resolutions]
              .flatMap((resolution) =>
                resolution.state === "found" ? [resolution.ref.id] : []
              )
              .toSorted()
          ).toEqual(
            full.resolutions
              .flatMap((resolution) =>
                resolution.state === "found" ? [resolution.ref.id] : []
              )
              .toSorted()
          );
          expect(resumed.context.effects.basisWrites).toBe(0);
          expect(resumed.context.effects.networkRequests).toBe(0);
          expect(resumed.view.disclosures).toEqual(full.view.disclosures);
          expect(resumed.view.nextCursor).toBeNull();
        })
      )
  );

  it.effect(
    "profile status fails explicitly when durable agent storage is absent",
    () =>
      Effect.gen(function* absentStore() {
        const error = yield* Effect.flip(
          handleStatus(deps, { agentQuery: request })
        );

        expect(error._tag).toBe("AgentError");
        expect(error.message).toContain("durable agent store");
      }).pipe(Effect.provideService(EventStore, makeFakeEventStore()))
  );

  it.effect(
    "status refuses acquisition refresh instead of silently ignoring it",
    () =>
      Effect.gen(function* forbiddenRefresh() {
        const error = yield* Effect.flip(
          handleStatus(deps, {
            agentQuery: {
              ...request,
              policies: {
                ...request.policies,
                acquisition: "refresh-selected",
              },
            },
          })
        );

        expect(error._tag).toBe("AgentError");
        expect(error.message).toContain("explicit operations");
      }).pipe(Effect.provide(storeLayer()))
  );

  it.effect(
    "evidence retains missing-reference reasons, snapshot identity and disclosures",
    () =>
      Effect.gen(function* missingEvidence() {
        const result = yield* handleEvidence(deps, {
          evidenceIds: ["missing-labelled-fixture-ref"],
        });

        expect(result.items).toEqual([]);
        expect(result.missing).toEqual([
          {
            evidenceId: "missing-labelled-fixture-ref",
            reason: "unknown-in-snapshot",
          },
        ]);
        expect(result.snapshotId).toBeTruthy();
        expect(
          result.disclosures.some((message) => message.includes("not returned"))
        ).toBe(true);
      }).pipe(Effect.provide(storeLayer()))
  );

  it.effect(
    "explain retains the resolver disclosures through the shared handler",
    () =>
      Effect.gen(function* explained() {
        const output = yield* handleExplain(deps, {});
        expect(output.disclosures).toBeDefined();
        expect(output.snapshotId).toBeTruthy();
        expect(output.total).toBe(0);
      }).pipe(Effect.provide(storeLayer()))
  );
});

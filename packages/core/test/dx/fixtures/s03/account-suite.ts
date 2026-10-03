import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { Scope } from "effect";
import { TestClock } from "effect/testing";

import type { CursorSession } from "../../../../src/dx/collectors/cursor-usage-api/session.js";
import type {
  AgentStoreFailure,
  AgentStoreService,
} from "../../../../src/dx/contracts/agent-store.js";
import type {
  AgentScope,
  StoreIdentity,
} from "../../../../src/dx/model/agent-common.js";
import type {
  OperationArguments,
  OperationBounds,
  OperationPlan,
} from "../../../../src/dx/model/agent-operation.js";
import type {
  EventBatch,
  FlightContext,
} from "../../../../src/dx/model/event.js";
import type {
  AccountPageLimits,
  AccountPageReply,
  AccountPageRequest,
  AccountPageTransport,
  AccountStreamFetch,
  BoundedAccountOperationOptions,
} from "../../../../src/dx/operations/account.js";
import type {
  OperationAdapter,
  OperationApplyInput,
} from "../../../../src/dx/operations/ports.js";
import type { OperationServiceApi } from "../../../../src/dx/operations/service.js";
import type { OpenedEventStore } from "../../../../src/dx/storage/sqlite-event-store.js";

export interface AccountOperationFixtures {
  readonly accountBounds: OperationBounds;
  readonly accountOperationArguments: (
    identity: StoreIdentity
  ) => Extract<OperationArguments, { kind: "collect" }>;
  readonly accountOperationScope: () => AgentScope;
  readonly makeAccountAdapter: (
    options: BoundedAccountOperationOptions
  ) => OperationAdapter;
  readonly makeAccountTransport: (
    fetchPage: AccountStreamFetch
  ) => AccountPageTransport;
  readonly makeOperationService: (
    store: AgentStoreService,
    adapters: readonly OperationAdapter[]
  ) => Effect.Effect<OperationServiceApi, AgentStoreFailure, Scope.Scope>;
  readonly withFixtureStore: <A, E>(
    use: (
      opened: OpenedEventStore,
      root: string
    ) => Effect.Effect<A, E, Scope.Scope>
  ) => Effect.Effect<A, E | AgentStoreFailure>;
  readonly createPlan: (
    service: OperationServiceApi,
    opened: OpenedEventStore,
    args: OperationArguments,
    scope: AgentScope,
    limits?: Partial<OperationBounds>
  ) => Effect.Effect<OperationPlan, AgentStoreFailure>;
  readonly applyInput: (
    plan: OperationPlan,
    key?: string
  ) => OperationApplyInput;
  readonly fixtureBatch: (id: string, context?: FlightContext) => EventBatch;
  readonly fixtureScope: AgentScope;
}

interface FixtureAccountRow {
  readonly kind: string;
  readonly model: string;
  readonly requestId: string;
  readonly timestamp: number;
  readonly tokenUsage?: { readonly outputTokens: number };
}

interface FixtureRequest {
  readonly limits: AccountPageLimits;
  readonly page: number;
  readonly request: AccountPageRequest;
}

interface FixtureAccountPorts {
  readonly credentialCalls: () => number;
  readonly enrollmentCalls: () => number;
  readonly options: BoundedAccountOperationOptions & {
    readonly origin: "fixture";
  };
  readonly requests: readonly FixtureRequest[];
  readonly streamReads: () => number;
  readonly streamCancels: () => number;
  readonly releasedReaders: () => number;
}

const RequestBodySchema = Schema.Struct({
  page: Schema.Int,
  pageSize: Schema.Int,
});

const fixtureRows = (
  count: number,
  prefix: string
): readonly FixtureAccountRow[] =>
  Array.from({ length: count }, (_, index) => ({
    kind: "USAGE_BASED",
    model: "fixture-account-model",
    requestId: `fixture:s03:account:${prefix}:${index}`,
    timestamp: 1_700_000_000_000 + index,
  }));

const fixturePage = (
  rows: readonly FixtureAccountRow[],
  total = rows.length
): AccountPageReply => {
  const body = JSON.stringify({
    totalUsageEventsCount: total,
    usageEventsDisplay: rows,
  });

  return {
    body,
    bytesRead: new TextEncoder().encode(body).byteLength,
    reason: null,
    status: 200,
  };
};

const fixtureAccountSession: CursorSession = {
  accessToken: "synthetic-s03-account-token",
  userId: "synthetic-s03-account-user",
};

const fixturePorts = (
  makeTransport: AccountOperationFixtures["makeAccountTransport"],
  opened: OpenedEventStore,
  root: string,
  page: (page: number, limits: AccountPageLimits) => AccountPageReply,
  session: CursorSession | null = fixtureAccountSession,
  authorized = true,
  chunks: (page: number, body: string) => readonly Uint8Array[] = (
    _page,
    body
  ) => [new TextEncoder().encode(body)]
): FixtureAccountPorts => {
  const requests: FixtureRequest[] = [];
  let credentialCalls = 0;
  let enrollmentCalls = 0;
  let streamReads = 0;
  let streamCancels = 0;
  let releasedReaders = 0;

  const options: BoundedAccountOperationOptions & {
    readonly origin: "fixture";
  } = {
    dftHome: `${root}/fixture-account-state`,
    enrollment: () =>
      Effect.sync(() => {
        enrollmentCalls += 1;

        return {
          reason: "Synthetic S03 account enrollment only",
          receiptIds: authorized ? ["fixture.s03.account-enrollment"] : [],
          state: authorized ? "authorized" : "denied",
        };
      }),
    env: { store: opened.service, storePath: `${root}/fixture.sqlite` },
    home: `${root}/fixture-account-client`,
    origin: "fixture",
    readConfiguration: () =>
      Effect.succeed({
        cursorUsageImport: true,
        digest: "fixture.s03.account-config",
      }),
    readSession: () =>
      Effect.sync(() => {
        credentialCalls += 1;

        return session;
      }),
    transport: (request, limits) =>
      Effect.gen(function* fixtureTransport() {
        const decoded = yield* Schema.decodeUnknownEffect(
          Schema.fromJsonString(RequestBodySchema)
        )(request.body).pipe(Effect.orDie);

        requests.push({ limits, page: decoded.page, request });
        const reply = page(decoded.page, limits);
        const bodyChunks = chunks(decoded.page, reply.body);
        let index = 0;

        // @effect-diagnostics-next-line asyncFunction:off -- The injected HTTP reader port returns promises.
        return yield* makeTransport(async () => {
          await Promise.resolve();

          return {
            reader: {
              // @effect-diagnostics-next-line asyncFunction:off -- The injected reader cancellation port returns a promise.
              cancel: async () => {
                streamCancels += 1;
                await Promise.resolve();
              },
              // @effect-diagnostics-next-line asyncFunction:off -- The injected reader delivers each fixture chunk through a promise.
              read: async () => {
                streamReads += 1;
                const value = bodyChunks[index];
                index += 1;

                await Promise.resolve();

                return value === undefined
                  ? { done: true }
                  : { done: false, value };
              },
              releaseLock: () => {
                releasedReaders += 1;
              },
            },
            status: reply.status,
          };
        })(request, limits);
      }),
  };

  return {
    credentialCalls: () => credentialCalls,
    enrollmentCalls: () => enrollmentCalls,
    options,
    releasedReaders: () => releasedReaders,
    requests,
    streamCancels: () => streamCancels,
    streamReads: () => streamReads,
  };
};

const applyAccount = Effect.fn("S03.applyAccount")(function* applyAccount(
  service: OperationServiceApi,
  input: OperationApplyInput
) {
  const result = yield* service.run(input);

  if (result.action !== "apply") {
    return yield* Effect.die(new Error("Expected account apply response"));
  }

  return result;
});

const snapshotAll = (opened: OpenedEventStore) =>
  opened.service.snapshot({
    branch: null,
    flightId: null,
    from: null,
    repoCommonDir: null,
    to: null,
  });

export const registerAccountOperationTests = (
  fixture: AccountOperationFixtures
): void => {
  describe("S03 bounded synthetic account acquisition", () => {
    it.effect(
      "an oversized chunk discloses discarded delivery and closes its reader",
      () =>
        Effect.gen(function* oversizedChunk() {
          let reads = 0;
          let cancellations = 0;
          let releases = 0;

          const bytes = new TextEncoder().encode(
            "fixture:oversized-account-chunk"
          );

          // @effect-diagnostics-next-line asyncFunction:off -- The injected HTTP response port returns a promise.
          const transport = fixture.makeAccountTransport(async () => {
            await Promise.resolve();

            return {
              reader: {
                // @effect-diagnostics-next-line asyncFunction:off -- The injected reader cancellation port returns a promise.
                cancel: async () => {
                  cancellations += 1;
                  await Promise.resolve();
                },
                // @effect-diagnostics-next-line asyncFunction:off -- The injected reader delivers its fixture chunk through a promise.
                read: async () => {
                  reads += 1;
                  await Promise.resolve();

                  return { done: false, value: bytes };
                },
                releaseLock: () => {
                  releases += 1;
                },
              },
              status: 200,
            };
          });

          const response = yield* transport(
            {
              body: "{}",
              headers: {},
              method: "POST",
              url: "https://cursor.com/api/dashboard/get-filtered-usage-events",
            },
            { maxBytes: 4, maxElapsedMs: 60_000 }
          );

          expect(reads).toBe(1);
          expect(cancellations).toBe(1);
          expect(releases).toBe(1);
          expect(response.bytesRead).toBe(4);
          expect(response.reason).toMatch(/physical.*unavailable/iu);
          expect(response.reason).toContain(String(bytes.byteLength - 4));
          expect(response.body).toBe("");
          expect(response.reason).not.toBeNull();
        })
    );

    it.effect(
      "planning retains its reviewed scope without credentials or HTTP",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* planAccount() {
            yield* TestClock.setTime(1_700_000_010_000);

            const ports = fixturePorts(
              fixture.makeAccountTransport,
              opened,
              root,
              () => fixturePage(fixtureRows(1, "planning"))
            );

            const service = yield* fixture.makeOperationService(
              opened.agentService,
              [fixture.makeAccountAdapter(ports.options)]
            );

            const identity = yield* opened.agentService.identity;
            const arguments_ = fixture.accountOperationArguments(identity);
            const scope = fixture.accountOperationScope();

            const plan = yield* fixture.createPlan(
              service,
              opened,
              arguments_,
              scope,
              fixture.accountBounds
            );

            expect(ports.credentialCalls()).toBe(0);
            expect(ports.requests).toHaveLength(0);
            expect(ports.enrollmentCalls()).toBe(1);
            expect(plan.arguments).toEqual(arguments_);
            expect(plan.scope).toEqual(scope);
            expect(plan.forecast).toEqual({
              bytes: null,
              cost: null,
              elapsedMs: null,
              requests: null,
            });
            expect(yield* opened.agentService.getOperationPlan(plan)).toEqual(
              plan
            );
            expect((yield* snapshotAll(opened)).events).toHaveLength(0);
          })
        )
    );

    it.effect(
      "missing provider charge remains unknown and duplicate apply makes one request",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* unknownCharge() {
            yield* TestClock.setTime(1_700_000_010_000);

            const reply = fixturePage(
              fixtureRows(1, "missing-charge").map((row) => ({
                ...row,
                tokenUsage: { outputTokens: 5 },
              }))
            );

            const ports = fixturePorts(
              fixture.makeAccountTransport,
              opened,
              root,
              () => reply
            );

            const service = yield* fixture.makeOperationService(
              opened.agentService,
              [fixture.makeAccountAdapter(ports.options)]
            );

            const plan = yield* fixture.createPlan(
              service,
              opened,
              fixture.accountOperationArguments(
                yield* opened.agentService.identity
              ),
              fixture.accountOperationScope(),
              fixture.accountBounds
            );

            const input = fixture.applyInput(plan, "fixture.s03.account.once");
            const first = yield* applyAccount(service, input);
            const second = yield* applyAccount(service, input);
            const snapshot = yield* snapshotAll(opened);
            const [event] = snapshot.events;

            if (event === undefined || event.usage === null) {
              return yield* Effect.die(
                new Error(
                  `Expected persisted synthetic account usage: ${JSON.stringify(
                    {
                      receipt: first.receipt,
                      snapshot,
                    }
                  )}`
                )
              );
            }

            expect(ports.requests).toHaveLength(1);
            expect(ports.credentialCalls()).toBe(1);
            expect(snapshot.events).toHaveLength(1);
            expect(event.origin).toBe("fixture");
            expect(event.acquisition).toBe("api");
            expect(event.usage.toolFigure).toBeNull();
            expect(event.usage.tokens.total).toBeNull();
            expect(event.usage.tokens.inputFresh).toBeNull();
            expect(event.usage.tokens.output).toBe(5);
            expect(event.payload.charge).toBeNull();
            expect(event.payload.chargedUsd).toBeNull();
            expect(event.context.branch).toBeNull();
            expect(event.context.repoCommonDir).toBeNull();
            expect(first.receipt.steps[0]?.inserted).toBe(1);
            expect(first.receipt.resources.requests).toBe(1);
            expect(first.receipt.resources.bytesRead).toBe(reply.bytesRead);
            expect(first.receipt.resources.recordsDecoded).toBe(2);
            expect(second.reused).toBe(true);
            expect(second.receipt).toEqual(first.receipt);
            expect(
              yield* opened.agentService.getOperation(first.receipt)
            ).toEqual(first.receipt);

            return first.receipt;
          })
        )
    );

    it.effect(
      "the cumulative request cap retains the first page and its old checkpoint",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* requestCap() {
            yield* TestClock.setTime(1_700_000_010_000);

            const reply = fixturePage(fixtureRows(100, "request-cap"), 200);

            const ports = fixturePorts(
              fixture.makeAccountTransport,
              opened,
              root,
              () => reply
            );

            const service = yield* fixture.makeOperationService(
              opened.agentService,
              [fixture.makeAccountAdapter(ports.options)]
            );

            const plan = yield* fixture.createPlan(
              service,
              opened,
              fixture.accountOperationArguments(
                yield* opened.agentService.identity
              ),
              fixture.accountOperationScope(),
              { ...fixture.accountBounds, maxRequests: 1 }
            );

            const applied = yield* applyAccount(
              service,
              fixture.applyInput(plan, "fixture.s03.account.request-cap")
            );

            const snapshot = yield* snapshotAll(opened);
            const [step] = applied.receipt.steps;

            expect(ports.requests.map((request) => request.page)).toEqual([1]);
            expect(
              snapshot.events,
              JSON.stringify(applied.receipt)
            ).toHaveLength(100);
            expect(
              snapshot.events.every((event) => event.origin === "fixture")
            ).toBe(true);
            expect(step?.state).toBe("partial");
            expect(step?.inserted).toBe(100);
            expect(step?.committedThrough).not.toBeNull();
            expect(step?.safeCursor).toBeNull();
            expect(step?.remainingWork).not.toBeNull();
            expect(applied.receipt.resources.requests).toBe(1);
            expect(applied.receipt.resources.recordsDecoded).toBe(200);
            expect(applied.receipt.resources.bytesRead).toBe(reply.bytesRead);
            expect(applied.receipt.effects.filesChanged).toEqual([]);
          })
        )
    );

    it.effect(
      "the cumulative byte cap stops the next body before decoding and retains earlier rows",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* byteCap() {
            yield* TestClock.setTime(1_700_000_010_000);

            const firstPage = fixturePage(
              fixtureRows(100, "byte-cap-first"),
              200
            );

            const secondPage = fixturePage(
              fixtureRows(100, "byte-cap-second"),
              200
            );

            const ports = fixturePorts(
              fixture.makeAccountTransport,
              opened,
              root,
              (page) => (page === 1 ? firstPage : secondPage),
              undefined,
              true,
              (page, body) => {
                const bytes = new TextEncoder().encode(body);

                return page === 1
                  ? [bytes]
                  : [bytes.subarray(0, 1), bytes.subarray(1)];
              }
            );

            const service = yield* fixture.makeOperationService(
              opened.agentService,
              [fixture.makeAccountAdapter(ports.options)]
            );

            const plan = yield* fixture.createPlan(
              service,
              opened,
              fixture.accountOperationArguments(
                yield* opened.agentService.identity
              ),
              fixture.accountOperationScope(),
              { ...fixture.accountBounds, maxBytes: firstPage.bytesRead + 1 }
            );

            const applied = yield* applyAccount(
              service,
              fixture.applyInput(plan, "fixture.s03.account.byte-cap")
            );

            const snapshot = yield* snapshotAll(opened);

            expect(ports.requests.map((request) => request.page)).toEqual([
              1, 2,
            ]);
            expect(ports.requests[1]?.limits.maxBytes).toBe(1);
            expect(ports.streamReads()).toBe(3);
            expect(ports.streamCancels()).toBe(2);
            expect(ports.releasedReaders()).toBe(2);
            expect(
              snapshot.events,
              JSON.stringify(applied.receipt)
            ).toHaveLength(100);
            expect(
              snapshot.events.every(
                (event) =>
                  event.identity.requestId?.includes("byte-cap-first") ?? false
              )
            ).toBe(true);
            expect(applied.receipt.steps[0]?.state).toBe("partial");
            expect(applied.receipt.steps[0]?.inserted).toBe(100);
            expect(applied.receipt.steps[0]?.safeCursor).toBeNull();
            expect(applied.receipt.resources.bytesRead).toBe(
              firstPage.bytesRead + 1
            );
            expect(applied.receipt.resources.recordsDecoded).toBe(200);
            expect(applied.receipt.resources.requests).toBe(2);
            expect(applied.receipt.effects.filesChanged).toEqual([]);
          })
        )
    );

    it.effect(
      "the remaining record allowance bounds the next response before decoding",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* recordCap() {
            yield* TestClock.setTime(1_700_000_010_000);

            const firstPage = fixturePage(
              fixtureRows(100, "record-cap-first"),
              200
            );

            const secondPage = fixturePage(
              fixtureRows(100, "record-cap-second"),
              200
            );

            const recordAllowance = firstPage.bytesRead + 1;
            const remainingAllowance = recordAllowance - 100;

            const ports = fixturePorts(
              fixture.makeAccountTransport,
              opened,
              root,
              (page) => (page === 1 ? firstPage : secondPage),
              undefined,
              true,
              (page, body) => {
                const bytes = new TextEncoder().encode(body);

                return page === 1
                  ? [bytes]
                  : [
                      bytes.subarray(0, remainingAllowance),
                      bytes.subarray(remainingAllowance),
                    ];
              }
            );

            const service = yield* fixture.makeOperationService(
              opened.agentService,
              [fixture.makeAccountAdapter(ports.options)]
            );

            const plan = yield* fixture.createPlan(
              service,
              opened,
              fixture.accountOperationArguments(
                yield* opened.agentService.identity
              ),
              fixture.accountOperationScope(),
              { ...fixture.accountBounds, maxRecords: recordAllowance }
            );

            const applied = yield* applyAccount(
              service,
              fixture.applyInput(plan, "fixture.s03.account.record-cap")
            );

            expect(ports.requests.map((request) => request.page)).toEqual([
              1, 2,
            ]);
            expect(ports.requests[1]?.limits.maxBytes).toBe(remainingAllowance);
            expect(ports.streamReads()).toBe(3);
            expect(ports.streamCancels()).toBe(2);
            expect(ports.releasedReaders()).toBe(2);
            expect(
              (yield* snapshotAll(opened)).events,
              JSON.stringify(applied.receipt)
            ).toHaveLength(100);
            expect(applied.receipt.steps[0]?.state).toBe("partial");
            expect(applied.receipt.steps[0]?.inserted).toBe(100);
            expect(applied.receipt.steps[0]?.safeCursor).toBeNull();
            expect(applied.receipt.resources.recordsDecoded).toBe(200);
            expect(applied.receipt.resources.requests).toBe(2);
            expect(applied.receipt.effects.filesChanged).toEqual([]);
          })
        )
    );

    it.effect(
      "HTTP authentication failure leaves unavailable rows and no checkpoint",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* unavailableHttp() {
            yield* TestClock.setTime(1_700_000_010_000);

            const ports = fixturePorts(
              fixture.makeAccountTransport,
              opened,
              root,
              () => ({
                body: "synthetic HTTP 401",
                bytesRead: 18,
                reason: null,
                status: 401,
              })
            );

            const service = yield* fixture.makeOperationService(
              opened.agentService,
              [fixture.makeAccountAdapter(ports.options)]
            );

            const plan = yield* fixture.createPlan(
              service,
              opened,
              fixture.accountOperationArguments(
                yield* opened.agentService.identity
              ),
              fixture.accountOperationScope(),
              fixture.accountBounds
            );

            const applied = yield* applyAccount(
              service,
              fixture.applyInput(plan, "fixture.s03.account.http-unavailable")
            );

            expect(ports.requests).toHaveLength(1);
            expect(ports.streamCancels()).toBe(1);
            expect(ports.releasedReaders()).toBe(1);
            expect((yield* snapshotAll(opened)).events).toHaveLength(0);
            expect(applied.receipt.steps[0]?.state).toBe("unavailable");
            expect(applied.receipt.steps[0]?.rejected).toBeNull();
            expect(applied.receipt.steps[0]?.safeCursor).toBeNull();
            expect(applied.receipt.steps[0]?.committedThrough).toBeNull();
            expect(applied.receipt.resources.requests).toBe(1);
            expect(applied.receipt.resources.recordsDecoded).toBe(0);
            expect(applied.receipt.effects.filesChanged).toEqual([]);
            expect(JSON.stringify(applied.receipt)).not.toContain(
              "synthetic-s03-account-token"
            );
          })
        )
    );

    it.effect(
      "missing credentials leave unavailable counts and no HTTP or checkpoint",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* missingCredentials() {
            yield* TestClock.setTime(1_700_000_010_000);

            const ports = fixturePorts(
              fixture.makeAccountTransport,
              opened,
              root,
              () => fixturePage(fixtureRows(1, "missing-credentials")),
              null
            );

            const service = yield* fixture.makeOperationService(
              opened.agentService,
              [fixture.makeAccountAdapter(ports.options)]
            );

            const plan = yield* fixture.createPlan(
              service,
              opened,
              fixture.accountOperationArguments(
                yield* opened.agentService.identity
              ),
              fixture.accountOperationScope(),
              fixture.accountBounds
            );

            const applied = yield* applyAccount(
              service,
              fixture.applyInput(plan, "fixture.s03.account.no-credentials")
            );

            expect(ports.credentialCalls()).toBe(1);
            expect(ports.requests).toHaveLength(0);
            expect((yield* snapshotAll(opened)).events).toHaveLength(0);
            expect(applied.receipt.steps[0]?.state).toBe("unavailable");
            expect(applied.receipt.steps[0]?.rejected).toBeNull();
            expect(applied.receipt.steps[0]?.safeCursor).toBeNull();
            expect(applied.receipt.steps[0]?.committedThrough).toBeNull();
            expect(applied.receipt.resources.requests).toBe(0);
            expect(applied.receipt.effects.filesChanged).toEqual([]);
            expect(
              applied.receipt.steps[0]?.gaps.some((gap) =>
                /logged in/u.test(gap)
              )
            ).toBe(true);
          })
        )
    );

    it.effect(
      "denied enrollment stops before credentials and network acquisition",
      () =>
        fixture.withFixtureStore((opened, root) =>
          Effect.gen(function* deniedEnrollment() {
            yield* TestClock.setTime(1_700_000_010_000);

            const ports = fixturePorts(
              fixture.makeAccountTransport,
              opened,
              root,
              () => fixturePage([]),
              null,
              false
            );

            const service = yield* fixture.makeOperationService(
              opened.agentService,
              [fixture.makeAccountAdapter(ports.options)]
            );

            const plan = yield* fixture.createPlan(
              service,
              opened,
              fixture.accountOperationArguments(
                yield* opened.agentService.identity
              ),
              fixture.accountOperationScope(),
              fixture.accountBounds
            );

            const failure = yield* service
              .run(fixture.applyInput(plan, "fixture.s03.account.denied"))
              .pipe(Effect.flip);

            expect(failure._tag).toBe("AgentError");
            expect(failure).toHaveProperty("code", "authorization-required");
            expect(ports.credentialCalls()).toBe(0);
            expect(ports.requests).toHaveLength(0);
            expect((yield* snapshotAll(opened)).events).toHaveLength(0);
          })
        )
    );
  });
};

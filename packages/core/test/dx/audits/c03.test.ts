import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, FileSystem, Path } from "effect";

import { collectGitIdentity } from "../../../src/dx/collectors/git-identity/collector.js";
import { gitRunFor } from "../../../src/dx/collectors/git-identity/git-runner.js";
import type { CollectInput } from "../../../src/dx/contracts/services.js";
import { correlateFlights } from "../../../src/dx/correlation/flight/correlator.js";
import {
  canonicalizePath,
  repoMapForPath,
} from "../../../src/dx/correlation/repo/git-dir.js";
import { correlateContext } from "../../../src/dx/correlation/repo/worktree-map.js";
import {
  EVENT_SCHEMA_VERSION,
  emptyEventIdentity,
  emptyFlightContext,
} from "../../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../../src/dx/model/event.js";
import { EventIdSchema } from "../../../src/dx/model/ids.js";

const GIT_CONFIG = [
  "-c",
  "user.name=Fixture",
  "-c",
  "user.email=fixture@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
];

const ISO_PREFIX = /^\d{4}-\d{2}-\d{2}T/u;

const inputFor = (selectedInput: string): CollectInput => ({
  adapterId: "git-identity",
  context: emptyFlightContext,
  cursor: null,
  origin: "live",
  scratchDir: null,
  selectedInput,
});

const git = Effect.fn("c03.git")(function* git(
  cwd: string,
  args: readonly string[]
) {
  const run = yield* gitRunFor(cwd);
  const result = yield* run([...GIT_CONFIG, ...args]);
  expect(result.exitCode, `git ${args.join(" ")}`).toBe(0);

  return result.stdout.trim();
});

const commitFile = Effect.fn("c03.commit")(function* commitFile(
  repo: string,
  name: string,
  message: string
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs.writeFileString(path.join(repo, name), `${message}\n`);
  yield* git(repo, ["add", name]);
  yield* git(repo, ["commit", "-q", "-m", message]);

  return yield* git(repo, ["rev-parse", "HEAD"]);
});

const makeRepo = Effect.fn("c03.makeRepo")(function* makeRepo() {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped();
  const repo = path.join(root, "repo");
  yield* fs.makeDirectory(repo);
  yield* git(repo, ["init", "-q", "-b", "main"]);
  const mainSha = yield* commitFile(repo, "a.txt", "base");

  return { mainSha, repo, root };
});

const collectOne = Effect.fn("c03.collectOne")(function* collectOne(
  repo: string
) {
  const batch = yield* collectGitIdentity(inputFor(repo));
  expect(batch.events).toHaveLength(1);
  const [event] = batch.events;

  if (event === undefined) {
    return yield* Effect.die("no event");
  }

  return { batch, event };
});

const at = (event: DxEventEnvelope, iso: string): DxEventEnvelope => ({
  ...event,
  occurredAt: iso,
});

const marker = (
  kind: "marker.start" | "marker.stop",
  id: string,
  iso: string,
  repoCommonDir: string,
  branch: string
): DxEventEnvelope => ({
  acquisition: "manual",
  adapterId: "c03-marker",
  adapterVersion: "1",
  ai: null,
  context: {
    branch,
    flightId: null,
    headSha: null,
    repoCommonDir,
    worktreePath: null,
  },
  eventId: EventIdSchema.make(`c03:${id}`),
  evidence: { bounded: true, hash: null, ref: `fixture:${id}` },
  fieldSemantics: [],
  identity: emptyEventIdentity,
  kind,
  observedAt: iso,
  occurredAt: iso,
  occurredAtPrecision: "second",
  origin: "synthetic",
  payload: {},
  schemaVersion: EVENT_SCHEMA_VERSION,
  sourceVersion: null,
  upstreamKey: id,
  usage: null,
});

const targetOf = (
  events: readonly DxEventEnvelope[],
  mappings: readonly { key: string; value: string }[] = []
) => {
  const { correlations, registry } = correlateFlights(events, mappings);

  return {
    byId: (id: string) => correlations.find((c) => c.eventId === id),
    correlations,
    registry,
  };
};

it.layer(NodeServices.layer)("C03 identity audit on real Git", (test) => {
  test.effect(
    "linked worktrees share one repo but keep separate worktree, branch and flight",
    () =>
      Effect.gen(function* worktrees() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const { repo, root } = yield* makeRepo();
        const wtA = path.join(root, "wt-a");
        const wtB = path.join(root, "wt-b");
        yield* git(repo, ["worktree", "add", "-q", "-b", "feat/a", wtA]);
        yield* git(repo, ["worktree", "add", "-q", "-b", "feat/b", wtB]);
        yield* commitFile(wtA, "a2.txt", "a work");

        const a = yield* collectOne(wtA);
        const b = yield* collectOne(wtB);
        expect(a.event.context.repoCommonDir).toBe(
          b.event.context.repoCommonDir
        );
        expect(a.event.context.worktreePath).not.toBe(
          b.event.context.worktreePath
        );
        expect(a.event.context.branch).toBe("feat/a");
        expect(b.event.context.branch).toBe("feat/b");
        expect(a.event.payload.worktreeCount).toBe(3);

        const found = yield* repoMapForPath(repo);
        expect(found).not.toBe(null);
        const edited = yield* canonicalizePath(path.join(wtA, "a2.txt"));

        const mapped = correlateContext(
          found === null ? [] : [found.map],
          emptyFlightContext,
          [edited ?? ""]
        );

        expect(mapped.assignment).toBe("assigned");
        expect(mapped.context.branch).toBe("feat/a");
        expect(mapped.context.repoCommonDir).toBe(
          a.event.context.repoCommonDir
        );

        const both = correlateContext(
          found === null ? [] : [found.map],
          emptyFlightContext,
          [edited ?? "", (yield* canonicalizePath(wtB)) ?? ""]
        );

        expect(both.assignment).not.toBe("assigned");

        const flights = targetOf([
          at(a.event, "2026-09-30T10:00:00Z"),
          at(b.event, "2026-09-30T10:01:00Z"),
        ]);

        const ta = flights.byId(a.event.eventId);
        const tb = flights.byId(b.event.eventId);
        expect(ta?.attribution).toBe("provisional");
        expect(ta?.target).not.toBe(null);
        expect(ta?.target).not.toBe(tb?.target);

        yield* git(repo, ["worktree", "remove", "--force", wtB]);
        expect(yield* fs.exists(wtB)).toBe(false);
        const after = yield* collectOne(wtA);
        expect(after.event.context.repoCommonDir).toBe(
          a.event.context.repoCommonDir
        );
        expect(after.event.payload.worktreeCount).toBe(2);
      })
  );

  it.live(
    "branch reuse after delete gets a new flight only when reflog creation time changes",
    () =>
      Effect.gen(function* reuse() {
        const { repo } = yield* makeRepo();
        yield* git(repo, ["switch", "-q", "-c", "feat/reuse"]);
        yield* commitFile(repo, "r1.txt", "first life");
        const first = yield* collectOne(repo);
        const firstCreated = first.event.payload.branchCreatedAt;
        expect(String(firstCreated)).toMatch(ISO_PREFIX);

        yield* git(repo, ["switch", "-q", "main"]);
        yield* git(repo, ["branch", "-q", "-D", "feat/reuse"]);
        yield* Effect.sleep("1100 millis");
        yield* git(repo, ["switch", "-q", "-c", "feat/reuse"]);
        yield* commitFile(repo, "r2.txt", "second life");
        const second = yield* collectOne(repo);
        const secondCreated = second.event.payload.branchCreatedAt;
        expect(String(secondCreated)).toMatch(ISO_PREFIX);
        expect(secondCreated).not.toBe(firstCreated);

        const flights = targetOf([
          at(first.event, "2026-09-30T10:00:00Z"),
          at(second.event, "2026-09-30T11:00:00Z"),
        ]);

        const t1 = flights.byId(first.event.eventId)?.target;
        const t2 = flights.byId(second.event.eventId)?.target;
        expect(t1).not.toBe(null);
        expect(t2).not.toBe(null);
        expect(t1).not.toBe(t2);
        expect(
          flights.registry.flights.filter((f) =>
            f.aliases.includes("feat/reuse")
          )
        ).toHaveLength(2);
      }).pipe(Effect.provide(NodeServices.layer))
  );

  it.live(
    "FINDING: branch reuse at the same HEAD collides on eventId (branchCreatedAt not in upstreamKey)",
    () =>
      Effect.gen(function* reuseSameHead() {
        const { repo } = yield* makeRepo();
        yield* git(repo, ["switch", "-q", "-c", "feat/same"]);
        const first = yield* collectOne(repo);
        yield* git(repo, ["switch", "-q", "main"]);
        yield* git(repo, ["branch", "-q", "-D", "feat/same"]);
        yield* Effect.sleep("1100 millis");
        yield* git(repo, ["switch", "-q", "-c", "feat/same"]);
        const second = yield* collectOne(repo);

        expect(second.event.payload.branchCreatedAt).not.toBe(
          first.event.payload.branchCreatedAt
        );
        expect(second.event.eventId).toBe(first.event.eventId);
      }).pipe(Effect.provide(NodeServices.layer))
  );

  test.effect(
    "branch rename keeps reflog creation time; flight continuity needs an explicit alias",
    () =>
      Effect.gen(function* rename() {
        const { repo } = yield* makeRepo();
        yield* git(repo, ["switch", "-q", "-c", "feat/old"]);
        yield* commitFile(repo, "o.txt", "old");
        const before = yield* collectOne(repo);
        yield* git(repo, ["branch", "-m", "feat/old", "feat/new"]);
        const after = yield* collectOne(repo);
        const repoDir = before.event.context.repoCommonDir ?? "";

        expect(after.event.context.branch).toBe("feat/new");
        expect(after.event.payload.branchCreatedAt).toBe(
          before.event.payload.branchCreatedAt
        );
        expect(after.event.context.headSha).toBe(before.event.context.headSha);

        const implicit = targetOf([
          at(before.event, "2026-09-30T10:00:00Z"),
          at(after.event, "2026-09-30T10:05:00Z"),
        ]);

        expect(implicit.byId(before.event.eventId)?.target).not.toBe(
          implicit.byId(after.event.eventId)?.target
        );

        const start = marker(
          "marker.start",
          "rename-start",
          "2026-09-30T09:59:00Z",
          repoDir,
          "feat/old"
        );

        const first = targetOf([start]);
        const flightId = first.byId(start.eventId)?.target ?? "";
        expect(flightId).not.toBe("");

        const events = [
          start,
          at(before.event, "2026-09-30T10:00:00Z"),
          at(after.event, "2026-09-30T10:05:00Z"),
        ];

        const aliased = targetOf(events, [
          { key: "alias:feat/new", value: flightId },
        ]);

        expect(aliased.byId(before.event.eventId)?.target).toBe(flightId);
        expect(aliased.byId(after.event.eventId)?.target).toBe(flightId);
        expect(aliased.byId(after.event.eventId)?.attribution).toBe("strong");
      })
  );

  test.effect(
    "rebase moves head and base SHA but keeps branch creation and implicit flight",
    () =>
      Effect.gen(function* rebase() {
        const { mainSha, repo } = yield* makeRepo();
        yield* git(repo, ["switch", "-q", "-c", "feat/rb"]);
        yield* commitFile(repo, "f.txt", "feature");
        const before = yield* collectOne(repo);
        expect(before.event.payload.baseSha).toBe(mainSha);

        yield* git(repo, ["switch", "-q", "main"]);
        const newMain = yield* commitFile(repo, "m.txt", "main moved");
        yield* git(repo, ["switch", "-q", "feat/rb"]);
        yield* git(repo, ["rebase", "-q", "main"]);
        const after = yield* collectOne(repo);

        expect(after.event.context.headSha).not.toBe(
          before.event.context.headSha
        );
        expect(after.event.payload.baseSha).toBe(newMain);
        expect(after.event.payload.aheadCount).toBe(1);
        expect(after.event.payload.branchCreatedAt).toBe(
          before.event.payload.branchCreatedAt
        );
        expect(after.event.eventId).not.toBe(before.event.eventId);

        const flights = targetOf([
          at(before.event, "2026-09-30T10:00:00Z"),
          at(after.event, "2026-09-30T10:30:00Z"),
        ]);

        expect(flights.byId(before.event.eventId)?.target).toBe(
          flights.byId(after.event.eventId)?.target
        );
      })
  );

  test.effect(
    "forks/clones with the same branch name stay separate repositories and flights",
    () =>
      Effect.gen(function* forks() {
        const path = yield* Path.Path;
        const { repo, root } = yield* makeRepo();
        const fork = path.join(root, "fork");
        yield* git(root, ["clone", "-q", repo, fork]);
        yield* git(repo, ["switch", "-q", "-c", "feat/shared"]);
        yield* git(fork, ["switch", "-q", "-c", "feat/shared"]);

        const up = yield* collectOne(repo);
        const down = yield* collectOne(fork);
        expect(up.event.context.headSha).toBe(down.event.context.headSha);
        expect(up.event.context.repoCommonDir).not.toBe(
          down.event.context.repoCommonDir
        );
        expect(down.event.payload.baseSource).toBe("origin-head");
        expect(up.event.eventId).not.toBe(down.event.eventId);

        const flights = targetOf([
          at(up.event, "2026-09-30T10:00:00Z"),
          at(down.event, "2026-09-30T10:00:00Z"),
        ]);

        expect(flights.byId(up.event.eventId)?.target).not.toBe(
          flights.byId(down.event.eventId)?.target
        );

        const upMap = yield* repoMapForPath(repo);
        const forkFile = yield* canonicalizePath(path.join(fork, "a.txt"));

        const cross = correlateContext(
          upMap === null ? [] : [upMap.map],
          emptyFlightContext,
          [forkFile ?? ""]
        );

        expect(cross.assignment).toBe("unassigned");
      })
  );

  test.effect("detached HEAD is never attributed to a branch flight", () =>
    Effect.gen(function* detached() {
      const path = yield* Path.Path;
      const { repo, root } = yield* makeRepo();
      yield* git(repo, ["switch", "-q", "-c", "feat/x"]);
      const onBranch = yield* collectOne(repo);
      yield* git(repo, ["switch", "-q", "--detach"]);
      const det = yield* collectOne(repo);
      expect(det.event.context.branch).toBe(null);
      expect(det.event.payload.detached).toBe(true);
      expect(det.batch.coverage.state).toBe("partial");

      const wt = path.join(root, "wt-det");
      yield* git(repo, ["worktree", "add", "-q", "--detach", wt]);
      const detWt = yield* collectOne(wt);
      expect(detWt.event.context.branch).toBe(null);

      const flights = targetOf([
        at(onBranch.event, "2026-09-30T10:00:00Z"),
        at(det.event, "2026-09-30T10:01:00Z"),
        at(detWt.event, "2026-09-30T10:02:00Z"),
      ]);

      expect(flights.byId(det.event.eventId)?.attribution).toBe("unassigned");
      expect(flights.byId(det.event.eventId)?.target).toBe(null);
      expect(flights.byId(detWt.event.eventId)?.attribution).toBe("unassigned");

      const found = yield* repoMapForPath(wt);

      const mapped = correlateContext(
        found === null ? [] : [found.map],
        emptyFlightContext,
        [(yield* canonicalizePath(wt)) ?? ""]
      );

      expect(mapped.assignment).toBe("detached");
      expect(mapped.context.branch).toBe(null);
    })
  );

  test.effect(
    "unborn HEAD (no commits) keeps the branch but reports head as unavailable",
    () =>
      Effect.gen(function* unborn() {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const root = yield* fs.makeTempDirectoryScoped();
        const repo = path.join(root, "empty");
        yield* fs.makeDirectory(repo);
        yield* git(repo, ["init", "-q", "-b", "feat/unborn"]);

        const exit = yield* Effect.exit(collectGitIdentity(inputFor(repo)));
        expect(Exit.isSuccess(exit)).toBe(true);

        if (Exit.isSuccess(exit)) {
          const [event] = exit.value.events;
          expect(event?.context.headSha).toBe(null);
          expect(event?.context.branch).toBe("feat/unborn");
          expect(event?.payload.baseSha).toBe(null);
          expect(exit.value.coverage.state).toBe("partial");
          expect(exit.value.coverage.gaps.map((g) => g.code)).toContain(
            "unavailable:headSha"
          );
        }

        const found = yield* repoMapForPath(repo);
        expect(found).not.toBe(null);
      })
  );
});

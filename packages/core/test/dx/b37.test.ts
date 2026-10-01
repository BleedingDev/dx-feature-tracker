// @effect-diagnostics nodeBuiltinImport:off -- This test reads the committed B37 fixture file from disk.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import type { StoreSnapshot } from "../../src/dx/contracts/services.js";
import { ModuleDescriptorSchema } from "../../src/dx/model/descriptor.js";
import type { DxEventEnvelope } from "../../src/dx/model/event.js";
import {
  emptyEventIdentity,
  emptyFlightContext,
  EventKindSchema,
} from "../../src/dx/model/event.js";
import { EventIdSchema } from "../../src/dx/model/ids.js";
import { EvidenceItemSchema } from "../../src/dx/model/report.js";
import { evidenceReportDescriptor } from "../../src/dx/reports/evidence/descriptor.js";
import {
  boundRef,
  excerptPayload,
  MAX_EXCERPT_CHARS,
  MAX_REF_CHARS,
  redactText,
} from "../../src/dx/reports/evidence/redact.js";
import {
  lookupEvidence,
  MAX_EVIDENCE_IDS,
  resolveEvidence,
} from "../../src/dx/reports/evidence/resolve.js";
import {
  emptyCoverage,
  emptySelector,
  fakeManifest,
  makeFakeEventStore,
} from "./fakes.js";

const FixtureSchema = Schema.Struct({
  events: Schema.Array(
    Schema.Struct({
      adapterId: Schema.String,
      hash: Schema.NullOr(Schema.String),
      id: Schema.String,
      kind: EventKindSchema,
      payload: Schema.Record(Schema.String, Schema.Unknown),
      ref: Schema.String,
    })
  ),
  note: Schema.String,
  origin: Schema.Literal("fixture"),
});

const fixture = Schema.decodeUnknownSync(FixtureSchema)(
  JSON.parse(
    readFileSync(
      path.join(import.meta.dirname, "fixtures/b37/b37-events.json"),
      "utf-8"
    )
  )
);

const toEnvelope = (
  entry: (typeof fixture.events)[number],
  overrides: Partial<DxEventEnvelope> = {}
): DxEventEnvelope => ({
  acquisition: "file-import",
  adapterId: entry.adapterId,
  adapterVersion: "fixture",
  ai: null,
  context: emptyFlightContext,
  eventId: EventIdSchema.make(entry.id),
  evidence: { bounded: true, hash: entry.hash, ref: entry.ref },
  fieldSemantics: [],
  identity: emptyEventIdentity,
  kind: entry.kind,
  observedAt: "2026-09-30T12:00:00.000Z",
  occurredAt: "2026-09-30T12:00:00.000Z",
  occurredAtPrecision: "exact",
  origin: "fixture",
  payload: entry.payload,
  schemaVersion: "dx.event.v2",
  sourceVersion: null,
  upstreamKey: entry.id,
  usage: null,
  ...overrides,
});

const must = <A>(value: A | undefined): A => {
  if (value === undefined) {
    throw new Error("b37 fixture entry missing");
  }

  return value;
};

const events = fixture.events.map((entry) => toEnvelope(entry));

const snapshotOf = (
  list: readonly DxEventEnvelope[],
  id = "b37-snap"
): StoreSnapshot => ({
  coverage: [],
  events: list,
  manifest: fakeManifest(id),
});

const fakeGithubToken = ["ghp", "_", "A".repeat(36)].join("");

const fakeOpenAiKey = ["sk", "-", "proj", "B".repeat(24)].join("");

const fakeJwt = [
  "eyJ",
  "hbGciOiJI",
  ".",
  "eyJ",
  "zdWIiOiIx",
  ".",
  "SflKxwRJSMeKKF2QT4",
].join("");

const assertNoSecrets = (text: string): void => {
  expect(text).not.toContain(fakeGithubToken);
  expect(text).not.toContain(fakeOpenAiKey);
  expect(text).not.toContain(fakeJwt);
  expect(text).not.toContain("hunter2");
  expect(text).not.toContain("fixture-user");
  expect(text).not.toContain("dev@example.com");
};

describe("b37 redaction", () => {
  it("scrubs token, key, jwt, credential, email and home path shapes", () => {
    const raw = `auth ${fakeGithubToken} key=${fakeOpenAiKey} jwt ${fakeJwt} password=hunter2 mail dev@example.com at /Users/fixture-user/repo`;
    const result = redactText(raw);
    expect(result.redacted).toBe(true);
    assertNoSecrets(result.text);
    expect(result.text).toContain("~/repo");
    expect(redactText("plain metadata").redacted).toBe(false);
  });

  it("scrubs values behind compound secret labels", () => {
    const secret = ["fixture", "Secret", "Value", "9"].join("");

    const labels = [
      "AWS_SECRET_ACCESS_KEY",
      "GITHUB_TOKEN",
      "NPM_AUTH_TOKEN",
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "DB_PASSWORD",
      "PGPASSWORD",
      "MYSQL_PWD",
      "STRIPE_SECRET_KEY",
      "SLACK_BOT_TOKEN",
      "JWT_SECRET",
      "CLIENT_SECRET",
      "PRIVATE_KEY",
      "aws_secret_access_key",
      "_authToken",
      "db.password",
      "x-api-key",
    ];

    for (const label of labels) {
      for (const pair of [
        `${label}=${secret}`,
        `${label}: ${secret}`,
        `export ${label}="${secret}"`,
        `"${label}": "${secret}"`,
        `--${label.toLowerCase()}=${secret}`,
      ]) {
        const result = redactText(`run ${pair} now`);

        expect(result.text, pair).not.toContain(secret);
        expect(result.redacted, pair).toBe(true);
      }
    }

    expect(redactText(`AWS_SECRET_ACCESS_KEY=${secret}`).text).toBe(
      "AWS_SECRET_ACCESS_KEY=[redacted]"
    );
  });

  it("keeps token counts and other labels that are not secrets", () => {
    for (const plain of [
      "max_tokens=4096",
      "input_tokens: 120",
      "cache_read_input_tokens=5",
      "tokenizer=cl100k",
      "AWS_ACCESS_KEY_ID_COUNT is unrelated",
      "branch: feat/token-refresh",
      "model=claude-sonnet-5",
    ]) {
      expect(redactText(plain), plain).toEqual({
        redacted: false,
        text: plain,
      });
    }
  });

  it("scrubs values behind long dotted or hyphenated secret labels", () => {
    const secret = ["Tr0ub", "4dor", "Fixture"].join("");

    for (const line of [
      `spring.datasource.hikari.maximum-pool-size.connection-test-query.datasource.password=${secret}`,
      `--my-application-database-connection-pool-primary-replica-readonly-password=${secret}`,
      `${"Abcdefgh".repeat(10)}Password=${secret}`,
    ]) {
      const excerpt = excerptPayload({ note: line }).excerpt ?? "";

      expect(excerpt, line).not.toContain(secret);
      expect(redactText(line).text, line).not.toContain(secret);
    }

    expect(
      redactText(
        `spring.datasource.hikari.maximum-pool-size.connection-test-query.datasource.password=${secret}`
      ).text
    ).toBe(
      "spring.datasource.hikari.maximum-pool-size.connection-test-query.datasource.password=[redacted]"
    );
  });

  it("scrubs whole values with spaces, escaped quotes and separators", () => {
    const cases: readonly (readonly [string, readonly string[]])[] = [
      [
        "password: correct horse battery staple",
        ["correct", "horse", "staple"],
      ],
      [String.raw`PASSWORD="ab\"cd efgh"`, ["ab", "cd", "efgh"]],
      [String.raw`PASSWORD='ab\'cd efgh'`, ["cd", "efgh"]],
      ["password=abc;defghij", ["abc", "defghij"]],
      ["password=abc,defghij", ["abc", "defghij"]],
      [`password="unterminated quote value`, ["unterminated", "value"]],
      [`password=ab"cd`, ["cd"]],
    ];

    for (const [line, fragments] of cases) {
      const result = redactText(line);

      for (const fragment of fragments) {
        expect(result.text, line).not.toContain(fragment);
      }

      expect(result.redacted, line).toBe(true);
    }

    expect(redactText("password: correct horse battery staple").text).toBe(
      "password: [redacted]"
    );
    expect(redactText("a=1 password=abc;def b=2").text).toBe(
      "a=1 password=[redacted] b=2"
    );
  });

  it("scrubs short secret labels, flags and command credentials", () => {
    const secret = ["hun", "ter", "2Fixture"].join("");
    const google = ["AIza", "Sy", "D".repeat(33)].join("");

    for (const line of [
      `DB_PASS=${secret}`,
      `db.pass: ${secret}`,
      `passphrase=${secret}`,
      `OPENAI_KEY=${secret}`,
      `STRIPE_KEY: ${secret}`,
      `auth=${secret}`,
      `BASIC_AUTH=${secret}`,
      `authorization=${secret}`,
      `x-auth: ${secret}`,
      `app --password ${secret}`,
      `app --api-key '${secret}'`,
      `app --client-secret "${secret}"`,
      `app --db-pass ${secret}`,
      `app --token ${secret} --verbose`,
      `mysql -u root -p${secret} db`,
      `mysqldump -h host -p'${secret}' db`,
      `sshpass -p ${secret} ssh host`,
      `curl -u admin:${secret} https://example.test`,
      `curl --user admin:${secret} https://example.test`,
      `curl --user=admin:${secret} https://example.test`,
      `curl -uadmin:${secret} https://example.test`,
      `key ${google} end`,
    ]) {
      const result = redactText(line);

      expect(result.text, line).not.toContain(secret);
      expect(result.text, line).not.toContain(google);
      expect(result.redacted, line).toBe(true);
    }

    expect(redactText(`app --password ${secret} --verbose`).text).toBe(
      "app --password [redacted] --verbose"
    );
    expect(redactText(`mysql -u root -p${secret} db`).text).toBe(
      "mysql -u root -p[redacted] db"
    );
    expect(
      redactText(`curl -u admin:${secret} https://example.test`).text
    ).toBe("curl -u [redacted] https://example.test");
  });

  it("keeps identifiers, counts, cwd paths and harmless flags", () => {
    for (const plain of [
      "getUserProfileByIdV2AndOrganizationName42AsyncHandlerFactory",
      "handleRequestForUserAccount2024AndSyncV3Service",
      "token_count: 12345",
      "max_token_limit=8000",
      "token_type: bearer",
      "PWD=/tmp/proj",
      "OLDPWD=~/work",
      "bypass=true",
      "compass: north",
      "docker login --password-stdin registry.example.test",
      "app --token-file ./token.txt",
      "mkdir -p build/out",
      "mysql -P3306 -h db",
      "git push -u origin main",
      "docker run -u 1000:1000 image",
      "sort -u names.txt",
    ]) {
      expect(redactText(plain), plain).toEqual({
        redacted: false,
        text: plain,
      });
    }
  });

  it("redacts large adversarial inputs in bounded time", () => {
    const size = 50_000;
    const started = performance.now();

    for (const input of [
      "a".repeat(size),
      "password".repeat(size / 8),
      `${"-".repeat(size)}password`,
      `${"x.".repeat(size / 2)}=v`,
      "_pass".repeat(size / 5),
      `mysql${" -x".repeat(size / 3)}`,
      `curl${" a".repeat(size / 2)} -u`,
      `password="${String.raw`\a`.repeat(size / 2)}`,
      `--${"token".repeat(size / 5)}`,
      `${"A_".repeat(size / 2)}KEY`,
      `${"x.".repeat(size / 2)}@a.b`,
      `${"a.".repeat(size / 2)}://`,
    ]) {
      redactText(input);
    }

    expect(performance.now() - started).toBeLessThan(5000);
  });

  it("scrubs credentials inside urls in free text", () => {
    const result = redactText(
      "remote https://fixture-user:hunter2@git.example.test/repo.git"
    );

    expect(result.text).toBe(
      "remote https://[redacted]@git.example.test/repo.git"
    );
    expect(result.redacted).toBe(true);
  });

  it("scrubs bare high-entropy secrets but keeps hashes and ids", () => {
    const bare = ["wJalrXUtnFEMI", "/K7MDENG/", "bPxRfiCY", "FIXTURE9KEY"].join(
      ""
    );

    const result = redactText(`aws ${bare} end`);

    expect(result.text).toBe("aws [redacted:secret] end");
    expect(result.redacted).toBe(true);

    for (const plain of [
      "3b3db99f500c603a39b2f776461e0123456789ab",
      "2aaac43f-a7ae-4a43-a8dd-134d29e456cb",
      "msg_01XFDUDYJgAACzvnptvVoYEL",
      "packages/core/src/dx/Collectors2/Harness",
      "src/Components/Button2/Variants/Primary3",
      "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ]) {
      expect(redactText(plain), plain).toEqual({
        redacted: false,
        text: plain,
      });
    }
  });

  it("bounds refs: strips url credentials/query, collapses home, truncates", () => {
    const url = boundRef(
      `https://user:hunter2@example.test/path?token=${fakeGithubToken}#frag`
    );

    expect(url.text).toBe("https://example.test/path");
    expect(url.redacted).toBe(true);
    const long = boundRef(`git:ref/${"x".repeat(1000)}`);
    expect(long.text.length).toBeLessThanOrEqual(MAX_REF_CHARS);
    expect(long.redacted).toBe(true);
    const control = boundRef("git:ref\n/evil\u0007");
    expect(control.text).toBe("git:ref/evil");
    expect(control.redacted).toBe(true);
    const plain = boundRef("git:commit/abc");
    expect(plain).toEqual({ redacted: false, text: "git:commit/abc" });
  });

  it("withholds content fields, redacts secret keys, keeps numeric metadata", () => {
    const result = excerptPayload({
      apiKey: "abc",
      durationMs: 12,
      nested: { authorization: "x", deep: { deeper: 1 }, model: "m" },
      prompt: "tell me everything",
      tags: ["a", "b"],
    });

    expect(result.excerpt).toContain("durationMs=12");
    expect(result.excerpt).toContain("nested.model=m");
    expect(result.excerpt).toContain("prompt=[withheld:18 chars]");
    expect(result.excerpt).toContain("apiKey=[redacted]");
    expect(result.excerpt).toContain("nested.authorization=[redacted]");
    expect(result.excerpt).toContain("tags=[array:2]");
    expect(result.excerpt).not.toContain("tell me everything");
    expect(result.redacted).toBe(true);
  });

  it("bounds oversized payloads and reports dropped fields", () => {
    const payload = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [
        `field${String(index).padStart(2, "0")}`,
        "v".repeat(100),
      ])
    );

    const result = excerptPayload(payload);
    expect(result.excerpt?.length).toBeLessThanOrEqual(MAX_EXCERPT_CHARS);
    expect(result.droppedFields).toBeGreaterThan(0);
    expect(result.redacted).toBe(true);
  });
});

describe("b37 evidence resolution", () => {
  it("returns schema-valid redacted items and never raw content", () => {
    const secretEvent = toEnvelope(must(fixture.events[1]), {
      payload: {
        ...must(fixture.events[1]).payload,
        branchNote: `token ${fakeGithubToken} by dev@example.com`,
      },
    });

    const snapshot = snapshotOf([
      must(events[0]),
      secretEvent,
      must(events[2]),
    ]);

    const result = resolveEvidence(snapshot, [
      "b37-evt-usage",
      "b37-evt-command",
      "b37-evt-empty",
    ]);

    expect(result.snapshotId).toBe("b37-snap");
    expect(result.missing).toEqual([]);
    const decode = Schema.decodeUnknownSync(EvidenceItemSchema);

    for (const item of result.items) {
      decode(item);
      assertNoSecrets(JSON.stringify(item));
      expect(item.origin).toBe("fixture");
    }

    const usage = must(result.items[0]);
    const command = must(result.items[1]);
    const empty = must(result.items[2]);
    expect(usage.excerpt).toContain("usage.inputTokens=1200");
    expect(usage.excerpt).toContain("usage.cachedInputTokens=null");
    expect(usage.excerpt).not.toContain("billing module");
    expect(usage.redacted).toBe(true);
    expect(command.ref).toBe("file://~/work/repo/.dx/spool/cmd-0002.json");
    expect(command.excerpt).toContain("exitCode=1");
    expect(command.excerpt).toContain("cwd=~/work/repo");
    expect(command.excerpt).not.toContain("pnpm test");
    expect(command.excerpt).not.toContain("FAIL");
    expect(empty).toMatchObject({ excerpt: null, redacted: false });
  });

  it("hidden mode returns refs only", () => {
    const result = resolveEvidence(
      snapshotOf(events),
      ["b37-evt-usage"],
      "hidden"
    );

    expect(result.items[0]).toMatchObject({ excerpt: null, redacted: true });
  });

  it("resolves by evidence hash and reports unknown, invalid and over-limit IDs", () => {
    const hashId = must(fixture.events[0]).hash ?? "";

    const extra = Array.from(
      { length: MAX_EVIDENCE_IDS + 2 },
      (_, index) => `pad-${index}`
    );

    const result = resolveEvidence(snapshotOf(events), [
      hashId,
      "does-not-exist",
      "  ",
      ...extra,
    ]);

    expect(result.items.map((item) => item.evidenceId)).toEqual([hashId]);
    const reasons = result.missing.map((miss) => miss.reason);
    expect(reasons).toContain("unknown-in-snapshot");
    expect(reasons).toContain("invalid-id");
    expect(reasons.filter((reason) => reason === "over-limit")).toHaveLength(5);
    expect(result.disclosures.join(" ")).toContain(
      "not returned from snapshot b37-snap"
    );
    expect(result.disclosures.join(" ")).toContain("skipped");
  });

  it("descriptor decodes and is ready", () => {
    const descriptor = Schema.decodeSync(ModuleDescriptorSchema)(
      evidenceReportDescriptor
    );

    expect(descriptor.readiness).toBe("ready");
    expect(descriptor.kind).toBe("report");
  });
});

describe("b37 snapshot pinning", () => {
  it.effect("reuses a requested snapshot ID", () =>
    Effect.gen(function* b37Case() {
      const store = makeFakeEventStore();
      yield* store.append({
        coverage: emptyCoverage("fixture"),
        cursor: null,
        events,
      });
      yield* store.putSnapshotManifest(fakeManifest("b37-pinned"));

      const result = yield* lookupEvidence(store, {
        asOf: null,
        evidenceIds: ["b37-evt-usage"],
        selector: emptySelector,
        snapshotId: "b37-pinned",
      });

      expect(result.snapshotId).toBe("b37-pinned");
      expect(result.items).toHaveLength(1);
      expect(result.disclosures[0]).toContain(
        "Reused requested snapshot b37-pinned"
      );
    })
  );

  it.effect(
    "fails explicitly on unknown snapshot, never substitutes latest",
    () =>
      Effect.gen(function* b37Case() {
        const store = makeFakeEventStore();
        yield* store.putSnapshotManifest(fakeManifest("b37-other"));

        const error = yield* Effect.flip(
          lookupEvidence(store, {
            asOf: null,
            evidenceIds: ["b37-evt-usage"],
            selector: emptySelector,
            snapshotId: "b37-missing",
          })
        );

        expect(error._tag).toBe("SnapshotNotFound");
      })
  );

  it.effect("latest discloses the actual snapshot ID", () =>
    Effect.gen(function* b37Case() {
      const store = makeFakeEventStore();

      const result = yield* lookupEvidence(store, {
        asOf: null,
        evidenceIds: ["b37-evt-usage"],
        selector: emptySelector,
        snapshotId: null,
      });

      expect(result.snapshotId).toBe("fake-current");
      expect(result.disclosures[0]).toContain("latest snapshot fake-current");
      expect(result.missing[0]?.reason).toBe("unknown-in-snapshot");
    })
  );
});

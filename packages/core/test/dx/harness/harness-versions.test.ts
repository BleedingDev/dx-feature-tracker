// @effect-diagnostics nodeBuiltinImport:off -- Each case builds a fake tool install inside an owned temp home with synchronous node:fs before any layer is built.
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import { NodeServices } from "@effect/platform-node";
import { afterAll, describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer } from "effect";

import { everywhere } from "../../../src/dx/harness/contract.js";
import type { SessionRef } from "../../../src/dx/harness/contract.js";
import {
  DeepseekHarness,
  DeepseekStore,
} from "../../../src/dx/harness/deepseek/index.js";
import { HarnessHome } from "../../../src/dx/harness/home.js";
import { PiHarness, PiStore } from "../../../src/dx/harness/pi/index.js";
import { emptyFlightContext } from "../../../src/dx/model/event.js";
import type { DxEventEnvelope } from "../../../src/dx/model/event.js";
import { liveHarnesses } from "./conformance.js";
import { writeFixtureHome } from "./deepseek-fixtures.js";
import { installPiFixtureHome, piFixtureHarness } from "./pi-fixture.js";

const PI_PACKAGE = "@earendil-works/pi-coding-agent";

const DSH_PACKAGE = "@deepseek-ai/dsh";

const owned: string[] = [];

afterAll(() => {
  for (const dir of owned) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const tempHome = (): string => {
  const home = realpathSync(mkdtempSync(path.join(os.tmpdir(), "dft-ver-")));

  owned.push(home);

  return home;
};

interface FakeInstall {
  readonly bin: string;
  readonly binDir: string;
  readonly entry: string;
  readonly packageDir: string;
  readonly packageName: string;
  readonly version: string;
}

const writePackage = (install: FakeInstall): string => {
  const entry = path.join(install.packageDir, install.entry);

  mkdirSync(path.dirname(entry), { recursive: true });
  writeFileSync(entry, "#!/usr/bin/env node\n");
  writeFileSync(
    path.join(install.packageDir, "package.json"),
    JSON.stringify({
      bin: { [install.bin]: install.entry },
      name: install.packageName,
      version: install.version,
    })
  );

  return entry;
};

const linkInstall = (install: FakeInstall): void => {
  const entry = writePackage(install);

  mkdirSync(install.binDir, { recursive: true });
  symlinkSync(
    path.relative(install.binDir, entry),
    path.join(install.binDir, install.bin)
  );
};

const bunPi = (home: string, version: string, packageName = PI_PACKAGE) => {
  linkInstall({
    bin: "pi",
    binDir: path.join(home, ".bun", "bin"),
    entry: "dist/bundle/cli.js",
    packageDir: path.join(
      home,
      ".bun",
      "install",
      "global",
      "node_modules",
      packageName
    ),
    packageName,
    version,
  });
};

const protoDsh = (home: string, node: string, version: string) => {
  linkInstall({
    bin: "dsh",
    binDir: path.join(home, ".proto", "tools", "node", node, "bin"),
    entry: "lib/bin.js",
    packageDir: path.join(
      home,
      ".proto",
      "tools",
      "node",
      node,
      "lib",
      "node_modules",
      DSH_PACKAGE
    ),
    packageName: DSH_PACKAGE,
    version,
  });
};

const withHome = (home: string, env: Readonly<Record<string, string>>) =>
  Layer.mergeAll(
    HarnessHome.at(home),
    NodeServices.layer,
    ConfigProvider.layer(ConfigProvider.fromUnknown(env))
  );

const piVersion = (home: string, env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* piStoreVersion() {
    const store = yield* PiStore;

    return yield* store.version;
  }).pipe(
    Effect.provide(PiStore.layer.pipe(Layer.provide(withHome(home, env))))
  );

const dshVersion = (home: string, env: Readonly<Record<string, string>> = {}) =>
  Effect.gen(function* dshStoreVersion() {
    const store = yield* DeepseekStore;

    return yield* store.version;
  }).pipe(
    Effect.provide(DeepseekStore.layer.pipe(Layer.provide(withHome(home, env))))
  );

describe("pi harness version", () => {
  it.effect("reads the installed package version of a bun global install", () =>
    Effect.gen(function* bunInstall() {
      const home = tempHome();

      bunPi(home, "0.99.1");

      expect(yield* piVersion(home)).toBe("0.99.1");
    })
  );

  it.effect("follows PATH only for the user's own home", () =>
    Effect.gen(function* onPath() {
      const home = tempHome();
      const prefix = tempHome();

      linkInstall({
        bin: "pi",
        binDir: path.join(prefix, "bin"),
        entry: "dist/cli.js",
        packageDir: path.join(prefix, "lib", "node_modules", PI_PACKAGE),
        packageName: PI_PACKAGE,
        version: "1.2.3",
      });

      const PATH = [
        path.join(prefix, "missing"),
        path.join(prefix, "bin"),
      ].join(path.delimiter);

      expect(yield* piVersion(home, { HOME: home, PATH })).toBe("1.2.3");
      expect(yield* piVersion(home, { HOME: prefix, PATH })).toBeNull();
    })
  );

  it.effect("reads a pnpm shim that points into the global store", () =>
    Effect.gen(function* pnpmShim() {
      const home = tempHome();
      const binDir = path.join(home, ".local", "share", "pnpm", "bin");
      const legacy = "@mariozechner/pi-coding-agent";

      writePackage({
        bin: "pi",
        binDir,
        entry: "dist/cli.js",
        packageDir: path.join(
          home,
          ".local",
          "share",
          "pnpm",
          "global",
          "v11",
          "abc123",
          "node_modules",
          legacy
        ),
        packageName: legacy,
        version: "0.50.0",
      });
      mkdirSync(binDir, { recursive: true });
      writeFileSync(
        path.join(binDir, "pi"),
        `#!/bin/sh\nexec node  "$basedir/../global/v11/abc123/node_modules/${legacy}/dist/cli.js" "$@"\n`
      );

      expect(yield* piVersion(home)).toBe("0.50.0");
    })
  );

  it.effect("ignores a pi binary that belongs to another package", () =>
    Effect.gen(function* otherPackage() {
      const home = tempHome();

      bunPi(home, "14.0.0", "@oh-my-pi/pi-coding-agent");

      expect(yield* piVersion(home)).toBeNull();
    })
  );

  it.effect("is null when Pi is not installed", () =>
    Effect.gen(function* notInstalled() {
      expect(yield* piVersion(tempHome(), { PATH: "" })).toBeNull();
    })
  );

  it.effect("stamps the installed version on every Pi event", () =>
    Effect.gen(function* stamped() {
      const fixture = installPiFixtureHome();

      owned.push(fixture.home);
      bunPi(fixture.home, "0.99.1");

      const events = yield* Effect.gen(function* readAll() {
        const harness = yield* PiHarness;
        const refs = yield* harness.locate(everywhere);

        const batches = yield* Effect.forEach((ref: SessionRef) =>
          harness.read(ref, {
            context: emptyFlightContext,
            cursor: null,
            origin: "fixture",
          })
        )(refs);

        return batches.flatMap((batch) => batch.events);
      }).pipe(Effect.provide(Layer.fresh(piFixtureHarness(fixture.home))));

      const ai = events.flatMap((event: DxEventEnvelope) =>
        event.ai === null ? [] : [event]
      );

      expect(ai.length).toBeGreaterThan(0);
      expect(
        new Set(ai.map((event) => event.ai?.harnessVersion))
      ).toStrictEqual(new Set(["0.99.1"]));
      expect(new Set(ai.map((event) => event.sourceVersion))).toStrictEqual(
        new Set(["0.99.1"])
      );
    })
  );
});

describe("deepseek harness version", () => {
  it.effect("picks the newest Node install that carries dsh", () =>
    Effect.gen(function* protoInstall() {
      const home = tempHome();

      protoDsh(home, "26.9.0", "0.1.0");
      protoDsh(home, "26.10.0", "0.2.0-rc.2");
      mkdirSync(path.join(home, ".proto", "tools", "node", "27.0.0", "bin"), {
        recursive: true,
      });

      expect(yield* dshVersion(home)).toBe("0.2.0-rc.2");
    })
  );

  it.effect("is null when dsh is not installed", () =>
    Effect.gen(function* notInstalled() {
      expect(yield* dshVersion(tempHome(), { PATH: "" })).toBeNull();
    })
  );

  it.effect("stamps the installed version on every DeepSeek event", () =>
    Effect.gen(function* stamped() {
      const home = tempHome();

      protoDsh(home, "26.10.0", "0.2.0-rc.2");
      writeFixtureHome(path.join(home, ".dsh"), ["main"]);

      const events = yield* Effect.gen(function* readAll() {
        const harness = yield* DeepseekHarness;
        const refs = yield* harness.locate(everywhere);

        const batches = yield* Effect.forEach((ref: SessionRef) =>
          harness.read(ref, {
            context: emptyFlightContext,
            cursor: null,
            origin: "fixture",
          })
        )(refs);

        return batches.flatMap((batch) => batch.events);
      }).pipe(
        Effect.provide(
          Layer.fresh(DeepseekHarness.layer).pipe(
            Layer.provide(DeepseekStore.layer),
            Layer.provide(withHome(home, { PATH: "" }))
          )
        )
      );

      const ai = events.flatMap((event: DxEventEnvelope) =>
        event.ai === null ? [] : [event]
      );

      expect(ai.length).toBeGreaterThan(0);
      expect(
        new Set(ai.map((event) => event.ai?.harnessVersion))
      ).toStrictEqual(new Set(["0.2.0-rc.2"]));
    })
  );

  it.effect("serves the version given to the memory store", () =>
    Effect.gen(function* memory() {
      const store = yield* DeepseekStore;

      expect(yield* store.version).toBe("0.2.0-rc.2");
    }).pipe(
      Effect.provide(
        DeepseekStore.memory({ files: [], roots: [], version: "0.2.0-rc.2" })
      )
    )
  );
});

const SEMVER = /^\d+\.\d+\.\d+(?:-[\w.]+)?$/u;

const liveVersion = (store: Effect.Effect<string | null>) =>
  store.pipe(Effect.map((version) => version === null || SEMVER.test(version)));

describe("installed versions on this machine", () => {
  it.effect.skipIf(!liveHarnesses().includes("pi"))(
    "reads the installed Pi version or null",
    () =>
      Effect.gen(function* livePi() {
        const store = yield* PiStore;

        expect(yield* liveVersion(store.version)).toBe(true);
      }).pipe(
        Effect.provide(
          PiStore.layer.pipe(
            Layer.provide(HarnessHome.layer),
            Layer.provide(NodeServices.layer)
          )
        )
      )
  );

  it.effect.skipIf(!liveHarnesses().includes("deepseek"))(
    "reads the installed DeepSeek Harness version or null",
    () =>
      Effect.gen(function* liveDeepseek() {
        const store = yield* DeepseekStore;

        expect(yield* liveVersion(store.version)).toBe(true);
      }).pipe(
        Effect.provide(
          DeepseekStore.layer.pipe(
            Layer.provide(HarnessHome.layer),
            Layer.provide(NodeServices.layer)
          )
        )
      )
  );
});

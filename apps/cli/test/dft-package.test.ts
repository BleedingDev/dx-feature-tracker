// @effect-diagnostics nodeBuiltinImport:off -- Reads the npm package's README and manifest from disk, as the release tarball ships them.
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import { CAPTURE_TOOL_NAMES } from "../src/dft-capture.js";

const packageDir = path.resolve(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "packages",
  "dft-npm"
);

const decodeManifest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ description: Schema.String }))
);

const tools = ["Cursor", ...Object.values(CAPTURE_TOOL_NAMES)];

describe("npm package", () => {
  it("names every tool dft install sets up in the shipped README and description", () => {
    const readme = readFileSync(path.join(packageDir, "README.md"), "utf-8");

    const { description } = decodeManifest(
      readFileSync(path.join(packageDir, "package.json"), "utf-8")
    );

    for (const tool of tools) {
      expect(readme).toContain(tool);
      expect(description).toContain(tool);
    }

    expect(readme).toContain("dft uninstall");
    expect(readme).toContain("--telemetry");
  });
});

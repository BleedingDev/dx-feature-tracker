import { describe, expect, it } from "@effect/vitest";

import type { ModuleDescriptor } from "../../../src/dx/model/descriptor.js";
import {
  admitDescriptors,
  eligibleNodes,
  enabledDescriptorRefs,
  snapshotCompatible,
} from "../../../src/dx/registry/admission.js";
import { fakeDescriptor } from "../fakes.js";

const d = (
  id: string,
  readiness: ModuleDescriptor["readiness"],
  extra: Partial<ModuleDescriptor> = {}
): ModuleDescriptor => ({
  ...fakeDescriptor(id, "collector", "T"),
  fixtureIds: ["fx"],
  readiness,
  version: "1.0.0",
  ...extra,
});

describe("A08 admission", () => {
  it("admits only ready/degraded, keeps disabled listed", () => {
    const r = admitDescriptors([
      d("collector/b", "ready"),
      d("collector/a", "degraded"),
      d("collector/off", "disabled"),
      d("collector/unsup", "unsupported"),
    ]);

    expect(r.admitted.map((x) => x.id)).toEqual(["collector/a", "collector/b"]);
    expect(r.listed).toHaveLength(4);
    expect(r.rejected.map((x) => [x.id, x.reason])).toEqual([
      ["collector/off", "not-ready"],
      ["collector/unsup", "not-ready"],
    ]);
  });

  it("rejects contract mismatch, duplicates and untested modules", () => {
    const r = admitDescriptors(
      [
        d("collector/a", "ready"),
        d("collector/a", "ready"),
        d("collector/old", "ready", { contractVersion: "dx.contracts.v0" }),
        d("collector/nofx", "ready", { fixtureIds: [] }),
      ],
      { requireFixtures: true }
    );

    expect(r.admitted.map((x) => x.id)).toEqual(["collector/a"]);
    expect(r.rejected.map((x) => x.reason)).toEqual([
      "duplicate-id",
      "contract-mismatch",
      "missing-fixture",
    ]);
  });

  it("refuses snapshot recompute when registry changed", () => {
    const v1 = admitDescriptors([d("collector/a", "ready")]);
    const refs = enabledDescriptorRefs(v1);
    expect(snapshotCompatible(refs, v1)).toBe(true);

    const v2 = admitDescriptors([
      d("collector/a", "ready", { version: "2.0.0" }),
    ]);

    expect(snapshotCompatible(refs, v2)).toBe(false);

    const dropped = admitDescriptors([d("collector/a", "disabled")]);
    expect(snapshotCompatible(refs, dropped)).toBe(false);
  });

  it("only ready/degraded nodes are freeze-eligible", () => {
    expect(
      eligibleNodes({
        B01: "ready",
        B05: "degraded",
        B09: "disabled",
        X: "failed",
      })
    ).toEqual(["B01", "B05"]);
  });
});

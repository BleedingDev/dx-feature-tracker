import type { MetricResult } from "../../model/metric.js";

export interface ReviewedMetric {
  readonly metric: MetricResult;
  readonly notes: readonly string[];
}

const WITHHELD_STATES = new Set(["unavailable", "unsupported", "disabled"]);

const keyOf = (m: MetricResult): string =>
  m.checkpoint === null ? m.metricId : `${m.metricId}@${m.checkpoint}`;

export const metricKey = keyOf;

export const reviewMetric = (m: MetricResult): ReviewedMetric => {
  const key = keyOf(m);
  const hasReason = m.reason !== null && m.reason.trim() !== "";

  if (m.value !== null && WITHHELD_STATES.has(m.measurement)) {
    return {
      metric: {
        ...m,
        numerator: null,
        reason: hasReason
          ? m.reason
          : `Producer reported a value with measurement ${m.measurement}; value withheld.`,
        value: null,
      },
      notes: [
        `Metric ${key}: value withheld because measurement is ${m.measurement}.`,
      ],
    };
  }

  if (m.value === null && !hasReason) {
    return {
      metric: {
        ...m,
        measurement: WITHHELD_STATES.has(m.measurement)
          ? m.measurement
          : "unavailable",
        reason: "Producer returned no value and no reason.",
      },
      notes: [`Metric ${key}: unavailable without producer reason.`],
    };
  }

  if (m.method === "estimated" && m.measurement === "measured") {
    return {
      metric: { ...m, measurement: "estimated" },
      notes: [
        `Metric ${key}: estimated value relabelled from measured to estimated.`,
      ],
    };
  }

  return { metric: m, notes: [] };
};

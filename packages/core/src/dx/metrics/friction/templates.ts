export type TemplateValue = string | null;

export const UNAVAILABLE_TEXT = "unavailable";

const renderValue = (value: TemplateValue | undefined): string => {
  if (value === null || value === undefined) {
    return UNAVAILABLE_TEXT;
  }

  return value === "" ? UNAVAILABLE_TEXT : value;
};

export const renderTemplate = (
  template: string,
  values: Readonly<Record<string, TemplateValue>>
): string =>
  template.replaceAll(/\{(?<key>[a-zA-Z]+)\}/gu, (_match, key: string) =>
    renderValue(values[key])
  );

export const count = (value: number | null): string | null =>
  value === null || !Number.isFinite(value) ? null : String(value);

export const percent = (ratio: number | null): string | null =>
  ratio === null || !Number.isFinite(ratio)
    ? null
    : `${Math.round(ratio * 100)}%`;

export const FRICTION_TEMPLATES = {
  commandRepeatedFailure: {
    experiment:
      "Inspect the {count} failed runs of `{command}`; if they share a cause, fix or document the prerequisite, then compare its failure count on the next branch.",
    summary: "`{command}` failed {count} times{branchSuffix}.",
  },
  fileRework: {
    experiment:
      "Review the {count} agent edits to {file}; try giving the agent the target shape up front and check whether the edit count drops on the next comparable change.",
    summary: "{file} was edited by the agent {count} times{branchSuffix}.",
  },
  testFailureRate: {
    experiment:
      "Run the failing suite locally before handing work back to the agent and compare the failure rate across the next branches.",
    summary:
      "{failures} of {runs} local test runs failed ({rate}){branchSuffix}.",
  },
  testRepeatedFailure: {
    experiment:
      "Inspect the {count} failing runs of {test}; isolate it (flaky vs. broken) and track whether it still fails after the fix.",
    summary: "{test} failed in {count} separate test runs{branchSuffix}.",
  },
  toolFailureRate: {
    experiment:
      "Inspect the {failures} failed agent tool calls (most frequent: {tool}); check permissions, paths or missing tools, then compare the failure rate on the next session.",
    summary:
      "{failures} of {calls} agent tool calls failed ({rate}){branchSuffix}.",
  },
} as const;

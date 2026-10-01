// oxlint-disable unicorn/consistent-function-scoping -- dashboardStateKit is serialized with toString into the page script, so every helper has to live inside it
export type DashboardMetric =
  | "billed"
  | "estimate"
  | "requests"
  | "tokens"
  | "toolFigure";

export type DashboardFilter = readonly [string, string];

export interface UsageViewState {
  readonly by: string;
  readonly filters: readonly DashboardFilter[];
  readonly metric: DashboardMetric;
  readonly since: string;
  readonly until: string;
}

export interface UsageRoute {
  readonly name: "usage";
  readonly state: UsageViewState;
}

export interface BranchRoute {
  readonly branch: string;
  readonly name: "branch";
  readonly repo: string;
  readonly state: UsageViewState;
}

export interface SetupRoute {
  readonly name: "setup";
  readonly state: UsageViewState;
}

export type DashboardRoute = BranchRoute | SetupRoute | UsageRoute;

export interface DashboardCrumb {
  readonly dimension: string | null;
  readonly hash: string;
  readonly value: string;
}

export interface DashboardStateKit {
  readonly BY_CHOICES: readonly string[];
  readonly FILTER_DIMENSIONS: readonly string[];
  readonly METRICS: readonly DashboardMetric[];
  readonly TABLE_METRICS: readonly string[];
  readonly addDays: (day: string, count: number) => string | null;
  readonly chartQuery: (state: UsageViewState, tz: string) => string;
  readonly crumbs: (state: UsageViewState) => readonly DashboardCrumb[];
  readonly decode: (hash: string) => DashboardRoute;
  readonly drill: (state: UsageViewState, key: string) => DashboardRoute | null;
  readonly encode: (route: DashboardRoute) => string;
  readonly facetQuery: (
    state: UsageViewState,
    tz: string,
    dimension: string
  ) => string;
  readonly segment: (state: UsageViewState) => string;
  readonly sessionLabels: (keys: readonly string[]) => readonly string[];
  readonly shortSession: (key: string) => string;
  readonly tableQuery: (state: UsageViewState, tz: string) => string;
  readonly toolsQuery: (state: UsageViewState, tz: string) => string;
  readonly withFilter: (
    state: UsageViewState,
    dimension: string,
    values: readonly string[]
  ) => UsageViewState;
}

export const dashboardStateKit = (): DashboardStateKit => {
  const FILTER_DIMENSIONS = [
    "tool",
    "provider",
    "via",
    "model",
    "effort",
    "repo",
    "branch",
    "worktree",
    "session",
  ];

  const BY_CHOICES = [
    "tool",
    "provider",
    "via",
    "model",
    "effort",
    "repo",
    "branch",
    "worktree",
    "session",
    "day",
    "week",
  ];

  const METRICS: readonly DashboardMetric[] = [
    "estimate",
    "toolFigure",
    "billed",
    "tokens",
    "requests",
  ];

  const TABLE_METRICS = [
    "tokens",
    "requests",
    "sessions",
    "estimate",
    "toolFigure",
    "billed",
  ];

  const TOOL_METRICS = [
    "tokens",
    "requests",
    "estimate",
    "toolFigure",
    "billed",
  ];

  const SEGMENTS = new Set(["7d", "30d", "all"]);

  const NEXT = new Map([
    ["effort", "model"],
    ["model", "branch"],
    ["provider", "model"],
    ["repo", "branch"],
    ["tool", "model"],
    ["via", "model"],
    ["worktree", "branch"],
  ]);

  const DEFAULT: UsageViewState = {
    by: "tool",
    filters: [],
    metric: "estimate",
    since: "30d",
    until: "",
  };

  const isMetric = (value: string): value is DashboardMetric =>
    METRICS.some((metric) => metric === value);

  const splitHash = (hash: string): readonly [string, URLSearchParams] => {
    const text = hash.replace(/^#/u, "");
    const at = text.indexOf("?");
    const route = (at === -1 ? text : text.slice(0, at)) || "/";

    return [route, new URLSearchParams(at === -1 ? "" : text.slice(at + 1))];
  };

  const stateOf = (params: URLSearchParams): UsageViewState => {
    const by = params.get("by") ?? "";
    const metric = params.get("metric") ?? "";
    const since = (params.get("since") ?? "").trim();
    const until = (params.get("until") ?? "").trim();

    const filters = [...params].flatMap(
      ([name, value]): readonly DashboardFilter[] =>
        FILTER_DIMENSIONS.includes(name) && value !== ""
          ? [[name, value] as const]
          : []
    );

    return {
      by: BY_CHOICES.includes(by) ? by : DEFAULT.by,
      filters,
      metric: isMetric(metric) ? metric : DEFAULT.metric,
      since: since === "" ? DEFAULT.since : since,
      until: SEGMENTS.has(since) ? "" : until,
    };
  };

  const stateParams = (state: UsageViewState): URLSearchParams => {
    const params = new URLSearchParams();

    if (state.since !== DEFAULT.since) {
      params.set("since", state.since);
    }

    if (state.until !== "" && !SEGMENTS.has(state.since)) {
      params.set("until", state.until);
    }

    if (state.by !== DEFAULT.by) {
      params.set("by", state.by);
    }

    if (state.metric !== DEFAULT.metric) {
      params.set("metric", state.metric);
    }

    for (const [name, value] of state.filters) {
      params.append(name, value);
    }

    return params;
  };

  const withQuery = (path: string, params: URLSearchParams): string => {
    const query = params.toString();

    return query === "" ? `#${path}` : `#${path}?${query}`;
  };

  const branchState = (state: UsageViewState): UsageViewState => ({
    ...state,
    filters: [],
  });

  const encode = (route: DashboardRoute): string => {
    const params = stateParams(
      route.name === "branch" ? branchState(route.state) : route.state
    );

    if (route.name === "branch") {
      const branch = new URLSearchParams();

      branch.set("repo", route.repo);
      branch.set("branch", route.branch);

      for (const [name, value] of params) {
        branch.append(name, value);
      }

      return withQuery("/branch", branch);
    }

    return route.name === "setup"
      ? withQuery("/setup", params)
      : withQuery("/", params);
  };

  const decode = (hash: string): DashboardRoute => {
    const [path, params] = splitHash(hash);
    const state = stateOf(params);

    if (path === "/branch") {
      return {
        branch: params.get("branch") ?? "",
        name: "branch",
        repo: params.get("repo") ?? "",
        state: branchState(state),
      };
    }

    return path === "/setup"
      ? { name: "setup", state }
      : { name: "usage", state };
  };

  const segment = (state: UsageViewState): string =>
    SEGMENTS.has(state.since) ? state.since : "custom";

  const apiParams = (
    state: UsageViewState,
    tz: string,
    skip: string | null
  ): URLSearchParams => {
    const params = new URLSearchParams();

    if (state.since !== "all") {
      params.set("since", state.since);
    }

    if (state.until !== "" && !SEGMENTS.has(state.since)) {
      params.set("until", state.until);
    }

    params.set("tz", tz);

    for (const [name, value] of state.filters) {
      if (name !== skip) {
        params.append(name, value);
      }
    }

    return params;
  };

  const isTime = (dimension: string): boolean =>
    dimension === "day" || dimension === "week";

  const tableQuery = (state: UsageViewState, tz: string): string => {
    const params = apiParams(state, tz, null);

    params.set("groupBy", state.by);
    params.set("metrics", TABLE_METRICS.join(","));
    params.set("sortBy", state.metric);
    params.set("limit", isTime(state.by) ? "500" : "25");

    if (isTime(state.by)) {
      params.set("bucket", state.by);
    }

    return params.toString();
  };

  const chartQuery = (state: UsageViewState, tz: string): string => {
    const params = apiParams(state, tz, null);
    const stack = isTime(state.by) ? "tool" : state.by;

    params.set("stackBy", stack);
    params.set("metrics", state.metric);
    params.set("sortBy", state.metric);
    params.set("limit", "6");
    params.set(
      "bucket",
      state.by === "week" || state.since === "all" ? "week" : "day"
    );

    return params.toString();
  };

  const toolsQuery = (state: UsageViewState, tz: string): string => {
    const params = apiParams(state, tz, null);

    params.set("groupBy", "tool");
    params.set("metrics", TOOL_METRICS.join(","));
    params.set("sortBy", state.metric);
    params.set("limit", "50");

    return params.toString();
  };

  const facetQuery = (
    state: UsageViewState,
    tz: string,
    dimension: string
  ): string => {
    const params = apiParams(state, tz, dimension);

    params.set("groupBy", dimension);
    params.set("metrics", ["tokens", "estimate", state.metric].join(","));
    params.set("sortBy", state.metric);
    params.set("limit", "200");

    return params.toString();
  };

  const withFilter = (
    state: UsageViewState,
    dimension: string,
    values: readonly string[]
  ): UsageViewState => {
    const kept = state.filters.filter(([name]) => name !== dimension);
    const at = state.filters.findIndex(([name]) => name === dimension);
    const added = values.map((value): DashboardFilter => [dimension, value]);
    const index = at === -1 ? kept.length : at;

    return {
      ...state,
      filters: [...kept.slice(0, index), ...added, ...kept.slice(index)],
    };
  };

  const valuesOf = (state: UsageViewState, dimension: string) =>
    state.filters.flatMap(([name, value]) =>
      name === dimension ? [value] : []
    );

  const pad = (value: number): string => String(value).padStart(2, "0");

  const ERA_DAYS = 146_097;

  const dayNumber = (year: number, month: number, date: number): number => {
    const shifted = month <= 2 ? year - 1 : year;
    const era = Math.floor(shifted / 400);
    const yearOfEra = shifted - era * 400;

    const dayOfYear = Math.floor((153 * ((month + 9) % 12) + 2) / 5) + date - 1;

    return (
      era * ERA_DAYS +
      yearOfEra * 365 +
      Math.floor(yearOfEra / 4) -
      Math.floor(yearOfEra / 100) +
      dayOfYear
    );
  };

  const civilDay = (days: number): string => {
    const era = Math.floor(days / ERA_DAYS);
    const dayOfEra = days - era * ERA_DAYS;

    const yearOfEra = Math.floor(
      (dayOfEra -
        Math.floor(dayOfEra / 1460) +
        Math.floor(dayOfEra / 36_524) -
        Math.floor(dayOfEra / 146_096)) /
        365
    );

    const dayOfYear =
      dayOfEra -
      (365 * yearOfEra +
        Math.floor(yearOfEra / 4) -
        Math.floor(yearOfEra / 100));

    const shiftedMonth = Math.floor((5 * dayOfYear + 2) / 153);
    const date = dayOfYear - Math.floor((153 * shiftedMonth + 2) / 5) + 1;
    const month = shiftedMonth < 10 ? shiftedMonth + 3 : shiftedMonth - 9;
    const year = yearOfEra + era * 400 + (month <= 2 ? 1 : 0);

    return `${String(year)}-${pad(month)}-${pad(date)}`;
  };

  const addDays = (day: string, count: number): string | null => {
    const match = /^(?<y>\d{4})-(?<m>\d{2})-(?<d>\d{2})$/u.exec(day);

    if (match?.groups === undefined) {
      return null;
    }

    return civilDay(
      dayNumber(
        Number(match.groups.y),
        Number(match.groups.m),
        Number(match.groups.d)
      ) + count
    );
  };

  const UUID_V7 = /^[\da-f]{8}-[\da-f]{4}-7[\da-f]{3}-/iu;

  const shortSession = (key: string): string => {
    if (key.length <= 14) {
      return key;
    }

    return key.slice(0, UUID_V7.test(key) ? 13 : 8);
  };

  const sessionCuts: readonly ((key: string) => string)[] = [
    shortSession,
    (key) => (key.length <= 14 ? key : key.slice(0, 13)),
    (key) => key,
  ];

  const sessionLabels = (keys: readonly string[]): readonly string[] => {
    const levels = sessionCuts.map((cut) => keys.map((key) => cut(key)));

    return keys.map((key, index) => {
      const unique = levels.find((labels) => {
        const label = labels[index];

        return labels.every(
          (other, at) => at === index || other !== label || keys[at] === key
        );
      });

      return unique?.[index] ?? key;
    });
  };

  const drill = (state: UsageViewState, key: string): DashboardRoute | null => {
    if (key === "(other)" || key === "(unattributed)") {
      return null;
    }

    if (isTime(state.by)) {
      const until = addDays(key, state.by === "week" ? 7 : 1);

      return until === null
        ? null
        : {
            name: "usage",
            state: { ...state, by: "tool", since: key, until },
          };
    }

    const repos = valuesOf(state, "repo");
    const branches = valuesOf(state, "branch");

    if (state.by === "branch") {
      return repos.length === 1
        ? {
            name: "usage",
            state: {
              ...withFilter(state, "branch", [key]),
              by: "session",
            },
          }
        : {
            name: "usage",
            state: { ...withFilter(state, "branch", [key]), by: "repo" },
          };
    }

    if (state.by === "repo" && branches.length === 1) {
      return {
        branch: branches[0] ?? "",
        name: "branch",
        repo: key,
        state: branchState(state),
      };
    }

    const next = NEXT.get(state.by);

    return next === undefined
      ? null
      : {
          name: "usage",
          state: { ...withFilter(state, state.by, [key]), by: next },
        };
  };

  const crumbs = (state: UsageViewState): readonly DashboardCrumb[] => {
    const single = state.filters.filter(
      ([name]) => valuesOf(state, name).length === 1
    );

    const back = (count: number, dimension: string | null): string => {
      const kept = single.slice(0, count);
      const dropped = new Set(single.slice(count).map(([name]) => name));

      const filters = state.filters.filter(
        ([name]) =>
          !dropped.has(name) || kept.some(([keptName]) => keptName === name)
      );

      const by =
        dimension === null
          ? DEFAULT.by
          : (NEXT.get(dimension) ??
            (dimension === "branch" ? "session" : state.by));

      return encode({ name: "usage", state: { ...state, by, filters } });
    };

    return [
      { dimension: null, hash: back(0, null), value: "All usage" },
      ...single.map(([name, value], index): DashboardCrumb => ({
        dimension: name,
        hash: back(index + 1, name),
        value,
      })),
    ];
  };

  return {
    BY_CHOICES,
    FILTER_DIMENSIONS,
    METRICS,
    TABLE_METRICS,
    addDays,
    chartQuery,
    crumbs,
    decode,
    drill,
    encode,
    facetQuery,
    segment,
    sessionLabels,
    shortSession,
    tableQuery,
    toolsQuery,
    withFilter,
  };
};

export const dashboardStateScript = (): string =>
  `var STATE=(${dashboardStateKit.toString()})();`;

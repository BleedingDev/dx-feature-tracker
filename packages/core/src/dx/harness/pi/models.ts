import { Option, Schema } from "effect";

import type { ModelProvider } from "../ids.js";
import {
  KNOWN_GATEWAYS,
  LOCAL_RUNTIMES,
  normalizeModel,
  providerFor,
  viaFor,
} from "../provider.js";

const ModelsFileSchema = Schema.Struct({
  providers: Schema.optional(
    Schema.NullOr(
      Schema.Record(
        Schema.String,
        Schema.Struct({
          baseUrl: Schema.optional(Schema.NullOr(Schema.String)),
        })
      )
    )
  ),
});

const decodeModelsFile = Schema.decodeUnknownOption(
  Schema.fromJsonString(ModelsFileSchema)
);

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "::1",
]);

const hostOf = (url: string): string | null => {
  const match = /^[a-z][a-z0-9+.-]*:\/\/(?<host>\[[^\]]+\]|[^/:?#]+)/iu.exec(
    url.trim()
  );

  return match?.groups?.host?.toLowerCase() ?? null;
};

const isGateway = (provider: string): boolean =>
  KNOWN_GATEWAYS.includes(provider.toLowerCase());

export const localProvidersOf = (
  modelsJson: string | null
): ReadonlySet<string> => {
  if (modelsJson === null) {
    return new Set();
  }

  const providers = Option.match(decodeModelsFile(modelsJson), {
    onNone: () => ({}),
    onSome: (file) => file.providers ?? {},
  });

  return new Set(
    Object.entries(providers).flatMap(([name, config]) => {
      const host = hostOf(config.baseUrl ?? "");

      return host !== null && LOOPBACK_HOSTS.has(host) && !isGateway(name)
        ? [name]
        : [];
    })
  );
};

export interface PiModelAttribution {
  readonly model: string | null;
  readonly modelRaw: string | null;
  readonly provider: ModelProvider;
  readonly via: string | null;
}

const runtimeIn = (provider: string): string | null => {
  const lowered = provider.toLowerCase();

  return LOCAL_RUNTIMES.find((runtime) => lowered.includes(runtime)) ?? null;
};

const hintFor = (
  piProvider: string | null,
  localProviders: ReadonlySet<string>
): string | null => {
  if (piProvider === null || isGateway(piProvider)) {
    return piProvider;
  }

  const runtime = runtimeIn(piProvider);

  if (localProviders.has(piProvider)) {
    return runtime ?? "local";
  }

  return runtime ?? piProvider;
};

export const attributeModel = (
  modelRaw: string | null,
  piProvider: string | null,
  localProviders: ReadonlySet<string>
): PiModelAttribution => {
  const hint = hintFor(piProvider, localProviders);

  return {
    model: normalizeModel(modelRaw),
    modelRaw,
    provider: providerFor(modelRaw, hint),
    via: viaFor(modelRaw, hint),
  };
};

// @effect-diagnostics-next-line nodeBuiltinImport:off -- The Node HTTP server is the one place where nothing in Effect wraps the built-in: `NodeHttpServer.layer` takes a `node:http` server factory.
import { createServer } from "node:http";
import { homedir } from "node:os";

import { NodeHttpServer } from "@effect/platform-node";
import type { AnyCapability } from "@rat-stack/capability";
import {
  layerSubprocess,
  toCodeMode,
  toHttpApi,
  toToolkit,
} from "@rat-stack/capability";
import { capabilities } from "@rat-stack/core";
import {
  allCollectors,
  buildRegistry,
  cachedPriceProvider,
  dxStoreLayer,
  makeDxCapabilities,
  metricsWithCost,
  resolveDftStore,
  resolveDxStore,
} from "@rat-stack/core/dx";
import { devtools, devtoolsLayer } from "@rat-stack/devtools";
import { Effect, Layer, Logger } from "effect";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { HttpRouter } from "effect/unstable/http";
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi";

import { providerCostOptions } from "./dft-session.js";
import { VERSION } from "./version.js";

export const http = toHttpApi("RatStack", capabilities);

const dxEnv = process.env;

const legacyStore =
  dxEnv.DX_REPLAY === "1" || (dxEnv.DX_STORE ?? "").trim() !== "";

export const dxStore = legacyStore
  ? resolveDxStore({
      env: dxEnv,
      home: homedir(),
      replay: dxEnv.DX_REPLAY === "1",
      store: null,
    })
  : resolveDftStore({ db: null, env: dxEnv, home: homedir() });

const dxCostOptions = providerCostOptions(cachedPriceProvider(homedir()));

export const dxRegistry = buildRegistry(
  allCollectors,
  metricsWithCost(dxCostOptions)
);

export const dxCapabilities = makeDxCapabilities({
  collectors: allCollectors,
  costOptions: dxCostOptions,
  defaultRepo: dxEnv.DX_REPO ?? process.cwd(),
  registry: dxRegistry,
  storePath: dxStore.path,
});

export const dxStoreLive = dxStoreLayer(dxStore);

const dxTools = toToolkit([...capabilities, ...dxCapabilities]);

export const tools = toToolkit(capabilities);

export const codeMode = toCodeMode(capabilities);

export const routes = Layer.merge(
  HttpApiBuilder.layer(http.api, { openapiPath: "/openapi.json" }).pipe(
    Layer.provide(http.layer)
  ),
  HttpApiScalar.layer(http.api, { path: "/docs" })
);

export const SERVE_HOST = "127.0.0.1";

export const serverLayer = (port: number) =>
  NodeHttpServer.layer(() => createServer(), { host: SERVE_HOST, port });

export const webServer = (port: number) =>
  HttpRouter.serve(routes).pipe(Layer.provide(serverLayer(port)));

const protocols = [
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
  McpProtocol.v2024_11_05,
] as const;

const stdio = McpServer.layerStdio({
  name: "rat-stack",
  protocols,
  version: VERSION,
});

const withStdio = <A, E, R>(server: Layer.Layer<A, E, R>) =>
  server.pipe(
    Layer.provide(stdio),
    Layer.provide(Layer.succeed(Logger.LogToStderr, true))
  );

export const DEVTOOLS_MCP_PATH = "/__rat/mcp";

const withDevtools = <A, E, R>(
  build: (
    projected: Effect.Success<ReturnType<typeof devtools<typeof capabilities>>>
  ) => Layer.Layer<A, E, R>
) => Layer.unwrap(Effect.map(devtools(capabilities), build));

const toolkitServer = <const Caps extends readonly AnyCapability[]>(
  all: Caps
) => {
  const projected = toToolkit(all);

  return McpServer.toolkit(projected.toolkit).pipe(
    Layer.provideMerge(projected.layer)
  );
};

export const devtoolsRoutes = withDevtools(
  ({ capabilities: all, recorded }) => {
    const api = toHttpApi("RatStack", recorded);

    return Layer.mergeAll(
      HttpApiBuilder.layer(api.api, { openapiPath: "/openapi.json" }).pipe(
        Layer.provide(api.layer)
      ),
      HttpApiScalar.layer(api.api, { path: "/docs" }),
      toolkitServer(all).pipe(
        Layer.provide(
          McpServer.layerHttp({
            name: "rat-stack-devtools",
            path: DEVTOOLS_MCP_PATH,
            protocols,
            version: VERSION,
          })
        )
      )
    );
  }
);

export const devtoolsWebServer = (port: number) =>
  HttpRouter.serve(devtoolsRoutes).pipe(
    Layer.provide(devtoolsLayer()),
    Layer.provide(serverLayer(port))
  );

export const mcpServer = {
  codeMode: withStdio(
    McpServer.toolkit(codeMode.toolkit).pipe(
      Layer.provideMerge(codeMode.layer),
      Layer.provide(layerSubprocess())
    )
  ),
  devtools: withStdio(
    withDevtools(({ capabilities: all }) => toolkitServer(all))
  ).pipe(Layer.provide(devtoolsLayer())),
  devtoolsCodeMode: withStdio(
    withDevtools(({ capabilities: all }) => {
      const projected = toCodeMode(all);

      return McpServer.toolkit(projected.toolkit).pipe(
        Layer.provideMerge(projected.layer),
        Layer.provide(layerSubprocess())
      );
    })
  ).pipe(Layer.provide(devtoolsLayer())),
  tools: withStdio(
    McpServer.toolkit(dxTools.toolkit).pipe(
      Layer.provideMerge(dxTools.layer),
      Layer.provide(dxStoreLive)
    )
  ),
} as const;

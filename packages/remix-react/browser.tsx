import type {
  HydrationState,
  Router,
  DataStrategyMatch,
} from "@remix-run/router";
import type { SerializeFrom } from "@remix-run/server-runtime";
import {
  createBrowserHistory,
  createRouter,
  redirect,
} from "@remix-run/router";
import type { ReactElement } from "react";
import * as React from "react";
import { UNSAFE_mapRouteProperties as mapRouteProperties } from "react-router";
import type { DataStrategyFunctionArgs } from "react-router-dom";
import { matchRoutes, RouterProvider } from "react-router-dom";
import { decode } from "turbo-stream";

import { RemixContext } from "./components";
import type { EntryContext, FutureConfig } from "./entry";
import { RemixErrorBoundary } from "./errorBoundaries";
import { deserializeErrors } from "./errors";
import invariant from "./invariant";
import { prefetchStyleLinks } from "./links";
import type { RouteModules } from "./routeModules";
import {
  createClientRoutes,
  createClientRoutesWithHMRRevalidationOptOut,
  shouldHydrateRouteLoader,
  // TODO: Eventually we should move the single fetch stuff to data.ts and
  // stop exporting these
  noActionDefinedError,
  preventInvalidServerHandlerCall,
} from "./routes";

/* eslint-disable prefer-let/prefer-let */
declare global {
  var __remixContext: {
    url: string;
    basename?: string;
    state: HydrationState;
    criticalCss?: string;
    future: FutureConfig;
    isSpaMode: boolean;
    // The number of active deferred keys rendered on the server
    a?: number;
    dev?: {
      port?: number;
      hmrRuntime?: string;
    };
  };
  var __remixRouter: Router;
  var __remixRouteModules: RouteModules;
  var __remixManifest: EntryContext["manifest"];
  var __remixRevalidation: number | undefined;
  var __remixClearCriticalCss: (() => void) | undefined;
  var $RefreshRuntime$: {
    performReactRefresh: () => void;
  };
}
/* eslint-enable prefer-let/prefer-let */

export interface RemixBrowserProps {}

let router: Router;
let routerInitialized = false;
let hmrAbortController: AbortController | undefined;
let hmrRouterReadyResolve: ((router: Router) => void) | undefined;
// There's a race condition with HMR where the remix:manifest is signaled before
// the router is assigned in the RemixBrowser component. This promise gates the
// HMR handler until the router is ready
let hmrRouterReadyPromise = new Promise<Router>((resolve) => {
  // body of a promise is executed immediately, so this can be resolved outside
  // of the promise body
  hmrRouterReadyResolve = resolve;
}).catch(() => {
  // This is a noop catch handler to avoid unhandled promise rejection warnings
  // in the console. The promise is never rejected.
  return undefined;
});

// @ts-expect-error
if (import.meta && import.meta.hot) {
  // @ts-expect-error
  import.meta.hot.accept(
    "remix:manifest",
    async ({
      assetsManifest,
      needsRevalidation,
    }: {
      assetsManifest: EntryContext["manifest"];
      needsRevalidation: Set<string>;
    }) => {
      let router = await hmrRouterReadyPromise;
      // This should never happen, but just in case...
      if (!router) {
        console.error(
          "Failed to accept HMR update because the router was not ready."
        );
        return;
      }

      let routeIds = [
        ...new Set(
          router.state.matches
            .map((m) => m.route.id)
            .concat(Object.keys(window.__remixRouteModules))
        ),
      ];

      if (hmrAbortController) {
        hmrAbortController.abort();
      }
      hmrAbortController = new AbortController();
      let signal = hmrAbortController.signal;

      // Load new route modules that we've seen.
      let newRouteModules = Object.assign(
        {},
        window.__remixRouteModules,
        Object.fromEntries(
          (
            await Promise.all(
              routeIds.map(async (id) => {
                if (!assetsManifest.routes[id]) {
                  return null;
                }
                let imported = await import(
                  assetsManifest.routes[id].module +
                    `?t=${assetsManifest.hmr?.timestamp}`
                );
                return [
                  id,
                  {
                    ...imported,
                    // react-refresh takes care of updating these in-place,
                    // if we don't preserve existing values we'll loose state.
                    default: imported.default
                      ? window.__remixRouteModules[id]?.default ??
                        imported.default
                      : imported.default,
                    ErrorBoundary: imported.ErrorBoundary
                      ? window.__remixRouteModules[id]?.ErrorBoundary ??
                        imported.ErrorBoundary
                      : imported.ErrorBoundary,
                    HydrateFallback: imported.HydrateFallback
                      ? window.__remixRouteModules[id]?.HydrateFallback ??
                        imported.HydrateFallback
                      : imported.HydrateFallback,
                  },
                ];
              })
            )
          ).filter(Boolean) as [string, RouteModules[string]][]
        )
      );

      Object.assign(window.__remixRouteModules, newRouteModules);
      // Create new routes
      let routes = createClientRoutesWithHMRRevalidationOptOut(
        needsRevalidation,
        assetsManifest.routes,
        window.__remixRouteModules,
        window.__remixContext.state,
        window.__remixContext.future,
        window.__remixContext.isSpaMode
      );

      // This is temporary API and will be more granular before release
      router._internalSetRoutes(routes);

      // Wait for router to be idle before updating the manifest and route modules
      // and triggering a react-refresh
      let unsub = router.subscribe((state) => {
        if (state.revalidation === "idle") {
          unsub();
          // Abort if a new update comes in while we're waiting for the
          // router to be idle.
          if (signal.aborted) return;
          // Ensure RouterProvider setState has flushed before re-rendering
          setTimeout(() => {
            Object.assign(window.__remixManifest, assetsManifest);
            window.$RefreshRuntime$.performReactRefresh();
          }, 1);
        }
      });
      window.__remixRevalidation = (window.__remixRevalidation || 0) + 1;
      router.revalidate();
    }
  );
}

/**
 * The entry point for a Remix app when it is rendered in the browser (in
 * `app/entry.client.js`). This component is used by React to hydrate the HTML
 * that was received from the server.
 */
export function RemixBrowser(_props: RemixBrowserProps): ReactElement {
  if (!router) {
    // Hard reload if the path we tried to load is not the current path.
    // This is usually the result of 2 rapid back/forward clicks from an
    // external site into a Remix app, where we initially start the load for
    // one URL and while the JS chunks are loading a second forward click moves
    // us to a new URL.  Avoid comparing search params because of CDNs which
    // can be configured to ignore certain params and only pathname is relevant
    // towards determining the route matches.
    let initialPathname = window.__remixContext.url;
    let hydratedPathname = window.location.pathname;
    if (
      initialPathname !== hydratedPathname &&
      !window.__remixContext.isSpaMode
    ) {
      let errorMsg =
        `Initial URL (${initialPathname}) does not match URL at time of hydration ` +
        `(${hydratedPathname}), reloading page...`;
      console.error(errorMsg);
      window.location.reload();
      // Get out of here so the reload can happen - don't create the router
      // since it'll then kick off unnecessary route.lazy() loads
      return <></>;
    }

    let routes = createClientRoutes(
      window.__remixManifest.routes,
      window.__remixRouteModules,
      window.__remixContext.state,
      window.__remixContext.future,
      window.__remixContext.isSpaMode
    );

    let hydrationData = undefined;
    if (!window.__remixContext.isSpaMode) {
      // Create a shallow clone of `loaderData` we can mutate for partial hydration.
      // When a route exports a `clientLoader` and a `HydrateFallback`, the SSR will
      // render the fallback so we need the client to do the same for hydration.
      // The server loader data has already been exposed to these route `clientLoader`'s
      // in `createClientRoutes` above, so we need to clear out the version we pass to
      // `createBrowserRouter` so it initializes and runs the client loaders.
      hydrationData = {
        ...window.__remixContext.state,
        loaderData: { ...window.__remixContext.state.loaderData },
      };
      let initialMatches = matchRoutes(routes, window.location);
      if (initialMatches) {
        for (let match of initialMatches) {
          let routeId = match.route.id;
          let route = window.__remixRouteModules[routeId];
          let manifestRoute = window.__remixManifest.routes[routeId];
          // Clear out the loaderData to avoid rendering the route component when the
          // route opted into clientLoader hydration and either:
          // * gave us a HydrateFallback
          // * or doesn't have a server loader and we have no data to render
          if (
            route &&
            shouldHydrateRouteLoader(
              manifestRoute,
              route,
              window.__remixContext.isSpaMode
            ) &&
            (route.HydrateFallback || !manifestRoute.hasLoader)
          ) {
            hydrationData.loaderData[routeId] = undefined;
          } else if (manifestRoute && !manifestRoute.hasLoader) {
            // Since every Remix route gets a `loader` on the client side to load
            // the route JS module, we need to add a `null` value to `loaderData`
            // for any routes that don't have server loaders so our partial
            // hydration logic doesn't kick off the route module loaders during
            // hydration
            hydrationData.loaderData[routeId] = null;
          }
        }
      }

      if (hydrationData && hydrationData.errors) {
        hydrationData.errors = deserializeErrors(hydrationData.errors);
      }
    }

    // We don't use createBrowserRouter here because we need fine-grained control
    // over initialization to support synchronous `clientLoader` flows.
    router = createRouter({
      routes,
      history: createBrowserHistory(),
      basename: window.__remixContext.basename,
      future: {
        v7_normalizeFormMethod: true,
        v7_fetcherPersist: window.__remixContext.future.v3_fetcherPersist,
        v7_partialHydration: true,
        v7_prependBasename: true,
        v7_relativeSplatPath: window.__remixContext.future.v3_relativeSplatPath,
      },
      hydrationData,
      mapRouteProperties,
      unstable_dataStrategy: window.__remixContext.future.unstable_singleFetch
        ? singleFetchDataStrategy
        : undefined,
    });

    // We can call initialize() immediately if the router doesn't have any
    // loaders to run on hydration
    if (router.state.initialized) {
      routerInitialized = true;
      router.initialize();
    }

    // @ts-ignore
    router.createRoutesForHMR = createClientRoutesWithHMRRevalidationOptOut;
    window.__remixRouter = router;

    // Notify that the router is ready for HMR
    if (hmrRouterReadyResolve) {
      hmrRouterReadyResolve(router);
    }
  }

  // Critical CSS can become stale after code changes, e.g. styles might be
  // removed from a component, but the styles will still be present in the
  // server HTML. This allows our HMR logic to clear the critical CSS state.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  let [criticalCss, setCriticalCss] = React.useState(
    process.env.NODE_ENV === "development"
      ? window.__remixContext.criticalCss
      : undefined
  );
  if (process.env.NODE_ENV === "development") {
    window.__remixClearCriticalCss = () => setCriticalCss(undefined);
  }

  // This is due to the short circuit return above when the pathname doesn't
  // match and we force a hard reload.  This is an exceptional scenario in which
  // we can't hydrate anyway.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  let [location, setLocation] = React.useState(router.state.location);

  // eslint-disable-next-line react-hooks/rules-of-hooks
  React.useLayoutEffect(() => {
    // If we had to run clientLoaders on hydration, we delay initialization until
    // after we've hydrated to avoid hydration issues from synchronous client loaders
    if (!routerInitialized) {
      routerInitialized = true;
      router.initialize();
    }
  }, []);

  // eslint-disable-next-line react-hooks/rules-of-hooks
  React.useLayoutEffect(() => {
    return router.subscribe((newState) => {
      if (newState.location !== location) {
        setLocation(newState.location);
      }
    });
  }, [location]);

  // We need to include a wrapper RemixErrorBoundary here in case the root error
  // boundary also throws and we need to bubble up outside of the router entirely.
  // Then we need a stateful location here so the user can back-button navigate
  // out of there
  return (
    <RemixContext.Provider
      value={{
        manifest: window.__remixManifest,
        routeModules: window.__remixRouteModules,
        future: window.__remixContext.future,
        criticalCss,
        isSpaMode: window.__remixContext.isSpaMode,
      }}
    >
      <RemixErrorBoundary location={location}>
        <RouterProvider
          router={router}
          fallbackElement={null}
          future={{ v7_startTransition: true }}
        />
      </RemixErrorBoundary>
    </RemixContext.Provider>
  );
}

type SingleFetchResult =
  | { data: unknown }
  | { error: unknown }
  | { redirect: string; status: number; revalidate: boolean; reload: boolean };
type SingleFetchResults = {
  [key: string]: SingleFetchResult;
};

async function singleFetchDataStrategy({
  request,
  matches,
}: DataStrategyFunctionArgs) {
  // TODO: Do styles load twice on actions?

  // Prefetch styles for matched routes that exist in the routeModulesCache
  // (critical modules and navigating back to pages previously loaded via
  // route.lazy).  Initial execution of route.lazy (when the module is not in
  // the cache) will handle prefetching style links via loadRouteModuleWithBlockingLinks.
  let stylesPromise = Promise.all(
    matches.map((m) => {
      let route = window.__remixManifest.routes[m.route.id];
      let cachedModule = window.__remixRouteModules[m.route.id];
      return cachedModule
        ? prefetchStyleLinks(route, cachedModule)
        : Promise.resolve();
    })
  );

  let dataPromise =
    request.method === "GET"
      ? singleFetchLoaders(request, matches)
      : singleFetchAction(request, matches);

  let [routeData] = await Promise.all([dataPromise, stylesPromise]);
  return routeData;

  // TODO: Critical route modules for single fetch
  // TODO: Don't revalidate on action 4xx/5xx responses with status codes
  //       (return or throw)
  // TODO: Fix issue with auto-revalidating routes on HMR
  //  - load /
  //  - navigate to /parent/child
  //  - trigger HMR
  //  - back button to /
  //  - throws a "you returned undefined from a loader" error
}

function singleFetchAction(request: Request, matches: DataStrategyMatch[]) {
  let singleFetch = async (routeId: string) => {
    let res = await fetch(singleFetchUrl(request.url), {
      method: request.method,
    });
    invariant(
      res.headers.get("Content-Type")?.includes("text/x-turbo"),
      "Expected a text/x-turbo response"
    );
    let decoded = await decode(res.body!);
    let result = decoded.value as SingleFetchResult;
    return unwrapSingleFetchResult(result, routeId);
  };

  return Promise.all(
    matches.map((m) =>
      m.bikeshed_loadRoute(() => {
        let route = window.__remixManifest.routes[m.route.id];
        let routeModule = window.__remixRouteModules[m.route.id];
        invariant(
          routeModule,
          "Expected a defined routeModule after bikeshed_loadRoute"
        );

        if (routeModule.clientAction) {
          return routeModule.clientAction({
            request,
            params: m.params,
            serverAction<T>() {
              preventInvalidServerHandlerCall(
                "action",
                route,
                window.__remixContext.isSpaMode
              );
              return singleFetch(m.route.id) as Promise<SerializeFrom<T>>;
            },
          });
        } else if (route.hasAction) {
          return singleFetch(m.route.id);
        } else {
          throw noActionDefinedError("action", m.route.id);
        }
      })
    )
  );
}

function singleFetchLoaders(request: Request, matches: DataStrategyMatch[]) {
  // Create a singular promise for all routes to latch onto for single fetch.
  // This way we can kick off `clientLoaders` and ensure:
  // 1. we only call the server if at least one of them calls `serverLoader`
  // 2. if multiple call` serverLoader` only one fetch call is made
  let singleFetchPromise: Promise<SingleFetchResults>;

  let makeSingleFetchCall = async () => {
    // Single fetch doesn't need/want naked index queries on action
    // revalidation requests
    let url = singleFetchUrl(stripIndexParam(request.url));

    // Determine which routes we want to load so we can send an X-Remix-Routes header
    // for fine-grained revalidation if necessary.  If a route has not yet been loaded
    // via `route.lazy` then we know we want to load it because it's by definition a
    // net-new route.  If it has been loaded then bikeshed_load will have taken
    // shouldRevalidate into consideration.
    //
    // There is a small edge case that _may_ result in a server loader running
    // _somewhat_ unintended, but I'm pretty sure it's unavoidable:
    // - Assume we have 2 routes, parent and child
    // - Both have clientLoaders and both need to be revalidated
    // - If neither calls `serverLoader`, we won't make the single fetch call
    // - We delay the single fetch call until the **first** one calls `serverLoader`
    // - However, we cannot wait around to know if the other one calls
    //   `serverLoader`, so we include both of them in the `X-Remix-Routes`
    //   header
    // - This means it's technically possible that the second route never calls
    //   `serverLoader` and we never read the response of that route from the
    //   single fetch call, and thus executing that loader on the server was
    //   unnecessary.
    let matchedIds = genRouteIds(matches.map((m) => m.route.id));
    let loadIds = genRouteIds(
      matches.filter((m) => m.bikeshed_load).map((m) => m.route.id)
    );
    let headers =
      matchedIds !== loadIds ? { "X-Remix-Routes": loadIds } : undefined;

    let res = await fetch(url, { headers });
    invariant(
      res.body != null &&
        res.headers.get("Content-Type")?.includes("text/x-turbo"),
      "Expected a text/x-turbo response"
    );
    let decoded = await decode(res.body!);
    return decoded.value as SingleFetchResults;
  };

  let singleFetch = async (routeId: string) => {
    if (!singleFetchPromise) {
      singleFetchPromise = makeSingleFetchCall();
    }
    let results = await singleFetchPromise;
    if (results[routeId] !== undefined) {
      return unwrapSingleFetchResult(results[routeId], routeId);
    }
    return null;
  };

  return Promise.all(
    matches.map((m) =>
      m.bikeshed_loadRoute(() => {
        let route = window.__remixManifest.routes[m.route.id];
        let routeModule = window.__remixRouteModules[m.route.id];
        invariant(routeModule, "Expected a routeModule in bikeshed_loadRoute");

        if (routeModule.clientLoader) {
          return routeModule.clientLoader({
            request,
            params: m.params,
            serverLoader<T>() {
              preventInvalidServerHandlerCall(
                "loader",
                route,
                window.__remixContext.isSpaMode
              );
              return singleFetch(m.route.id) as Promise<SerializeFrom<T>>;
            },
          });
        } else if (route.hasLoader) {
          return singleFetch(m.route.id);
        } else {
          // Remix routes without a server loader still have a "loader" on the
          // client to preload styles, so just return nothing here.
          return Promise.resolve(null);
        }
      })
    )
  );
}

function stripIndexParam(reqUrl: string) {
  let url = new URL(reqUrl);
  let indexValues = url.searchParams.getAll("index");
  url.searchParams.delete("index");
  let indexValuesToKeep = [];
  for (let indexValue of indexValues) {
    if (indexValue) {
      indexValuesToKeep.push(indexValue);
    }
  }
  for (let toKeep of indexValuesToKeep) {
    url.searchParams.append("index", toKeep);
  }

  return url.href;
}

function singleFetchUrl(reqUrl: string) {
  let url = new URL(reqUrl);
  url.pathname = `${url.pathname === "/" ? "_root" : url.pathname}.data`;
  return url;
}

function unwrapSingleFetchResult(result: SingleFetchResult, routeId: string) {
  if ("error" in result) {
    throw result.error;
  } else if ("redirect" in result) {
    let headers: Record<string, string> = {};
    if (result.revalidate) {
      headers["X-Remix-Revalidate"] = "yes";
    }
    if (result.reload) {
      headers["X-Remix-Reload-Document"] = "yes";
    }
    return redirect(result.redirect, { status: result.status, headers });
  } else if ("data" in result) {
    return result.data;
  } else {
    throw new Error(`No action response found for routeId "${routeId}"`);
  }
}

function genRouteIds(arr: string[]) {
  return arr
    .filter((id) => window.__remixManifest.routes[id].hasLoader)
    .join(",");
}

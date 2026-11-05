import { jsxDEV } from "react/jsx-dev-runtime";
import { Fragment, jsx } from "react/jsx-runtime";

/**
 * Keeps `jsxDEV` callable when React is its production build.
 *
 * Bun transpiles `.tsx` with the development transform, which calls `jsxDEV`
 * from `react/jsx-dev-runtime`, unless NODE_ENV=production when the process
 * starts. React picks its own build from the same variable, and production
 * React's dev runtime exports `jsxDEV` as undefined. The two agree for every
 * file Bun transpiles in this process, but not for one it takes from its
 * runtime transpiler cache: Bun caches the output for any source file of
 * 50 KB or more, keyed by the file's contents alone, never by the transform
 * that made it. Run the terminal once without NODE_ENV and once with
 * NODE_ENV=production (a shell profile that sets it, an IDE terminal that
 * does not), and the second run reads the first run's development output for
 * the large files: the chart composer and the composite chart under every
 * chart. Their panes stopped working with "jsxDEV is not a function".
 */

type JsxFactory = (type: unknown, props: unknown, key?: unknown) => unknown;

const FALLBACK_NAME = "gloomberb-jsx-dev-fallback";
const JSX_DEV_RUNTIME = "react/jsx-dev-runtime";

let installed = false;

/**
 * The development factory's signature answered by the production one, which
 * builds the same elements without the development checks. The extra
 * development arguments (static children, source, owner) are dropped.
 */
export function jsxDevFromJsx(prodJsx: JsxFactory): JsxFactory {
  return (type, props, key) => prodJsx(type, props, key);
}

/**
 * When this process runs production React, answers `react/jsx-dev-runtime`
 * for every module loaded after this call with one whose `jsxDEV` works. A
 * no-op under development React, where both transforms already resolve.
 *
 * Every entry that transpiles source at runtime (the CLI entry behind
 * `bin/gloom`, `bun start` and `bun dev`) calls it before it imports any
 * module with JSX: a module resolves its imports when it loads, so one loaded
 * earlier keeps the dev runtime it found. Returns whether it was installed.
 */
export function installJsxDevFallback(): boolean {
  if (installed) return true;
  if (typeof jsxDEV === "function") return false;
  if (typeof Bun === "undefined" || typeof Bun.plugin !== "function") return false;
  Bun.plugin({
    name: FALLBACK_NAME,
    setup(build) {
      build.module(JSX_DEV_RUNTIME, () => ({
        exports: { Fragment, jsxDEV: jsxDevFromJsx(jsx as JsxFactory) },
        loader: "object",
      }));
    },
  });
  installed = true;
  return true;
}

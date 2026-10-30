/**
 * The `process` a plugin sees in the desktop view and the web app.
 *
 * A plugin written for the terminal runs in Bun and reads `process.env`,
 * `process.platform` and friends without a second thought. The desktop view
 * and the browser are not Node: there is no `process`, so the same plugin
 * died on load with `ReferenceError: process is not defined`. Defining a global
 * `process` would be simpler, but the host itself looks at `globalThis.process`
 * to tell a Node runtime from a browser (updater, platform labels, libc
 * detection), so every plugin would change how the host behaves. The bundler
 * (`bundle.ts`) gives each plugin bundle its own copy instead, as a module
 * level constant that only that bundle's references to `process` read.
 *
 * What it holds is the harmless half of `process`: a copy of `env` with only
 * `NODE_ENV` in it (never the host's real environment, which the view cannot
 * read and a plugin should not receive by RPC), the platform of the window it
 * runs in, empty `argv` and `versions`, and timers and listeners that work or
 * do nothing. What cannot exist in a view (`exit`, `kill`, `chdir`, memory
 * and CPU readings) throws an error naming the plugin, instead of "is not a
 * function". Anything else is left undefined, so feature detection such as
 * `process.stdin?.isTTY` keeps working.
 */

/** The name the bundler gives the shim; no plugin source declares it. */
export const PLUGIN_PROCESS_IDENTIFIER = "__gloomPluginProcess";

/**
 * Builds the shim. This function is serialised into the plugin bundle with
 * `toString()`, so it has to stay self-contained: no imports and no module
 * level names, only globals the view provides.
 */
function createPluginProcess(pluginName: string): Record<string, unknown> {
  const nav = (globalThis as {
    navigator?: { userAgentData?: { platform?: string }; platform?: string; userAgent?: string };
  }).navigator;
  const hint = String(nav?.userAgentData?.platform || nav?.platform || nav?.userAgent || "").toLowerCase();
  // Mac is tested before Windows because "darwin" contains "win".
  const platform = /android/.test(hint)
    ? "android"
    : /mac|iphone|ipad|darwin/.test(hint)
      ? "darwin"
      : /win/.test(hint)
        ? "win32"
        : /linux|x11|cros/.test(hint)
          ? "linux"
          : "browser";

  const hrtime = (previous?: readonly [number, number]): [number, number] => {
    const ms = performance.now();
    let seconds = Math.floor(ms / 1000);
    let nanos = Math.floor((ms % 1000) * 1e6);
    if (previous) {
      seconds -= previous[0];
      nanos -= previous[1];
      if (nanos < 0) {
        seconds -= 1;
        nanos += 1e9;
      }
    }
    return [seconds, nanos];
  };
  const stream = (log: (line: string) => void) => ({
    isTTY: false,
    write: (chunk: unknown) => {
      log(String(chunk).replace(/\n$/, ""));
      return true;
    },
  });

  const proc: Record<string, unknown> = {
    env: { NODE_ENV: "production" },
    platform,
    browser: true,
    title: "browser",
    argv: [],
    execArgv: [],
    execPath: "",
    version: "",
    versions: {},
    pid: 0,
    ppid: 0,
    cwd: () => "/",
    uptime: () => performance.now() / 1000,
    hrtime: Object.assign(hrtime, { bigint: () => BigInt(Math.round(performance.now() * 1e6)) }),
    nextTick: (callback: (...args: unknown[]) => void, ...args: unknown[]) => {
      queueMicrotask(() => callback(...args));
    },
    emitWarning: (warning: unknown) => {
      console.warn(String((warning as { message?: string } | null)?.message ?? warning));
    },
    stdout: stream((line) => console.log(line)),
    stderr: stream((line) => console.error(line)),
    emit: () => false,
    listeners: () => [],
    listenerCount: () => 0,
  };
  // Nothing exits or signals in a view, so a handler would never run.
  for (const name of [
    "on", "once", "off", "addListener", "removeListener", "removeAllListeners",
    "prependListener", "prependOnceListener", "setMaxListeners",
  ]) {
    proc[name] = () => proc;
  }
  for (const name of [
    "exit", "abort", "kill", "chdir", "umask", "binding", "memoryUsage", "cpuUsage", "resourceUsage",
  ]) {
    proc[name] = () => {
      throw new Error(
        `Plugin "${pluginName}" called process.${name}(), which is only available in the terminal app, not in the desktop or web app.`,
      );
    };
  }
  return proc;
}

/** The declaration the bundler puts at the top of a bundle that reads `process`. */
export function pluginProcessDeclaration(pluginName: string): string {
  return `const ${PLUGIN_PROCESS_IDENTIFIER} = (${createPluginProcess.toString()})(${JSON.stringify(pluginName)});\n`;
}

/** Source of `import process from "node:process"`, for a plugin that imports it. */
export function pluginProcessModuleSource(): string {
  const names = Object.keys(createPluginProcess(""));
  return [
    "export default process;",
    ...names.map((name) => `export const ${name} = process.${name};`),
  ].join("\n");
}

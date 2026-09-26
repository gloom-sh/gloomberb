import type { RendererHost } from "../ui";

/** A renderer host that ignores every request, for tests that mount UI outside a real renderer. */
export const noopRendererHost: RendererHost = {
  requestExit() {},
  async openExternal() {},
  async copyText() {},
  async readText() { return ""; },
  notify() {},
};

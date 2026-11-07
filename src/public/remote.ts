/**
 * The running app's remote-control endpoint (`gloomberb/remote`).
 *
 * The app already answers a complete read and control protocol on a local
 * port, described by `remote-control.<appKind>.json` in the data directory.
 * A plugin that drives the app from outside the renderer, such as an agent
 * holding a tool the model can call, sends requests through the same client
 * and authentication the CLI uses rather than opening a second door into the
 * app's state.
 *
 * Native only: reading the endpoint file needs the filesystem, so this is not
 * a shared browser module and a renderer bundle that imports it fails to
 * compile, which is the correct answer for a browser context.
 */

export {
  RemoteAppAmbiguousError,
  RemoteAppError,
  RemoteAppNotRunningError,
  RemoteAppUnreachableError,
  sendRemoteControlRequest,
} from "../remote/client";
export type { SendRemoteControlRequestOptions } from "../remote/client";
export type {
  RemoteAppKind,
  RemoteControlRequest,
  RemoteControlResponse,
  RemoteMarketDataRequest,
} from "../remote/types";

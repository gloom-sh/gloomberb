import type { StorageLike } from "../data/json-storage";
import { flushCrashReports, reportCrash } from "./crash-reports";

/** The desktop view and the web terminal: window-level errors and the browser's install id. */

const INSTALL_ID_STORAGE_KEY = "gloomberb.web.install-id";
const INSTALL_ID = /^[a-f0-9-]{36}$/;

/** A random id kept in local storage; created on first use and used for nothing else. */
export function readOrCreateBrowserInstallId(storage: StorageLike | undefined = readLocalStorage()): string | null {
  try {
    const stored = storage?.getItem(INSTALL_ID_STORAGE_KEY);
    if (stored && INSTALL_ID.test(stored)) return stored;
    const created = crypto.randomUUID();
    storage?.setItem(INSTALL_ID_STORAGE_KEY, created);
    return created;
  } catch {
    // Private browsing may refuse storage; a per-load id still identifies the report.
    return crypto.randomUUID();
  }
}

function readLocalStorage(): StorageLike | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/** The browser's own opt-out signals, the web equivalent of `DO_NOT_TRACK=1`. */
export function browserDoNotTrack(): boolean {
  try {
    const nav = navigator as Navigator & { globalPrivacyControl?: boolean };
    return nav.doNotTrack === "1" || nav.globalPrivacyControl === true;
  } catch {
    return false;
  }
}

/** The user agent's platform, the closest a browser context has to an OS name. */
export function describeBrowserOs(): string {
  try {
    const data = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData;
    return data?.platform || navigator.platform || "";
  } catch {
    return "";
  }
}

/**
 * Reports what escapes React: errors thrown outside a render, and promise
 * rejections nobody handled. A page going away flushes what is queued; the
 * request uses `keepalive`, so the browser finishes it after unload.
 */
export function installWindowCrashListeners(target: Window = window): () => void {
  const onError = (event: ErrorEvent) => {
    reportCrash(event.error ?? event.message, { kind: "uncaught" });
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    reportCrash(event.reason, { kind: "unhandled-rejection" });
  };
  const onPageHide = () => {
    void flushCrashReports({ timeoutMs: 1_000 });
  };
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);
  target.addEventListener("pagehide", onPageHide);
  return () => {
    target.removeEventListener("error", onError);
    target.removeEventListener("unhandledrejection", onRejection);
    target.removeEventListener("pagehide", onPageHide);
  };
}

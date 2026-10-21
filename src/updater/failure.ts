/**
 * Why an update step failed, as a fixed phase and code rather than the error
 * text: the header says the reason in a few words, and error tracking gets
 * the same two values, which carry no path, URL or account name.
 */

/** The step that failed. `relaunch` is getting back into the app after an install. */
export type UpdateFailurePhase = "check" | "download" | "verify" | "apply" | "relaunch";

const UPDATE_FAILURE_CODES = [
  /** No route to the release server: offline, DNS, refused, TLS. */
  "offline",
  "timeout",
  /** GitHub answered 403 or 429, its limit for requests without an account. */
  "rate_limited",
  "server_error",
  /** The release has no such file (404). */
  "not_found",
  /** Any other refusal from the release server. */
  "http_error",
  /** The release list or manifest did not read as one. */
  "bad_response",
  /** The release has no build for this platform, or none with a checksum. */
  "no_build",
  /** The download stopped before the whole file arrived. */
  "interrupted",
  /** The file arrived whole but does not match its checksum, or does not unpack. */
  "corrupt",
  "permission_denied",
  /** The macOS app runs from where it cannot be replaced: a disk image, App Translocation, another volume. */
  "wrong_location",
  "read_only",
  "disk_full",
  /** Another process holds the files being replaced. */
  "file_in_use",
  /** The update downloaded earlier is no longer where the install expects it. */
  "staged_missing",
  /** A restart into the update came back on the old version. */
  "not_applied",
  /** The app quit with a downloaded update waiting and was opened again on the old version. */
  "not_restarted",
  /** The install finished but the app did not come back by itself. */
  "relaunch_missed",
  "unknown",
] as const;

export type UpdateFailureCode = typeof UPDATE_FAILURE_CODES[number];

export interface UpdateFailure {
  phase: UpdateFailurePhase;
  code: UpdateFailureCode;
}

/** What an HTTP status from the release server means for an update. */
export function httpStatusFailureCode(status: number): UpdateFailureCode {
  if (status === 403 || status === 429) return "rate_limited";
  if (status === 404 || status === 410) return "not_found";
  if (status >= 500) return "server_error";
  return "http_error";
}

const OFFLINE_ERRNO = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ENETUNREACH",
  "EHOSTUNREACH",
  "ENETDOWN",
  // Bun's fetch
  "ConnectionRefused",
  "FailedToOpenSocket",
  "UnableToConnect",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "SELF_SIGNED_CERT_IN_CHAIN",
]);
const INTERRUPTED_ERRNO = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "ConnectionClosed"]);

/**
 * The code for an error a step threw, from its system error code first and its
 * message second. Only the code leaves the machine; the message stays local.
 */
export function classifyUpdateError(error: unknown): UpdateFailureCode {
  const record = (error && typeof error === "object" ? error : {}) as { code?: unknown; name?: unknown; message?: unknown };
  const message = typeof record.message === "string" ? record.message : typeof error === "string" ? error : "";
  // A system error code, or one named in the message ("Failed to replace app: EACCES: ...").
  const errno = typeof record.code === "string" ? record.code : /\b(E[A-Z]{3,})\b/.exec(message)?.[1] ?? "";
  switch (errno) {
    case "EACCES":
    case "EPERM":
      return "permission_denied";
    case "EROFS":
      return "read_only";
    case "ENOSPC":
    case "EDQUOT":
      return "disk_full";
    case "EBUSY":
    case "ETXTBSY":
      return "file_in_use";
    case "EXDEV":
      return "wrong_location";
    case "ETIMEDOUT":
      return "timeout";
  }
  if (OFFLINE_ERRNO.has(errno)) return "offline";
  if (INTERRUPTED_ERRNO.has(errno)) return "interrupted";
  if (record.name === "TimeoutError" || record.name === "AbortError") return "timeout";

  const status = /\b(?:HTTP|returned|status|failed:?)\s*\(?(\d{3})\b/i.exec(message)?.[1];
  if (status) return httpStatusFailureCode(Number(status));
  if (/checksum mismatch|hash mismatch/i.test(message)) return "corrupt";
  if (/zstd|decompress|gunzip|incorrect header|unexpected end of (?:file|data)/i.test(message)) return "corrupt";
  if (/timed? ?out/i.test(message)) return "timeout";
  if (/rate limit/i.test(message)) return "rate_limited";
  if (/read-only file system/i.test(message)) return "read_only";
  if (/cross-device/i.test(message)) return "wrong_location";
  if (/permission denied|operation not permitted|access is denied/i.test(message)) return "permission_denied";
  if (/no space left|disk full/i.test(message)) return "disk_full";
  if (/resource busy|text file busy|being used by another process/i.test(message)) return "file_in_use";
  if (/connection (?:reset|closed|aborted)|socket hang up|premature close|terminated/i.test(message)) return "interrupted";
  if (/unable to connect|fetch failed|failed to fetch|network|getaddrinfo|could not resolve|certificate/i.test(message)) return "offline";
  if (/invalid update\.json|unexpected .*payload|json/i.test(message)) return "bad_response";
  return "unknown";
}

/** When the failure has no more specific reason: what the step was. */
const PHASE_REASONS: Record<UpdateFailurePhase, string> = {
  check: "check failed",
  download: "download failed",
  verify: "could not verify the download",
  apply: "could not install",
  relaunch: "could not restart",
};

const CODE_REASONS: Partial<Record<UpdateFailureCode, string>> = {
  offline: "no connection",
  timeout: "connection timed out",
  rate_limited: "GitHub rate limit",
  server_error: "release server error",
  not_found: "release server error",
  http_error: "release server error",
  bad_response: "unreadable release data",
  no_build: "no build for this system",
  interrupted: "download interrupted",
  corrupt: "download corrupted",
  permission_denied: "no permission to replace the app",
  wrong_location: "move the app to Applications",
  read_only: "install folder is read-only",
  disk_full: "disk full",
  file_in_use: "app files in use",
  staged_missing: "downloaded update missing",
};

/**
 * The reason in a few words, in English (the caller translates it), sized
 * for the header: "download interrupted", "no permission to replace the app".
 */
export function updateFailureReason(failure: UpdateFailure): string {
  return CODE_REASONS[failure.code] ?? PHASE_REASONS[failure.phase];
}

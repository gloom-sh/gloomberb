/**
 * Whether Windows lets this process follow a junction a standard user made,
 * which is what every link to a sibling plugin is (host-link.ts).
 *
 * Windows 11's RedirectionGuard stops a process that runs with it from
 * following such a junction at all: the junction is there, points where it
 * should, and every read through it fails. That is how the gateway's link
 * looked on the first launch after an update. Some Windows services run with
 * it; whether that launch did is not known, so the report of a link that does
 * not resolve carries the answer.
 */

/** `ProcessRedirectionTrustPolicy` in Windows' PROCESS_MITIGATION_POLICY. */
const PROCESS_REDIRECTION_TRUST_POLICY = 16;
const CURRENT_PROCESS = -1;
const ENFORCE = 0x1;
const AUDIT = 0x2;

let answer: string | null | undefined;

/** `enforce`, `audit` (only logged), `off`, or `unknown` when Windows does not say. Null on other systems. */
export function redirectionGuard(): string | null {
  if (process.platform !== "win32") return null;
  if (answer !== undefined) return answer;
  answer = "unknown";
  try {
    // Required when asked, not imported: the pane screenshot page bundles the
    // plugin loader for a browser, which has no `bun:ffi`.
    const { dlopen, ptr } = import.meta.require("bun:ffi") as typeof import("bun:ffi");
    const kernel32 = dlopen("kernel32.dll", {
      GetProcessMitigationPolicy: { args: ["i64", "i32", "ptr", "u64"], returns: "i32" },
    });
    try {
      const flags = new Uint32Array(1);
      if (kernel32.symbols.GetProcessMitigationPolicy(CURRENT_PROCESS, PROCESS_REDIRECTION_TRUST_POLICY, ptr(flags), 4)) {
        answer = (flags[0]! & ENFORCE) ? "enforce" : (flags[0]! & AUDIT) ? "audit" : "off";
      }
    } finally {
      kernel32.close();
    }
  } catch {
    // Intentional ignore: a Windows without the policy leaves the answer unknown.
  }
  return answer;
}

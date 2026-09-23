/**
 * Scrubs debug text before it leaves the machine in a feedback report. Logs
 * are free text (intercepted console output, plugin messages, request
 * errors), so secrets are found by shape as well as by name. The server
 * scrubs again; this pass keeps them off the wire in the first place.
 */

const REDACTED = "[redacted]";

const SECRET_NAMES = "token|session_token|access_token|refresh_token|id_token|api[_-]?key|apikey|client_secret|secret|signature|password|passwd|authorization|cookie";

const TEXT_RULES: Array<[RegExp, string]> = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, `$1 ${REDACTED}`],
  [/\b(set-cookie|cookie)\s*:\s*[^\n]+/gi, `$1: ${REDACTED}`],
  // `token=...` in URLs and form bodies, `"password":"..."` in JSON.
  [new RegExp(`\\b(${SECRET_NAMES})=([^&\\s"'<>]+)`, "gi"), `$1=${REDACTED}`],
  [new RegExp(`"(${SECRET_NAMES}|accessToken|refreshToken|sessionToken|apiSecret|privateKey)"\\s*:\\s*"[^"]*"`, "gi"), `"$1":"${REDACTED}"`],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, REDACTED],
  [/\b(?:phc|phx|sk|pk|rk|ghp|gho|ghs|ghu|xoxb|xoxp|xoxa)[-_][A-Za-z0-9_-]{10,}/g, REDACTED],
  // Opaque tokens: long runs that mix letters and digits.
  [/(?<![A-Za-z0-9_\-+/=])(?=[A-Za-z0-9_\-+/=]*\d)(?=[A-Za-z0-9_\-+/=]*[A-Za-z])[A-Za-z0-9_\-+/=]{32,}(?![A-Za-z0-9_\-+/=])/g, REDACTED],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  // Home directories name the person using the machine.
  [/\/(Users|home)\/[^/\s"'`]+/g, "~"],
  [/[A-Za-z]:\\Users\\[^\\\s"'`]+/g, "~"],
  // Account numbers: digits named as an account, then long bare digit runs.
  // Epoch timestamps (10 or 13 digits starting with 1) stay readable.
  [/\b(account|acct|iban|routing)([^\n\d]{0,24})\d[\d -]{4,}\d/gi, "$1$2[number]"],
  [/\b(?!1\d{9}\b)(?!1\d{12}\b)\d{9,}\b/g, "[number]"],
];

export function redactText(text: string): string {
  let output = text;
  for (const [pattern, replacement] of TEXT_RULES) {
    output = output.replace(pattern, replacement);
  }
  return output;
}

const SENSITIVE_KEY = /(token|secret|password|passwd|credential|private|api[_-]?key|access[_-]?key|session|cookie|authorization|account(number|id)?$|email)/i;

/** Drops secret-named keys and scrubs every string, to a bounded depth. */
export function redactValue(value: unknown, depth = 0): unknown {
  if (typeof value === "string") return redactText(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 4) return "[truncated]";
  if (Array.isArray(value)) return value.slice(0, 50).map((entry) => redactValue(entry, depth + 1));
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) continue;
    output[key] = redactValue(child, depth + 1);
  }
  return output;
}

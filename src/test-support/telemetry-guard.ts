import { afterAll, afterEach, beforeEach } from "bun:test";

/**
 * The paths a running app reports itself on: crash reports and usage counts
 * (`/telemetry/`), research activity (`/activity/`) and command-search reports
 * (`/assist/searches`). The web app reaches them under `/api`.
 */
const TELEMETRY_PATH = /^(?:\/api)?\/(?:telemetry\/|activity\/|assist\/searches$)/;

/** Whether a request is one the app sends about itself, on any host but the machine's own. */
function isTelemetryRequest(input: RequestInfo | URL): boolean {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]") return false;
    return TELEMETRY_PATH.test(url.pathname);
  } catch {
    // Intentional ignore: a relative or malformed URL names no telemetry endpoint.
    return false;
  }
}

const attempts: string[] = [];

/**
 * Tests never send usage counts or crash reports: `test-env.ts` turns them off
 * for the whole process and for every process a test starts. A test that
 * checks telemetry itself opts in and stubs the transport
 * (`setCloudApiFetchTransport`), so nothing reaches `globalThis.fetch`.
 *
 * This is the net under that: a telemetry request that does reach the real
 * `fetch` is refused and fails the test running when it was made (a fire and
 * forget caller swallows the refusal, so throwing alone would pass), or the
 * run's final check when it was made after the last test.
 */
const realFetch = globalThis.fetch;
const guardedFetch = Object.assign(
  (input: RequestInfo | URL, init?: RequestInit) => {
    if (isTelemetryRequest(input)) {
      const url = input instanceof Request ? input.url : String(input);
      attempts.push(`${init?.method ?? (input instanceof Request ? input.method : "GET")} ${url}`);
      return Promise.reject(new Error(`Telemetry request blocked in tests: ${url}`));
    }
    return realFetch(input, init);
  },
  realFetch,
) as typeof fetch;
globalThis.fetch = guardedFetch;

function failOnAttempts(): void {
  if (attempts.length === 0) return;
  const sent = attempts.splice(0);
  throw new Error(
    `A test sent telemetry to the real service: ${sent.join(", ")}. Tests run with telemetry off; `
    + "a test that exercises telemetry must stub the Cloud API transport (setCloudApiFetchTransport).",
  );
}

afterEach(failOnAttempts);
afterAll(failOnAttempts);

const OPT_OUT_ENV = ["GLOOMBERB_NO_TELEMETRY", "DO_NOT_TRACK"] as const;

/**
 * For a test file, or a `describe`, that checks what the app sends about
 * itself: clears the opt-out `test-env.ts` sets for each test and restores it
 * after. Stub where the report goes (`setCloudApiFetchTransport`, the host's
 * `send`, the `apiClient` method) as well: a report that reaches the real
 * `fetch` fails the test.
 */
export function allowTelemetryInTests(): void {
  let saved: Array<string | undefined> = [];
  beforeEach(() => {
    saved = OPT_OUT_ENV.map((name) => process.env[name]);
    for (const name of OPT_OUT_ENV) delete process.env[name];
  });
  afterEach(() => {
    OPT_OUT_ENV.forEach((name, index) => {
      const value = saved[index];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    });
  });
}

import { afterEach, expect, spyOn, test } from "bun:test";
import { apiClient, setCloudApiFetchTransport } from "../../api-client";
import { earningsCallsModule } from "../../plugins/builtin/earnings-calls";
import { estimateRevisionsModule } from "../../plugins/builtin/estimate-revisions";
import { jobsModule } from "../../plugins/builtin/jobs";
import type { PluginModule } from "../../plugins/builtin/plugin-module";
import { scannerModule } from "../../plugins/builtin/scanner";
import { socialMentionsModule } from "../../plugins/builtin/social-mentions";
import { blockExternalNetwork } from "../../test-support/network-guard";
import { createTestDataProvider } from "../../test-support/data-provider";
import { createDefaultConfig } from "../../types/config";
import { buildHeadlessFunctionReport } from "./headless";

blockExternalNetwork();

const restores: Array<() => void> = [];

afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  setCloudApiFetchTransport(null);
  apiClient.dispose();
});

/** A function whose wall covers it whole, run headless with the server refusing the read. */
interface LockedFunction {
  module: PluginModule;
  template: string;
  token: string;
  argument: string;
  settings?: Record<string, unknown>;
  /** What the lock says the function needs. */
  needs: "Gloom Cloud Pro" | "a free Gloom sign-in";
  /** The command the note names as the free route, or null when none has data for the ticker. */
  free: string | null;
  /** The command that reads with a session, as the note's last line ends it. */
  command: string;
}

const LOCKED_FUNCTIONS: LockedFunction[] = [
  { module: scannerModule, template: "scanner-flow-pane", token: "FLOW", argument: "", needs: "Gloom Cloud Pro", free: "gloomberb options <ticker> lists the company's option chain", command: "gloomberb fn FLOW then reads" },
  { module: estimateRevisionsModule, template: "estimate-revisions-em", token: "EM", argument: "ACME:NASDAQ", needs: "a free Gloom sign-in", free: "gloomberb earnings ACME:NASDAQ lists", command: "gloomberb fn EM ACME:NASDAQ then reads" },
  // GUIDE has nothing for ACME (its read is refused like every other here), so the note names its 8-Ks.
  { module: estimateRevisionsModule, template: "estimate-revisions-guid", token: "GUID", argument: "ACME:NASDAQ", settings: { tab: "guidance" }, needs: "a free Gloom sign-in", free: "gloomberb filings ACME:NASDAQ --form 8-K lists", command: "gloomberb fn GUID ACME:NASDAQ then reads" },
  { module: earningsCallsModule, template: "earnings-calls-pane", token: "CALLS", argument: "ACME", needs: "Gloom Cloud Pro", free: "gloomberb events ACME lists ACME's earnings dates", command: "gloomberb fn CALLS ACME then reads" },
  // No earnings dates on file for QUIET: events would answer with none, so no route is named.
  { module: earningsCallsModule, template: "earnings-calls-pane", token: "CALLS", argument: "QUIET", needs: "Gloom Cloud Pro", free: null, command: "gloomberb fn CALLS QUIET then reads" },
  { module: jobsModule, template: "jobs-pane", token: "JOBS", argument: "", needs: "Gloom Cloud Pro", free: "gloomberb fn HIRE <ticker> previews", command: "gloomberb fn JOBS then reads" },
  { module: socialMentionsModule, template: "social-mentions-pane", token: "BUZZ", argument: "ACME", needs: "a free Gloom sign-in", free: null, command: "gloomberb fn BUZZ ACME then reads" },
];

/** The refusal the server gives, as each function's read meets it. */
function refuse(fn: LockedFunction, status: 401 | 402 | 403) {
  if (fn.token === "FLOW") {
    // The scanner answers over its feed, which names the same two walls.
    const spy = spyOn(apiClient, "subscribeScanner").mockImplementation(((_scanner: string, listener: (event: unknown) => void) => {
      listener({ type: "denied", reason: status === 402 ? "pro_required" : "auth_required" });
      return () => {};
    }) as never);
    restores.push(() => spy.mockRestore());
    return;
  }
  setCloudApiFetchTransport((async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    // The SEC's filing list is free, so a route to ACME's 8-Ks reads it signed out.
    if (url.pathname === "/cloud/sec/filings") return Response.json({ filings: url.searchParams.get("ticker") === "ACME" ? [{ form: "8-K" }] : [], hasMore: false });
    return new Response("Refused", { status });
  }) as typeof fetch);
}

/** What the free routes read besides the SEC's filings: ACME has a report date and earnings on file; QUIET has neither. */
const ACME_DATA = createTestDataProvider({
  getEarningsCalendar: async (symbols) => (symbols.some((symbol) => symbol.startsWith("ACME")) ? [{ symbol: "ACME" }] : []) as never,
  getCorporateActions: async (symbol) => ({ symbol, dividends: [], splits: [], earnings: symbol === "ACME" ? [{}] : [] }) as never,
});

function run(fn: LockedFunction) {
  const template = fn.module.paneTemplates!.find((candidate) => candidate.id === fn.template)!;
  return buildHeadlessFunctionReport(
    {
      headless: template.headless,
      token: fn.token,
      label: template.label,
      options: {},
      instance: { settings: fn.settings ?? {} },
      capability: { id: template.id },
      pane: fn.module.panes!.find((pane) => pane.id === template.paneId),
    } as never,
    { dataProvider: ACME_DATA, config: createDefaultConfig("/tmp/gloomberb-lock-note-test"), store: { loadTicker: async () => null } } as never,
    fn.argument,
  );
}

test("every function a wall covers whole answers a refused read with the one lock shape, in text, JSON and CSV", async () => {
  for (const fn of LOCKED_FUNCTIONS) {
    for (const [status, gate, who] of [
      [401, "sign-in", "Signed out"],
      [403, "sign-in", "Until the email is verified"],
      [402, "pro", "On a free account"],
    ] as const) {
      // The scanner's feed names two walls, no session and no plan.
      if (fn.token === "FLOW" && status === 403) continue;
      refuse(fn, status);
      const report = await run(fn);
      const label = `${fn.token} ${status}`;
      // What it is, who it shows nothing to, and what it asks for.
      const pro = fn.needs === "Gloom Cloud Pro" || gate === "pro";
      expect(report.text, label).toContain(`${fn.token} ${pro ? "is part of Gloom Cloud Pro" : "needs a free Gloom sign-in"}: `);
      expect(report.text.replace(/\s+/g, " "), label).toContain(`${who} it shows none of it.`);
      // The free route is named only where one answers, and how to unlock closes the note.
      expect(report.text.replace(/\s+/g, " "), label).toContain(fn.free ? `Free, with no sign-in: ${fn.free}` : "To read it in");
      if (!fn.free) expect(report.text, label).not.toContain("Free, with no sign-in");
      const unlock = status === 403 ? "verify your email (Ctrl+P, Resend Verification Email)"
        : gate === "pro" ? "upgrade in the app (gloomberb, then Ctrl+P, UPGRADE)" : "log in or sign up";
      expect(report.text.replace(/\s+/g, " "), label).toContain(unlock);
      expect(report.text.replace(/\s+/g, " "), label).toContain(`${fn.command} with that session.`);
      expect(report.text, label).toEndWith("The pane is locked, so no values were read.");
      // JSON and CSV give the same words on one line, with no source cited.
      expect(report.data, label).toMatchObject({ locked: gate, empty: true, complete: false });
      expect(String(report.data.reason), label).not.toContain("\n");
      expect(String(report.data.reason), label).toContain(`${fn.token} ${pro ? "is part of Gloom Cloud Pro" : "needs a free Gloom sign-in"}: `);
      expect(report.tables.footer.some((line) => /^Source:|^Retrieval time/.test(line)), label).toBe(false);
      expect(`${report.text}${report.data.reason}`, label).not.toMatch(/Sign in required|Pro access required|requires signup/);
      for (const restore of restores.splice(0)) restore();
    }
  }
});

test("a failure that is no refusal stays the error", async () => {
  setCloudApiFetchTransport((async () => new Response("Server error", { status: 500 })) as typeof fetch);
  await expect(run(LOCKED_FUNCTIONS.find((fn) => fn.token === "BUZZ")!)).rejects.toThrow("Server error");
});

import type { CloudHoldersPayload, CloudMarketResponse, CloudProxyStatementPayload } from "../../src/api-client";
import type { EarningsCalendarPayload } from "../../src/api-client/earnings";
import { SESSION_COOKIE_NAMES } from "../../src/api-client/session-cookie";
import { AppPersistence } from "../../src/data/app-persistence";
import { gpuBoard } from "../../src/plugins/builtin/gpu/test-fixture";
import { list, report } from "../../src/plugins/builtin/risk-factors/test-fixtures";

export const fixtureSession = "warm-start-synthetic-session";
export const fixtureCookie = SESSION_COOKIE_NAMES[1];
const fixtureUser = { id: "warm-start-pro", username: "warm-start-pro", name: "Warm Start", emailVerified: true, plan: "pro" };

export function seedFixtureNativeSession(dbPath: string): void {
  const persistence = new AppPersistence(dbPath);
  try {
    const session = { sessionToken: fixtureSession, user: fixtureUser };
    persistence.pluginState.set("gloomberb-cloud", "session", session, 1);
    persistence.pluginState.set("gloomberb-cloud", "resume:session", session, 1);
  } finally {
    persistence.close();
  }
}

export function fixtureProAnswer(request: Request, url: URL): Response | null {
  if (!request.method.match(/^(GET|HEAD)$/) || url.hostname !== "api.gloom.sh") return null;
  const path = url.pathname;
  const signedIn = request.headers.get("authorization") === `Bearer ${fixtureSession}` ||
    request.headers.get("cookie")?.split(";").some((cookie) => cookie.trim() === `${fixtureCookie}=${fixtureSession}`);
  if (path === "/auth/get-session") return Response.json(signedIn ? { user: fixtureUser } : null);
  if (!signedIn && (path === "/cloud/gpu/board" || path === "/market/holders" || path.startsWith("/cloud/earnings/"))) {
    return Response.json({ error: "Sign in required" }, { status: 401 });
  }
  if (path.startsWith("/cloud/risks/")) {
    if (!signedIn) return Response.json({ error: "Sign in required" }, { status: 401 });
    const riskCompany = { ticker: "AAPL", cik: "0000320193", name: "Apple Inc.", shortName: "Apple" };
    const risk = { ...report(2025), ticker: "AAPL", company: riskCompany };
    return Response.json(path.endsWith("/2025") ? risk : { ...list([2025]), company: riskCompany, reports: [risk] });
  }
  if (path.startsWith("/cloud/proxies/")) {
    if (!signedIn) return Response.json({ error: "Sign in required" }, { status: 401 });
    const statement: CloudProxyStatementPayload = {
      id: "fixture-proxy", ticker: "NVDA", proxyYear: 2025, fiscalYear: 2024,
      fiscalYearLabel: "Fiscal 2024", filedAt: "2025-04-01", updatedAt: "2025-04-01",
      company: { ticker: "NVDA", cik: null, name: "NVIDIA", shortName: "NVIDIA" }, meetingDate: null,
      ceoName: null, ceoTitle: null, ceoTotal: null, ceoPriorYearTotal: null,
      payRatio: null, medianEmployeePay: null, sayOnPayPriorSupport: null,
      docUrl: "https://example.com/proxy", ceo: null, namedExecutives: [],
      highlights: "Compensation summary for the replay", keyFigures: [], otherYears: [],
    };
    return Response.json(path.endsWith("/2025") ? statement : { company: statement.company, proxies: [statement] });
  }
  if (path === "/cloud/gpu/board") return Response.json(gpuBoard());
  if (path === "/market/holders") {
    return Response.json({ status: "success", data: {
      providerId: "gloomberb-cloud", symbol: "AAPL", currency: "USD",
      holders: [{ providerId: "gloomberb-cloud", name: "Replay Capital", ownerType: "institution", shares: 1000, value: 200000 }],
    } } satisfies CloudMarketResponse<CloudHoldersPayload>);
  }
  if (path === "/cloud/earnings/history") return Response.json({ asOf: new Date().toISOString(), symbol: "AAPL", name: "Apple", reports: [] });
  if (path === "/cloud/earnings/calendar") {
    const from = url.searchParams.get("from")!;
    const to = url.searchParams.get("to")!;
    return Response.json({ asOf: new Date().toISOString(), from, to, reports: [{
      symbol: "AAPL", name: "Apple", date: from, timing: "bmo", timingSource: "calendar", reportedAt: null,
      fiscalPeriod: "2026-09", marketCap: 1e12, epsEstimate: 2, epsActual: null, epsAnalysts: 10,
      revenueEstimate: null, revenueAnalysts: null, implied: null, realized: null, averageMove: null, averageReports: 0,
    }] } satisfies EarningsCalendarPayload);
  }
  return null;
}

// The real terminal app with only TheBuildout's account answered here: the pane sees a signed-in user
// with access, and TheBuildout's API is a fixture (no request leaves for thebuildout.ai, no star reaches it).
// Everything else (registry, ticker search, quotes) is the real app, signed out.
const APP = process.env.APP!;
const { apiClient } = await import(`${APP}/src/api-client/index.ts`);
(apiClient as any).isSignedIn = () => true;
(apiClient as any).getSession = async () => ({ id: "repro-user" });
(apiClient as any).getBuildoutAccount = async () => ({ subscription: { active: true } });
(apiClient as any).getBuildoutToken = async () => ({ token: "repro-token", expiresAt: "2099-01-01T00:00:00Z" });
const ticker = process.env.REPRO_TICKER ?? "NVDA";
const companies = [
  { id: "c-1", name: "Northwind Datacenters", ...(ticker === "-" ? {} : { ticker }) },
  { id: "c-2", name: "Helios Fabrication" },
  { id: "c-3", name: "Quarry Power Systems" },
];
const starred = new Set<string>();
const realFetch = globalThis.fetch;
const log = (line: string) => require("fs").appendFileSync(`${import.meta.dir}/tui-buildout.log`, `${new Date().toISOString()} ${line}\n`);
globalThis.fetch = (async (input: any, init?: RequestInit) => {
  const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const url = new URL(href);
  if (url.hostname !== "api.thebuildout.ai") return realFetch(input, init);
  const method = (init?.method ?? "GET").toUpperCase();
  log(`${method} ${url.pathname}`);
  if (method === "POST" || method === "DELETE") {
    if (process.env.STAR_FAIL) return new Response("Starring is paused for maintenance.", { status: 503 });
    const id = decodeURIComponent(url.pathname.split("/").pop() ?? "");
    if (starred.has(id)) starred.delete(id); else starred.add(id);
    return Response.json({ starred: starred.has(id) });
  }
  if (url.pathname === "/companies") return Response.json(companies.map((company) => ({ ...company, starred: starred.has(company.id) })));
  return Response.json([]);
}) as typeof fetch;

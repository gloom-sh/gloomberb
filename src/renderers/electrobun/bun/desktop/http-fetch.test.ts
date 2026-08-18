import { afterEach, describe, expect, test } from "bun:test";
import {
  connectionHealth,
  registerGloomCloudConnectionSources,
} from "../../../../core/connection-health";
import { handleHttpFetch } from "./http-fetch";

let server: ReturnType<typeof Bun.serve> | null = null;
let disposeConnections: (() => void) | null = null;
const originalApiUrl = process.env.GLOOMBERB_API_URL;

afterEach(() => {
  server?.stop(true);
  server = null;
  disposeConnections?.();
  disposeConnections = null;
  if (originalApiUrl === undefined) delete process.env.GLOOMBERB_API_URL;
  else process.env.GLOOMBERB_API_URL = originalApiUrl;
});

describe("handleHttpFetch", () => {
  test("preserves manual redirects and Set-Cookie headers", async () => {
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/login") {
          return new Response(null, {
            status: 302,
            headers: {
              location: "/reader",
              "set-cookie": "substack.sid=sid123; Path=/; HttpOnly",
            },
          });
        }
        if (url.pathname === "/reader") {
          return new Response("reader");
        }
        return new Response("not found", { status: 404 });
      },
    });

    const response = await handleHttpFetch({
      url: new URL("/login", server.url).toString(),
      init: { redirect: "manual" },
    });

    expect(response.status).toBe(302);
    expect(response.headers.location).toBe("/reader");
    expect(response.setCookie).toEqual(["substack.sid=sid123; Path=/; HttpOnly"]);
  });

  test("reports proxied Gloom FRED requests in the backend registry", async () => {
    server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ observations: [], info: null }),
    });
    process.env.GLOOMBERB_API_URL = server.url.origin;
    disposeConnections = registerGloomCloudConnectionSources(connectionHealth);

    await handleHttpFetch({
      url: new URL("/cloud/econ/series/VIXCLS", server.url).toString(),
    });

    expect(connectionHealth.getSnapshot().sources.map((source) => ({
      id: source.id,
      status: source.status,
      operation: source.lastOperation,
    }))).toEqual([
      { id: "gloom-cloud-http", status: "connected", operation: "GET /cloud/econ/series/VIXCLS" },
      { id: "gloom-cloud-socket", status: "idle", operation: null },
      { id: "gloom-cloud-fred", status: "connected", operation: "GET /cloud/econ/series/VIXCLS" },
    ]);
  });

  test("aborts the backend fetch at the requested deadline", async () => {
    server = Bun.serve({
      port: 0,
      fetch() {
        return new Promise<Response>(() => {});
      },
    });

    await expect(handleHttpFetch({
      url: server.url.toString(),
      init: { timeoutMs: 10 },
    })).rejects.toThrow();
  });
});

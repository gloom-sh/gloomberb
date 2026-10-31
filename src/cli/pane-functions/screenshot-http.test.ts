import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brotliCompressSync, deflateSync, gzipSync } from "node:zlib";
import { fetchShotHttpAddress } from "./screenshot-http";

test.each([
  ["gzip", gzipSync], ["deflate", deflateSync], ["br", brotliCompressSync],
] as const)("the checked address preserves the URL host, request body and %s response without another lookup", async (encoding, compress) => {
  const requests: Array<{ host: string | null; body: string }> = [];
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(request) {
      requests.push({ host: request.headers.get("host"), body: await request.text() });
      return new Response(compress("feed contents"), {
        headers: { "content-encoding": encoding, "set-cookie": "feed=1" },
      });
    },
  });
  try {
    const url = new URL(`http://feeds.example.invalid:${server.port}/feed`);
    const response = await fetchShotHttpAddress(url, { method: "POST", body: "query", signal: AbortSignal.timeout(3_000) }, "127.0.0.1");
    expect(await response.text()).toBe("feed contents");
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.getSetCookie()).toEqual(["feed=1"]);
    expect(requests).toEqual([{ host: url.host, body: "query" }]);
    await expect(fetchShotHttpAddress(url, {}, "feeds.example.invalid")).rejects.toThrow("must be an IP address");
  } finally {
    server.stop(true);
  }
});

test("address-bound HTTP leaves redirects to the bridge and aborts an unfinished response", async () => {
  const server = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/moved") return new Response(null, { status: 302, headers: { location: "http://other.example.invalid/feed" } });
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("start")); } }));
    },
  });
  try {
    const moved = await fetchShotHttpAddress(new URL(`http://feeds.example.invalid:${server.port}/moved`), {}, "127.0.0.1");
    expect(moved.status).toBe(302);
    expect(moved.headers.get("location")).toBe("http://other.example.invalid/feed");
    await moved.body?.cancel();
    const ongoing = await fetchShotHttpAddress(new URL(`http://feeds.example.invalid:${server.port}/stream`), { signal: AbortSignal.timeout(100) }, "127.0.0.1");
    await expect(ongoing.text()).rejects.toThrow();
  } finally {
    server.stop(true);
  }
});

// A locally trusted certificate lets the transport exercise the URL's TLS name without internet access.
test.skipIf(!Bun.which("openssl"))("HTTPS keeps certificate checks on the URL's name when it connects to a checked address", async () => {
  const folder = await mkdtemp(join(tmpdir(), "gloom-shot-tls-"));
  const cert = join(folder, "cert.pem");
  const key = join(folder, "key.pem");
  let server: ReturnType<typeof Bun.serve> | undefined;
  try {
    const generated = Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=feeds.example.invalid", "-addext", "subjectAltName=DNS:feeds.example.invalid", "-keyout", key, "-out", cert], { stdout: "ignore", stderr: "pipe" });
    expect(generated.exitCode).toBe(0);
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, tls: { key: Bun.file(key), cert: Bun.file(cert) }, fetch: () => new Response("verified") });
    const child = Bun.spawn([process.execPath, "-e", `
      const { fetchShotHttpAddress } = await import(${JSON.stringify(join(import.meta.dir, "screenshot-http.ts"))});
      const responses = [];
      for (const host of ["feeds.example.invalid", "other.example.invalid"]) {
        try {
          const response = await fetchShotHttpAddress(new URL("https://" + host + ":${server.port}/"), { signal: AbortSignal.timeout(3000) }, "127.0.0.1");
          responses.push(await response.text());
        } catch { responses.push("refused"); }
      }
      console.log(JSON.stringify(responses));
    `], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, stdout: "pipe", stderr: "pipe" });
    const [output, errors, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect({ status, errors }).toEqual({ status: 0, errors: "" });
    expect(JSON.parse(output)).toEqual(["verified", "refused"]);
  } finally {
    server?.stop(true);
    await rm(folder, { recursive: true, force: true });
  }
}, 15_000);

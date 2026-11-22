import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { type Pin, startMirror, UPSTREAM } from "./electrobun-toolchain";

const encoder = new TextEncoder();
const coreUrl = `${UPSTREAM.releases}/v1.0.0/core.tar.gz`;
const indexUrl = `${UPSTREAM.releases}/v1.0.0/index.json`;
const core = encoder.encode("core archive");
const index = encoder.encode(JSON.stringify({ core: coreUrl, cottontail: `${UPSTREAM.artifacts}/cottontail.tar.gz` }));

function pinOf(url: string, bytes: Uint8Array): Pin {
  return { url, sha256: createHash("sha256").update(bytes).digest("hex"), size: bytes.length };
}

let stop = () => {};
afterEach(() => stop());

// The mirror is all that stands between Hutch and an archive that changed
// upstream: it must hand over only bytes that match their pin.
test("hands Hutch a pinned file only when its bytes match, and points an index's URLs back at itself", async () => {
  const upstream = new Map([[coreUrl, core], [indexUrl, index]]);
  const mirror = startMirror([pinOf(coreUrl, core), pinOf(indexUrl, index)], async (url) => upstream.get(url)!);
  stop = mirror.stop;

  const served = await fetch(`${mirror.origin}/releases/v1.0.0/core.tar.gz`);
  expect(served.status).toBe(200);
  expect(new Uint8Array(await served.arrayBuffer())).toEqual(core);
  expect(await (await fetch(`${mirror.origin}/releases/v1.0.0/index.json`)).json()).toEqual({
    core: `${mirror.origin}/releases/v1.0.0/core.tar.gz`,
    cottontail: `${mirror.origin}/artifacts/cottontail.tar.gz`,
  });

  upstream.set(coreUrl, encoder.encode("core archive, changed"));
  const changed = await fetch(`${mirror.origin}/releases/v1.0.0/core.tar.gz`);
  expect(changed.status).toBe(502);
  expect(await changed.text()).not.toContain("core archive");
  expect(mirror.refused).toEqual([expect.stringContaining(`${coreUrl} does not match its pin`)]);
});

test("refuses a file with no pin without fetching it", async () => {
  const fetched: string[] = [];
  const mirror = startMirror([pinOf(coreUrl, core)], async (url) => {
    fetched.push(url);
    return core;
  });
  stop = mirror.stop;

  for (const path of ["/releases/v1.0.0/other.tar.gz", "/npm/esbuild", "/elsewhere"]) {
    expect((await fetch(`${mirror.origin}${path}`)).status).toBe(404);
  }
  expect(fetched).toEqual([]);
  expect(mirror.refused).toHaveLength(3);
});

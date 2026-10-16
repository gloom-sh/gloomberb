import { describe, expect, test } from "bun:test";
import { readZipTexts } from "../plugins/builtin/shared/zip-text";
import {
  createProxyResponse,
  decodeBase64,
  encodeBase64,
  readProxyResponseText,
  toResponseEnvelope,
  type HttpProxyResponseEnvelope,
} from "./http-proxy-response";

/** A one-member deflate zip with sizes in the local header, the form JODI and USDA publish. */
async function zipOf(name: string, content: Uint8Array): Promise<Uint8Array> {
  const compressed = new Uint8Array(await new Response(
    new Blob([content.slice()]).stream().pipeThrough(new CompressionStream("deflate-raw")),
  ).arrayBuffer());
  const nameBytes = new TextEncoder().encode(name);
  const zip = new Uint8Array(30 + nameBytes.length + compressed.length);
  const view = new DataView(zip.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(8, 8, true);
  view.setUint32(14, 0xdeadbeef, true);
  view.setUint32(18, compressed.length, true);
  view.setUint32(22, content.length, true);
  view.setUint16(26, nameBytes.length, true);
  zip.set(nameBytes, 30);
  zip.set(compressed, 30 + nameBytes.length);
  return zip;
}

/** What each hop does to the envelope: JSON out of the server half, JSON into the client half. */
async function acrossTheProxy(response: Response): Promise<HttpProxyResponseEnvelope> {
  return JSON.parse(JSON.stringify(await toResponseEnvelope(response))) as HttpProxyResponseEnvelope;
}

describe("proxied response bodies", () => {
  test("a zip archive arrives byte for byte and still opens", async () => {
    // Latin-1 text, so the archive is not UTF-8 even before compression.
    const csv = Uint8Array.from("Côte d'Ivoire,12\n", (char) => char.charCodeAt(0));
    const zip = await zipOf("balances.csv", csv);

    const envelope = await acrossTheProxy(new Response(zip, { headers: { "content-type": "application/zip" } }));
    const bytes = new Uint8Array(await createProxyResponse(envelope).arrayBuffer());

    expect(envelope.body).toBe("");
    expect(bytes).toEqual(zip);
    expect(await readZipTexts(bytes)).toEqual([{ name: "balances.csv", text: "Côte d'Ivoire,12\n" }]);
  });

  test("UTF-8 text stays text, and a byte-order mark is not lost", async () => {
    const text = await acrossTheProxy(new Response("€uro"));
    expect(text.body).toBe("€uro");
    expect(text.bodyBase64).toBeUndefined();

    const marked = Uint8Array.from([0xef, 0xbb, 0xbf, ...new TextEncoder().encode("a,b")]);
    const envelope = await acrossTheProxy(new Response(marked));
    expect(new Uint8Array(await createProxyResponse(envelope).arrayBuffer())).toEqual(marked);
    expect(readProxyResponseText(envelope)).toBe("a,b");
  });

  test("the base64 fallback for older webviews matches the native codec, and bad input fails loudly", () => {
    const bytes = Uint8Array.from({ length: 3 * 0x2000 * 2 + 5 }, (_, index) => (index * 151) & 0xff);
    const encoded = encodeBase64(bytes, true);

    expect(encodeBase64(bytes, false)).toBe(encoded);
    expect(decodeBase64(encoded, false)).toEqual(bytes);
    expect(decodeBase64("%%%", false)).toBeUndefined();
    // A corrupt body must not read as an empty file.
    expect(() => createProxyResponse({ status: 200, statusText: "OK", headers: {}, body: "", bodyBase64: "%%%" }))
      .toThrow("not valid base64");
  });
});

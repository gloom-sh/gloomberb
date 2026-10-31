import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { checkServerIdentity } from "node:tls";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

/**
 * A single HTTP hop to an address already checked by the screenshot bridge.
 * The socket uses that address directly, while Host and TLS keep the URL's
 * name. A fresh connection keeps another request's DNS result out of the hop.
 */
export function fetchShotHttpAddress(url: URL, init: RequestInit, address: string): Promise<Response> {
  if (!isIP(address)) return Promise.reject(new Error("The screenshot address must be an IP address."));
  const headers = new Headers(init.headers);
  headers.set("host", url.host);
  headers.set("accept-encoding", "gzip, deflate, br");
  if (!headers.has("accept")) headers.set("accept", "*/*");
  if (!headers.has("user-agent")) headers.set("user-agent", `Bun/${Bun.version}`);
  if (typeof init.body === "string" && !headers.has("content-type")) headers.set("content-type", "text/plain;charset=UTF-8");
  const requestHeaders: Record<string, string> = {};
  headers.forEach((value, name) => { requestHeaders[name] = value; });
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  return new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      hostname: address,
      method: init.method,
      headers: requestHeaders,
      agent: false,
      signal: init.signal ?? undefined,
      ...(url.protocol === "https:" ? {
        servername: isIP(hostname) ? "" : hostname,
        checkServerIdentity: (_name: string, certificate: Parameters<typeof checkServerIdentity>[1]) => checkServerIdentity(hostname, certificate),
      } : {}),
    }, (incoming) => {
      try {
        const responseHeaders = new Headers();
        for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
          responseHeaders.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        }
        const status = incoming.statusCode ?? 502;
        if (init.method === "HEAD" || status === 204 || status === 205 || status === 304) {
          incoming.resume();
          resolve(new Response(null, { status, statusText: incoming.statusMessage, headers: responseHeaders }));
          return;
        }
        const encoding = responseHeaders.get("content-encoding")?.toLowerCase();
        const decoder = encoding === "gzip" ? createGunzip()
          : encoding === "deflate" ? createInflate()
          : encoding === "br" ? createBrotliDecompress() : null;
        if (decoder) {
          responseHeaders.delete("content-encoding");
          responseHeaders.delete("content-length");
          incoming.on("error", (error) => decoder.destroy(error));
          decoder.once("close", () => incoming.destroy());
        }
        const stream = decoder ? incoming.pipe(decoder) : incoming;
        resolve(new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
          status, statusText: incoming.statusMessage, headers: responseHeaders,
        }));
      } catch (error) {
        incoming.destroy();
        reject(error);
      }
    });
    request.once("error", reject);
    if (init.body !== undefined && init.body !== null) request.write(init.body);
    request.end();
  });
}

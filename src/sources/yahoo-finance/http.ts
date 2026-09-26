import { httpFetch } from "../../utils/http-transport";

const MAX_RETRIES = 3;
const RETRY_BASE_MS = 1500;
const FETCH_TIMEOUT_MS = 20_000;
const RETRYABLE_ERROR = /403|401|Forbidden|Unauthorized|ECONNRESET|ETIMEDOUT|ENOTFOUND|fetch failed|Failed to get crumb|socket hang up|503|502|504/i;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class YahooHttpClient {
  private crumb: string | null = null;
  private cookie: string | null = null;
  private crumbPromise: Promise<void> | null = null;

  defaultHeaders() {
    return {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Accept: "application/json,text/plain,*/*",
      "Accept-Language": "en-US,en;q=0.9",
      Referer: "https://finance.yahoo.com/",
    };
  }

  async fetchJson<T>(url: string): Promise<T> {
    return this.withRetry(async () => {
      const resp = await httpFetch(url, {
        headers: this.defaultHeaders(),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`[${resp.status}] ${(await resp.text()).slice(0, 200)}`);
      return resp.json() as Promise<T>;
    });
  }

  async fetchJsonWithCrumb<T>(url: string): Promise<T> {
    return this.crumbRequest<T>("GET", url);
  }

  async postJsonWithCrumb<T>(url: string, body: unknown): Promise<T> {
    return this.crumbRequest<T>("POST", url, body);
  }

  private crumbRequest<T>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> {
    return this.withRetry(async () => {
      await this.ensureCrumb();
      const separator = url.includes("?") ? "&" : "?";
      const fullUrl = `${url}${separator}crumb=${encodeURIComponent(this.crumb!)}`;
      const resp = await httpFetch(fullUrl, {
        method,
        headers: {
          ...this.defaultHeaders(),
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
          Cookie: this.cookie!,
        },
        body: method === "POST" ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (resp.status === 401) {
        this.crumb = null;
        this.cookie = null;
        throw new Error("[401] Invalid Crumb");
      }
      if (!resp.ok) throw new Error(`[${resp.status}] ${(await resp.text()).slice(0, 200)}`);
      return resp.json() as Promise<T>;
    });
  }

  private async ensureCrumb(): Promise<void> {
    if (this.crumb && this.cookie) return;
    if (this.crumbPromise) return this.crumbPromise;
    this.crumbPromise = (async () => {
      try {
        const cookieResp = await httpFetch("https://fc.yahoo.com/", {
          headers: this.defaultHeaders(),
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
          redirect: "manual",
        });
        const setCookie = cookieResp.headers.get("set-cookie");
        if (!setCookie) throw new Error("Failed to get Yahoo cookie");
        this.cookie = setCookie.split(",").map((cookie) => cookie.split(";")[0]!.trim()).join("; ");

        const crumbResp = await httpFetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
          headers: { ...this.defaultHeaders(), Cookie: this.cookie },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (!crumbResp.ok) throw new Error(`Failed to get crumb: ${crumbResp.status}`);
        this.crumb = await crumbResp.text();
        if (!this.crumb) throw new Error("Empty crumb response");
      } catch (error) {
        this.crumb = null;
        this.cookie = null;
        throw error;
      } finally {
        this.crumbPromise = null;
      }
    })();
    return this.crumbPromise;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (!RETRYABLE_ERROR.test(error instanceof Error ? error.message : String(error)) || attempt === MAX_RETRIES) {
          throw error;
        }
        const delay = Math.min(30_000, RETRY_BASE_MS * Math.pow(2, attempt)) + Math.round(Math.random() * 300);
        await sleep(delay);
      }
    }
    throw lastError;
  }
}

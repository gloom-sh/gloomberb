import { describe, expect, test } from "bun:test";
import {
  adoptDesktopHandoff,
  carriesHandoff,
  observeDesktopDeepLinks,
  readStoredAttribution,
  resolveBrowserAttribution,
} from "./research-activity";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const ANON = "0f1e2d3c-4b5a-4968-8776-655443322110";

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("resolveBrowserAttribution", () => {
  test("a direct visit still records a first touch", () => {
    const result = resolveBrowserAttribution({
      href: "https://term.gloom.sh/",
      now: NOW,
      referrer: "",
      stored: null,
    });
    expect(result).toEqual({
      first_touch_at: "2026-09-10T12:00:00.000Z",
      first_touch_landing_page: "/",
    });
  });

  test("an external referrer is kept, our own origin is not", () => {
    expect(
      resolveBrowserAttribution({
        href: "https://term.gloom.sh/?ticker=NVDA",
        now: NOW,
        referrer: "https://t.co/abc123",
        stored: null,
      }).first_touch_referrer,
    ).toBe("https://t.co/abc123");
    expect(
      resolveBrowserAttribution({
        href: "https://term.gloom.sh/s/share-id",
        now: NOW,
        referrer: "https://term.gloom.sh/",
        stored: null,
      }).first_touch_referrer,
    ).toBeUndefined();
  });

  test("a campaign on the first visit lands in both first touch and last touch", () => {
    const result = resolveBrowserAttribution({
      href: "https://term.gloom.sh/?utm_source=x&utm_medium=paid_social&utm_campaign=c1&twclid=click_1",
      now: NOW,
      referrer: "https://t.co/xyz",
      stored: null,
    });
    expect(result).toEqual({
      first_touch_at: "2026-09-10T12:00:00.000Z",
      first_touch_landing_page: "/",
      first_touch_referrer: "https://t.co/xyz",
      first_touch_utm_source: "x",
      first_touch_utm_medium: "paid_social",
      first_touch_utm_campaign: "c1",
      first_touch_twclid: "click_1",
      last_touch_at: "2026-09-10T12:00:00.000Z",
      utm_source: "x",
      utm_medium: "paid_social",
      utm_campaign: "c1",
      twclid: "click_1",
    });
  });

  test("a later campaign replaces the click id but keeps the first touch", () => {
    const first = resolveBrowserAttribution({
      href: "https://term.gloom.sh/?utm_source=x&utm_campaign=c1&twclid=click_1",
      now: NOW - 3 * DAY,
      referrer: "https://t.co/xyz",
      stored: null,
    });
    const later = resolveBrowserAttribution({
      href: "https://term.gloom.sh/?utm_source=newsletter&utm_campaign=c2",
      now: NOW,
      referrer: "",
      stored: JSON.stringify(first),
    });
    expect(later.first_touch_twclid).toBe("click_1");
    expect(later.first_touch_utm_campaign).toBe("c1");
    expect(later.first_touch_referrer).toBe("https://t.co/xyz");
    expect(later.twclid).toBeUndefined();
    expect(later.utm_source).toBe("newsletter");
    expect(later.utm_campaign).toBe("c2");
    expect(later.last_touch_at).toBe("2026-09-10T12:00:00.000Z");
  });

  test("a return visit without params reuses the stored touches", () => {
    const first = resolveBrowserAttribution({
      href: "https://term.gloom.sh/?utm_source=x&twclid=click_1",
      now: NOW - 5 * DAY,
      referrer: "https://t.co/xyz",
      stored: null,
    });
    const back = resolveBrowserAttribution({
      href: "https://term.gloom.sh/",
      now: NOW,
      referrer: "",
      stored: JSON.stringify(first),
    });
    expect(back).toEqual(first);
  });

  test("first touch and campaign expire independently after 30 days", () => {
    const first = resolveBrowserAttribution({
      href: "https://term.gloom.sh/",
      now: NOW - 35 * DAY,
      referrer: "https://news.ycombinator.com/",
      stored: null,
    });
    const campaign = resolveBrowserAttribution({
      href: "https://term.gloom.sh/?utm_source=x&twclid=click_1",
      now: NOW - 10 * DAY,
      referrer: "",
      stored: JSON.stringify(first),
    });
    expect(campaign.first_touch_referrer).toBe("https://news.ycombinator.com/");

    const now = resolveBrowserAttribution({
      href: "https://term.gloom.sh/",
      now: NOW,
      referrer: "",
      stored: JSON.stringify(campaign),
    });
    expect(now.first_touch_at).toBe("2026-09-10T12:00:00.000Z");
    expect(now.first_touch_referrer).toBeUndefined();
    expect(now.twclid).toBe("click_1");
    expect(now.last_touch_at).toBe(campaign.last_touch_at);
  });

  test("legacy storage without a first touch is upgraded in place", () => {
    const legacy = JSON.stringify({
      last_touch_at: new Date(NOW - 2 * DAY).toISOString(),
      utm_source: "x",
      utm_content: "homepage_hero_v1",
      twclid: "click_legacy",
    });
    const result = resolveBrowserAttribution({
      href: "https://term.gloom.sh/",
      now: NOW,
      referrer: "",
      stored: legacy,
    });
    expect(result.twclid).toBe("click_legacy");
    expect(result.utm_content).toBe("homepage_hero_v1");
    expect(result.first_touch_at).toBe("2026-09-10T12:00:00.000Z");
    expect(result.first_touch_landing_page).toBe("/");
  });

  test("a first touch forwarded by the website is adopted over inventing one", () => {
    const result = resolveBrowserAttribution({
      href:
        "https://term.gloom.sh/?ticker=NVDA&_gloom=" +
        ANON +
        "&first_touch_at=2026-09-08T09:00:00.000Z&first_touch_landing_page=%2Fcloud&first_touch_referrer=https%3A%2F%2Ft.co%2Fabc&first_touch_utm_source=x&first_touch_twclid=click_9",
      now: NOW,
      referrer: "https://gloom.sh/cloud",
      stored: null,
    });
    expect(result).toEqual({
      first_touch_at: "2026-09-08T09:00:00.000Z",
      first_touch_landing_page: "/cloud",
      first_touch_referrer: "https://t.co/abc",
      first_touch_utm_source: "x",
      first_touch_twclid: "click_9",
    });
  });

  test("a forwarded first touch never overrides a fresh stored one", () => {
    const stored = resolveBrowserAttribution({
      href: "https://term.gloom.sh/",
      now: NOW - 2 * DAY,
      referrer: "https://news.ycombinator.com/",
      stored: null,
    });
    const result = resolveBrowserAttribution({
      href: "https://term.gloom.sh/?first_touch_at=2026-09-09T09:00:00.000Z&first_touch_landing_page=%2F&first_touch_referrer=https%3A%2F%2Ft.co%2Fabc",
      now: NOW,
      referrer: "https://gloom.sh/",
      stored: JSON.stringify(stored),
    });
    expect(result).toEqual(stored);
  });

  test("a stale, future, or malformed forwarded first touch is ignored", () => {
    for (const at of ["2026-07-01T00:00:00.000Z", "2026-09-11T00:00:00.000Z", "yesterday", ""]) {
      const result = resolveBrowserAttribution({
        href: `https://term.gloom.sh/?first_touch_at=${encodeURIComponent(at)}&first_touch_referrer=https%3A%2F%2Ft.co%2Fabc`,
        now: NOW,
        referrer: "",
        stored: null,
      });
      expect(result.first_touch_at).toBe("2026-09-10T12:00:00.000Z");
      expect(result.first_touch_referrer).toBeUndefined();
    }
  });

  test("a forwarded first touch a minute ahead of this clock is still fresh", () => {
    const result = resolveBrowserAttribution({
      href: "https://term.gloom.sh/?first_touch_at=2026-09-10T12:01:00.000Z&first_touch_landing_page=%2Fcloud",
      now: NOW,
      referrer: "",
      stored: null,
    });
    expect(result.first_touch_landing_page).toBe("/cloud");
  });

  test("corrupt storage and junk values are ignored", () => {
    const result = resolveBrowserAttribution({
      href: "https://term.gloom.sh/?utm_source=" + "x".repeat(400) + "&twclid=%20%20",
      now: NOW,
      referrer: "not a url",
      stored: "{not json",
    });
    expect(result.utm_source).toHaveLength(300);
    expect(result.twclid).toBeUndefined();
    expect(result.first_touch_referrer).toBeUndefined();
  });
});

describe("readStoredAttribution", () => {
  test("returns only touches inside their windows and never invents one", () => {
    expect(readStoredAttribution(null, NOW)).toEqual({});
    expect(
      readStoredAttribution(
        JSON.stringify({
          first_touch_at: new Date(NOW - 40 * DAY).toISOString(),
          first_touch_referrer: "https://t.co/old",
          last_touch_at: new Date(NOW - DAY).toISOString(),
          twclid: "click_recent",
        }),
        NOW,
      ),
    ).toEqual({
      last_touch_at: new Date(NOW - DAY).toISOString(),
      twclid: "click_recent",
    });
  });
});

describe("desktop handoff", () => {
  test("carriesHandoff recognises ids, campaigns, and first touches only", () => {
    expect(carriesHandoff("gloomberb://ticker/NVDA?tab=earnings-calls")).toBe(false);
    expect(carriesHandoff(`gloomberb://cloud/success?_gloom=${ANON}`)).toBe(true);
    expect(carriesHandoff("gloomberb://ticker/NVDA?utm_source=x")).toBe(true);
    expect(carriesHandoff("gloomberb://ticker/NVDA?first_touch_at=2026-09-10T11:00:00.000Z")).toBe(true);
    expect(carriesHandoff("not a url")).toBe(false);
  });

  test("a plain deep link leaves storage untouched", () => {
    const storage = memoryStorage();
    expect(adoptDesktopHandoff("gloomberb://ticker/NVDA?tab=chart", storage, NOW)).toBe(false);
    expect(storage.map.size).toBe(0);
  });

  test("a website link persists the visitor id and touches for later sign-in", () => {
    const storage = memoryStorage();
    const href =
      `gloomberb://cloud/success?_gloom=${ANON}` +
      "&utm_source=x&utm_campaign=c1&twclid=click_1" +
      "&first_touch_at=2026-09-08T09:00:00.000Z&first_touch_landing_page=%2F&first_touch_referrer=https%3A%2F%2Ft.co%2Fabc";
    expect(adoptDesktopHandoff(href, storage, NOW)).toBe(true);
    expect(storage.getItem("gloomberb.web.anonymous-id")).toBe(ANON);
    expect(JSON.parse(storage.getItem("gloomberb.web.attribution")!)).toEqual({
      first_touch_at: "2026-09-08T09:00:00.000Z",
      first_touch_landing_page: "/",
      first_touch_referrer: "https://t.co/abc",
      last_touch_at: "2026-09-10T12:00:00.000Z",
      utm_source: "x",
      utm_campaign: "c1",
      twclid: "click_1",
    });
  });

  test("a campaign-only link without a forwarded first touch records the link as the first touch", () => {
    const storage = memoryStorage();
    adoptDesktopHandoff("gloomberb://cloud/success?utm_source=x&twclid=click_1", storage, NOW);
    const saved = JSON.parse(storage.getItem("gloomberb.web.attribution")!);
    expect(saved.first_touch_landing_page).toBe("cloud/success");
    expect(saved.first_touch_twclid).toBe("click_1");
    expect(saved.first_touch_referrer).toBeUndefined();
  });

  test("observeDesktopDeepLinks inspects every link and still delivers it to the app", () => {
    const storage = memoryStorage();
    const listeners = new Set<(link: { url: string }) => void>();
    const pending = [{ url: `gloomberb://cloud/success?_gloom=${ANON}&utm_source=x` }];
    const bridge = {
      subscribe(listener: (link: { url: string }) => void) {
        listeners.add(listener);
        for (const link of pending.splice(0)) listener(link);
        return () => void listeners.delete(listener);
      },
    };
    const seen: string[] = [];
    const unsubscribe = observeDesktopDeepLinks(bridge, storage).subscribe((link) => seen.push(link.url));
    for (const listener of listeners) listener({ url: "gloomberb://ticker/NVDA" });
    expect(seen).toEqual([`gloomberb://cloud/success?_gloom=${ANON}&utm_source=x`, "gloomberb://ticker/NVDA"]);
    expect(storage.getItem("gloomberb.web.anonymous-id")).toBe(ANON);
    unsubscribe();
    expect(listeners.size).toBe(0);
  });
});

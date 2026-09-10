import { describe, expect, test } from "bun:test";
import { resolveBrowserAttribution } from "./research-activity";

const NOW = Date.parse("2026-09-10T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

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

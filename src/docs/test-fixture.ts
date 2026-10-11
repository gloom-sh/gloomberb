/**
 * A small docs index for tests, in the shape gloom.sh serves. Invented text:
 * the shipped snapshot is checked on its own in targets.test.ts.
 */
export const DOCS_FIXTURE_LESSON_URL = "/academy/company-and-price/charts/reading-a-price-chart";

export function docsFeedFixture(overrides: Record<string, unknown> = {}) {
  return {
    format: 1,
    site: "https://gloom.sh",
    updatedAt: "2099-01-01",
    categories: [
      { id: "research", title: "Research companies" },
      { id: "app", title: "Layouts and settings" },
    ],
    functions: [
      {
        code: "GP",
        name: "Price chart",
        description: "Candles with volume",
        detail: "Years of daily candles for one ticker, with volume under them. Read [the keys](/docs/layout-shortcuts) for drawing.",
        category: "research",
        arg: "AAPL",
        shot: "https://gloom.sh/screenshots/fn/GP.png",
        lesson: DOCS_FIXTURE_LESSON_URL,
      },
      {
        code: "OMON",
        name: "Options chain",
        description: "Calls and puts by strike",
        detail: "Every strike of one expiry with bid, ask and the greeks.",
        category: "research",
        arg: "NVDA",
        access: "pro",
      },
      {
        code: "DOCS",
        name: "Docs",
        description: "Read the docs in the app",
        detail: "These docs inside the app.",
        category: "app",
      },
    ],
    pages: [
      {
        slug: "getting-started",
        title: "Install Gloomberb",
        lead: "Install it and open your first pane.",
        category: "Start here",
        tags: ["install"],
        updatedAt: "2099-01-01",
        blocks: [
          { type: "heading", level: 2, text: "Desktop" },
          { type: "paragraph", text: "Download the app and open it. See the [account page](/cloud) for plans." },
          { type: "list", items: ["Open the command bar", "Type GP AAPL"] },
          { type: "unknown-block", text: "never drawn" },
        ],
      },
      {
        slug: "layout-shortcuts",
        title: "Keys and shortcuts",
        lead: "Default keys for panes and charts.",
        category: "Reference",
        tags: ["shortcuts", "GP"],
        blocks: [{ type: "table", headers: ["Key", "Action"], rows: [["`?`", "Open help"]] }],
      },
    ],
    lessons: [
      {
        url: DOCS_FIXTURE_LESSON_URL,
        title: "Reading a price chart (GP)",
        summary: "Candles, volume and ranges in one picture.",
        chapter: "One company and its price",
        minutes: 6,
      },
    ],
    ...overrides,
  };
}

export function docsLessonFixture() {
  return {
    format: 1,
    url: DOCS_FIXTURE_LESSON_URL,
    title: "Reading a price chart (GP)",
    summary: "Candles, volume and ranges in one picture.",
    chapter: "One company and its price",
    minutes: 6,
    blocks: [
      { type: "paragraph", text: "A candle shows where the day opened and closed." },
      { type: "details", summary: "Why candles and not lines", blocks: [{ type: "paragraph", text: "Hidden until opened." }] },
    ],
  };
}

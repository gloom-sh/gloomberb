import { afterEach, expect, spyOn, test } from "bun:test";
import { act, useCallback, useState } from "react";
import { createOpenTuiTestHarness } from "../../../renderers/opentui/test-utils";
import { appReducer, createInitialState, type AppAction, type AppState } from "../../../state/app/context";
import { TestPaneFrame, createTestPaneConfig } from "../../../test-support/pane";
import { createTestPluginRuntime } from "../../../test-support/plugin-runtime";
import { ChangelogPane, resetChangelogCacheForTests } from ".";

const PANE = "changelog:test";
const tui = createOpenTuiTestHarness();
let fetchSpy: { mockRestore(): void } | undefined;
afterEach(async () => {
  fetchSpy?.mockRestore();
  fetchSpy = undefined;
  await tui.destroy();
});

const release = (tag: string, name: string, publishedAt: string, body: string) => ({
  id: Number(tag.replace(/\D/g, "")),
  tag_name: tag,
  name,
  body,
  published_at: publishedAt,
  html_url: `https://github.com/gloom-sh/gloomberb/releases/tag/${tag}`,
});

/** Two versions, a nightly build among them. */
const RELEASES = [
  release("v0.20.1", "v0.20.1 - Responsive Windows app", "2026-11-04T09:00:00Z", "## Highlights\n\n- **The Windows app stays responsive.** Menus run off the main thread. (#2449)"),
  { ...release("v0.20.1-nightly.20261104.1.gabc1234", "Nightly", "2026-11-04T08:00:00Z", ""), prerelease: true },
  release("v0.20.0", "v0.20.0 - Faster desktop app", "2026-11-03T09:00:00Z", "## Highlights\n\n- **A faster, lighter desktop app.** It starts sooner. (#2443)"),
  release("v0.19.1", "v0.19.1 - Windows fixes", "2026-10-29T09:00:00Z", "- Plain bullet first: the details follow. (#2323)"),
  release("v0.19.0", "v0.19.0 - Options strategy screens", "2026-10-28T09:00:00Z", "## Highlights\n\n- **Screen option strategies.** `CSP` has a tab each. (#2256)"),
];

const SUMMARIES = [
  "# Changelog",
  "<!--",
  "## 0.21: An example in the format notes",
  "-->",
  "## 0.20: A faster desktop app, and a responsive one on Windows",
  "",
  "- **A faster, lighter desktop app.** It starts about a third faster. (0.20.0)",
  "- **The Windows app stays responsive.** Menus no longer freeze it. (0.20.1)",
].join("\n");

const reads: string[] = [];
function stubGithub() {
  resetChangelogCacheForTests();
  fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    reads.push(url);
    if (url === "https://api.github.com/repos/gloom-sh/gloomberb/contents/CHANGELOG.md") return new Response(SUMMARIES, { status: 200 });
    if (url.startsWith("https://api.github.com/repos/gloom-sh/gloomberb/releases")) return new Response(JSON.stringify(RELEASES), { status: 200 });
    return new Response("Not Found", { status: 404 });
  }) as typeof fetch);
}

async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await tui.setup().renderOnce();
    });
  }
}

async function render(params: Record<string, string> = {}, width = 100, height = 18): Promise<string> {
  const initial = createInitialState(createTestPaneConfig("/tmp/gloom-changelog-test", { instanceId: PANE, paneId: "changelog", binding: { kind: "none" }, params }));
  initial.focusedPaneId = PANE;
  function Harness() {
    // The selected and open rows are pane state, so moving them needs a reducer.
    const [state, setState] = useState<AppState>(initial);
    const dispatch = useCallback((action: AppAction) => setState((current) => appReducer(current, action)), []);
    return <TestPaneFrame state={state} dispatch={dispatch} paneId={PANE} pluginId="changelog" runtime={createTestPluginRuntime()} width={width} height={height} footerKeys>
      {(body) => <ChangelogPane paneId={PANE} paneType="changelog" focused {...body} />}
    </TestPaneFrame>;
  }
  await act(async () => { await tui.render(<Harness />, { width, height }); });
  await settle();
  return tui.frame();
}

async function press(key: "enter" | "escape" | "backspace" | string): Promise<string> {
  await act(async () => {
    const input = tui.setup().mockInput;
    if (key === "enter") input.pressEnter();
    else if (key === "backspace") input.pressBackspace();
    else if (key === "escape") {
      input.pressEscape();
      // A lone Esc is told apart from the start of a key sequence after a pause.
      await new Promise((resolve) => setTimeout(resolve, 60));
    } else input.pressKey(key);
  });
  await settle();
  return tui.frame();
}

const lines = (frame: string) => frame.split("\n");
const lineWith = (frame: string, text: string) => lines(frame).find((line) => line.includes(text));

test("lists one row per minor version, newest first: its newest update's date, its title and how many updates it had", async () => {
  stubGithub();
  const frame = await render();

  expect(lines(frame).find((line) => /DATE/.test(line))).toMatch(/DATE\b.*VERSION\s+TITLE\s+UPDATES/);
  expect(lineWith(frame, "v0.20")).toMatch(/Nov 4, 2026\s+v0\.20\s+A faster desktop app, and a responsive one on Windows\s+2/);
  // No summary for 0.19: its first update's title.
  expect(lineWith(frame, "v0.19")).toMatch(/Oct 29, 2026\s+v0\.19\s+Options strategy screens\s+2/);
  expect(frame.indexOf("v0.20")).toBeLessThan(frame.indexOf("v0.19"));
  expect(frame).not.toContain("nightly");
  expect(frame).not.toContain("example");
});

test("Enter opens a version's highlights over its updates, Enter an update's notes, and Back goes one level at a time", async () => {
  stubGithub();
  await render();

  const version = await press("enter");
  expect(version).toContain("v0.20 A faster desktop app, and a responsive one on Windows");
  expect(version).toContain("A faster, lighter desktop app. It starts about a third faster. (0.20.0)");
  expect(version).toContain("The Windows app stays responsive. Menus no longer freeze it. (0.20.1)");
  expect(lineWith(version, "v0.20.1")).toMatch(/Nov 4, 2026\s+v0\.20\.1\s+Responsive Windows app/);
  expect(lineWith(version, "v0.20.0")).toMatch(/Nov 3, 2026\s+v0\.20\.0\s+Faster desktop app/);

  const notes = await press("enter");
  expect(notes).toContain("v0.20.1 Responsive Windows app");
  expect(notes).toContain("Menus run off the main thread.");
  expect(notes).toMatch(/\[o\]pen/);

  const back = await press("escape");
  expect(back).toContain("v0.20 A faster desktop app");
  expect(back).not.toContain("Menus run off the main thread.");

  const root = await press("backspace");
  expect(root).toMatch(/DATE\b.*VERSION\s+TITLE\s+UPDATES/);
  expect(root).not.toContain("It starts about a third faster.");
});

test("a version without a summary shows each update's top claim, oldest first, and a plain bullet's first clause", async () => {
  stubGithub();
  await render();
  await press("j");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
  const version = await press("enter");

  expect(version).toContain("v0.19 Options strategy screens");
  expect(version).toMatch(/Screen option strategies\. \(0\.19\.0\)[\s\S]*Plain bullet first\. \(0\.19\.1\)/);
  expect(version).not.toContain("CSP");
});

test("what's new after an update opens that release's notes inside its version", async () => {
  stubGithub();
  const notes = await render({ version: "0.19.0" });
  expect(notes).toContain("v0.19.0 Options strategy screens");
  expect(notes).toContain("has a tab each.");

  const version = await press("escape");
  expect(version).toContain("v0.19 Options strategy screens");
  expect(lineWith(version, "v0.19.0")).toMatch(/Oct 28, 2026\s+v0\.19\.0/);
});

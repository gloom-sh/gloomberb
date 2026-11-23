/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, useState } from "react";
import { PaneFooterScope, usePaneFooter } from "../../../components/layout/pane/footer";
import { usePaneNoticeFooter } from "../../../components/use-pane-notice-footer";
import { UiHostProvider } from "../../../ui";
import { createDomUiHost } from "../../dom/dom-ui-host";
import { WebInputHostProvider } from "../../dom/input-host";
import { WebDialogHostProvider } from "../../dom/dialog-host";
import { createDomTestHarness } from "../../dom/test-utils";
import { middleEllipsis, PaneShotFrame } from "./cli-pane-shot-frame";
import { nativePaneFooterRows, nativePaneHeaderRows } from "../../../components/layout/pane/sizing";
import { noopRendererHost } from "../../../test-support/renderer-host";

const { render } = createDomTestHarness({ withUi: false });
function Source({ warning }: { warning: boolean }) {
  usePaneNoticeFooter({ registrationId: "shot-notice", notices: warning ? ["Source publication date unavailable."] : [], focused: true });
  usePaneFooter("shot-actions", () => ({
    info: [{ id: "loading", parts: [{ text: "Loading a normal source" }] }],
    hints: [{ id: "refresh", key: "r", label: "efresh", onPress() {} }],
  }), []);
  return <div>Research data</div>;
}

test("pane screenshots retain warnings, optionally preserve source status and reclaim empty footers", async () => {
  const ui = createDomUiHost();
  let update: (value: { warning: boolean; active: boolean; preserveStatus?: boolean }) => void = () => {};
  function Harness() {
    const [state, setState] = useState<{ warning: boolean; active: boolean; preserveStatus?: boolean }>({ warning: false, active: true });
    update = setState;
    return <UiHostProvider ui={ui} renderer={noopRendererHost}>
      <WebInputHostProvider><WebDialogHostProvider>
        <PaneShotFrame paneId="shot" title="Research" width={40} height={24} preserveStatus={state.preserveStatus}>
          {(frame) => <div data-body-height={frame.height}>
            <PaneFooterScope active={state.active}><Source warning={state.warning} /></PaneFooterScope>
          </div>}
        </PaneShotFrame>
      </WebDialogHostProvider></WebInputHostProvider>
    </UiHostProvider>;
  }
  const root = await render(<Harness />);
  const bodyHeight = () => Number(root.querySelector("[data-body-height]")?.getAttribute("data-body-height"));
  // 24 rows less the desktop header, and less the footer row when one shows.
  const withoutFooter = 24 - nativePaneHeaderRows();
  const withFooter = withoutFooter - nativePaneFooterRows();
  expect(root.textContent).toContain("Research data");
  expect(root.querySelector('[data-gloom-role="pane-footer"]')).toBeNull();
  expect(bodyHeight()).toBeCloseTo(withoutFooter);

  await act(async () => update({ warning: true, active: true }));
  expect(root.querySelector('button[aria-label="Data warnings"] svg')).toBeNull();
  expect(root.querySelector('[data-gloom-role="pane-footer-notes"]')).not.toBeNull();
  expect(root.textContent).toContain("Source publication date unavailable.");
  expect(root.textContent).not.toContain("Loading a normal source");
  expect(root.querySelector('[data-gloom-role="pane-hint"]')).toBeNull();

  await act(async () => update({ warning: true, active: false }));
  expect(root.querySelector('[data-gloom-role="pane-footer"]')).toBeNull();
  expect(bodyHeight()).toBeCloseTo(withoutFooter);

  await act(async () => update({ warning: true, active: true }));
  expect(root.textContent).toContain("Source publication date unavailable.");
  await act(async () => update({ warning: false, active: true }));
  expect(root.querySelector('[data-gloom-role="pane-footer"]')).toBeNull();
  expect(bodyHeight()).toBeCloseTo(withoutFooter);

  await act(async () => update({ warning: false, active: true, preserveStatus: true }));
  expect(root.textContent).toContain("Loading a normal source");
  expect(root.querySelector('[data-gloom-role="pane-hint"]')).toBeNull();
  expect(bodyHeight()).toBeCloseTo(withFooter);

  await act(async () => update({ warning: true, active: true, preserveStatus: true }));
  expect(root.textContent).toContain("Source publication date unavailable.");
  expect(root.textContent).toContain("Loading a normal source");
  expect(root.querySelector('button[aria-label="Data warnings"]')).toBeNull();
});

test("a status line replaces the pane's own text that says the same: its as-of for the pane's data, its quote date and delay for quotes", async () => {
  const ui = createDomUiHost();
  function Dated() {
    usePaneFooter("dated", () => ({
      info: [
        { id: "observed", asOf: true, parts: [{ text: "as of 2026-10-05" }] },
        // Worded as an as-of without saying so (the catalyst calendar's).
        { id: "generated", parts: [{ text: "as of 2026-10-18 21:25 UTC" }] },
        { id: "quotes", quoteStatus: true, parts: [{ text: "2026-10-09 · 15m delayed" }] },
        { id: "preview", parts: [{ text: "Pro preview", tone: "warning" }] },
      ],
    }), []);
    return <div>Hiring</div>;
  }
  const root = await render(<UiHostProvider ui={ui} renderer={noopRendererHost}>
    <WebInputHostProvider><WebDialogHostProvider>
      <PaneShotFrame paneId="shot" title="Hiring" width={60} height={24} preserveStatus statusLine>
        {() => <PaneFooterScope active><Dated /></PaneFooterScope>}
      </PaneShotFrame>
    </WebDialogHostProvider></WebInputHostProvider>
  </UiHostProvider>);
  const footer = () => root.querySelector('[data-gloom-role="pane-footer"]')?.textContent ?? "";
  expect(footer()).toContain("as of 2026-10-05");
  expect(footer()).toContain("as of 2026-10-18 21:25 UTC");
  expect(footer()).toContain("15m delayed");

  // A market line leaves the as-of alone: it dates the pane's data, not the quotes. The quotes' date and delay go.
  await act(async () => { await window.__GLOOM_CLI_SHOT_FIT_STATUS__?.(["Fri 9 Oct close · 15 min delayed"], { dates: "quotes" }); });
  expect(footer()).toContain("as of 2026-10-05");
  expect(footer()).toContain("as of 2026-10-18 21:25 UTC");
  expect(footer()).not.toContain("15m delayed");
  expect(footer()).toContain("Fri 9 Oct close");

  await act(async () => { await window.__GLOOM_CLI_SHOT_FIT_STATUS__?.(["Observed Mon 5 Oct · lag 5d"], { dates: "data" }); });
  expect(footer()).not.toContain("as of");
  expect(footer()).toContain("Pro preview");
  expect(footer()).toContain("Observed Mon 5 Oct · lag 5d");
});

test("a view that dates its data in its own footer keeps that footer beside the line (a DES research tab)", async () => {
  const ui = createDomUiHost();
  function Holdings() {
    usePaneFooter("holders", () => ({
      info: [
        { id: "as-of", parts: [{ text: "2026-06-30" }] },
        { id: "index-unread", capture: true, parts: [{ text: "holder index could not be read; short list from 11:22", tone: "warning" }] },
      ],
      hints: [{ id: "fund", key: "o", label: "pen 13F", onPress() {} }],
    }), []);
    return <div>Holders</div>;
  }
  const root = await render(<UiHostProvider ui={ui} renderer={noopRendererHost}>
    <WebInputHostProvider><WebDialogHostProvider>
      <PaneShotFrame paneId="shot" title="FUN" width={90} height={24} statusLine>
        {() => <PaneFooterScope active><Holdings /></PaneFooterScope>}
      </PaneShotFrame>
    </WebDialogHostProvider></WebInputHostProvider>
  </UiHostProvider>);
  const footer = () => root.querySelector('[data-gloom-role="pane-footer"]')?.textContent ?? "";
  // Before the line is known only what a picture of the rows cannot say is kept.
  expect(footer()).toContain("short list from 11:22");
  expect(footer()).not.toContain("2026-06-30");

  await act(async () => { await window.__GLOOM_CLI_SHOT_FIT_STATUS__?.(["Retrieved Mon 23 Nov 2026 11:22 UTC"], { dates: null, ownStatus: true }); });
  expect(footer()).toContain("2026-06-30");
  expect(footer()).toContain("short list from 11:22");
  expect(footer()).toContain("Retrieved Mon 23 Nov 2026 11:22 UTC");
  expect(root.querySelector('[data-gloom-role="pane-hint"]')).toBeNull();
});

test("a capture with nothing to date gives the footer row back to the pane", async () => {
  const ui = createDomUiHost();
  const root = await render(<UiHostProvider ui={ui} renderer={noopRendererHost}>
    <WebInputHostProvider><WebDialogHostProvider>
      <PaneShotFrame paneId="shot" title="Risk" width={40} height={24} statusLine>
        {(frame) => <div data-body-height={frame.height}>Sign in to read risk factors.</div>}
      </PaneShotFrame>
    </WebDialogHostProvider></WebInputHostProvider>
  </UiHostProvider>);
  const bodyHeight = () => Number(root.querySelector("[data-body-height]")?.getAttribute("data-body-height"));
  const withoutFooter = 24 - nativePaneHeaderRows();
  // The row is held from the first frame, while the line is still being worked out.
  expect(root.querySelector('[data-gloom-role="pane-footer"]')).not.toBeNull();
  expect(bodyHeight()).toBeCloseTo(withoutFooter - nativePaneFooterRows());

  await act(async () => { expect(await window.__GLOOM_CLI_SHOT_FIT_STATUS__?.([])).toBe(""); });
  expect(root.querySelector('[data-gloom-role="pane-footer"]')).toBeNull();
  expect(bodyHeight()).toBeCloseTo(withoutFooter);
});

test("a capture keeps the first caveat in full, with a count of remaining notes, separate from the pane's own state", async () => {
  const ui = createDomUiHost();
  const notes = ["Some jurisdictions have no awards in the dataset yet.", "Historical coverage has windows that are not complete yet.",
    "Some totals run past what one view can hold; narrow the date range or scope."];
  function Noted() {
    usePaneNoticeFooter({ registrationId: "noted", notices: notes, focused: true });
    return <div>Awards</div>;
  }
  const root = await render(<UiHostProvider ui={ui} renderer={noopRendererHost}>
    <WebInputHostProvider><WebDialogHostProvider>
      <PaneShotFrame paneId="shot" title="Awards" width={30} height={24}>
        {() => <PaneFooterScope active><Noted /></PaneFooterScope>}
      </PaneShotFrame>
    </WebDialogHostProvider></WebInputHostProvider>
  </UiHostProvider>);
  const line = root.querySelector('[data-gloom-role="pane-footer-notes"]');
  expect(line?.textContent).toBe(`${notes[0]} +2 more`);
  expect(line?.querySelector('[data-gloom-ui="prose"]')).not.toBeNull();
  expect(root.textContent).not.toContain(notes[1]!);
});

test("a status line too long for the row loses whole words from its middle, never part of one", () => {
  const line = "US trading day Mon 16 Nov 2026 close · 15 min delayed";
  expect(middleEllipsis(line, line.length)).toBe(line);
  expect(middleEllipsis(line, 36)).toBe("US trading day Mon … 15 min delayed");
  // Not a whole word fits at either end: the characters it has room for.
  expect(middleEllipsis("Supercalifragilistic", 8)).toBe("Supe…stic");
});

// MARS printed every left-out holding as a note while its footer already said what was left out.
test("a pane's capture notes stand in for its notices in a capture, and empty ones print none of them", async () => {
  const ui = createDomUiHost();
  let update: (captureNotes: readonly string[] | undefined) => void = () => {};
  function Notices({ captureNotes }: { captureNotes: readonly string[] | undefined }) {
    usePaneNoticeFooter({
      registrationId: "shot-notice", focused: true, captureNotes,
      notices: ["BTC-USD (17.5% of the book) is excluded from the risk estimate: crypto is not covered by the equity basket.", "Closes failed for GARAN."],
    });
    usePaneFooter("shot-coverage", () => ({ info: [{ id: "coverage", capture: true, parts: [{ text: "73% of book; BTC-USD left out" }] }] }), []);
    return <div>Risk rows</div>;
  }
  function Harness() {
    const [captureNotes, setCaptureNotes] = useState<readonly string[] | undefined>(["Closes failed for GARAN."]);
    update = setCaptureNotes;
    return <UiHostProvider ui={ui} renderer={noopRendererHost}>
      <WebInputHostProvider><WebDialogHostProvider>
        <PaneShotFrame paneId="shot" title="Risk" width={100} height={24}>{() => <Notices captureNotes={captureNotes} />}</PaneShotFrame>
      </WebDialogHostProvider></WebInputHostProvider>
    </UiHostProvider>;
  }
  const root = await render(<Harness />);
  const footer = () => root.querySelector('[data-gloom-role="pane-footer"]')?.textContent ?? "";
  const notes = () => root.querySelector('[data-gloom-role="pane-footer-notes"]')?.textContent ?? "";
  expect(notes()).toContain("Closes failed for GARAN.");
  expect(footer()).toContain("73% of book; BTC-USD left out");
  expect(notes()).not.toContain("is excluded from the risk estimate");
  await act(async () => update([]));
  expect(footer()).toContain("73% of book; BTC-USD left out");
  expect(notes()).toBe("");
  // Without them, the notices print as the note line, as for any pane.
  await act(async () => update(undefined));
  expect(notes()).toContain("BTC-USD (17.5% of the book) is excluded");
  expect(notes()).toContain("+1 more");
});

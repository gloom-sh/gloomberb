/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, useState } from "react";
import { PaneFooterScope, usePaneFooter } from "../../../components/layout/pane/footer";
import { usePaneNoticeFooter } from "../../../components/use-pane-notice-footer";
import { UiHostProvider, type RendererHost } from "../../../ui";
import { createDomUiHost } from "./dom-ui-host";
import { WebInputHostProvider } from "./input-host";
import { WebDialogHostProvider } from "./dialog-host";
import { createDomTestHarness } from "./test-utils";
import { PaneShotFrame } from "./cli-pane-shot-frame";

const { render } = createDomTestHarness({ withUi: false });
const renderer: RendererHost = {
  requestExit() {}, async openExternal() {}, async copyText() {},
  async readText() { return ""; }, notify() {},
};

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
    return <UiHostProvider ui={ui} renderer={renderer}>
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
  const bodyHeight = () => root.querySelector("[data-body-height]")?.getAttribute("data-body-height");
  expect(root.textContent).toContain("Research data");
  expect(root.querySelector('[data-gloom-role="pane-footer"]')).toBeNull();
  expect(bodyHeight()).toBe("23");

  await act(async () => update({ warning: true, active: true }));
  expect(root.querySelector('button[aria-label="Data warnings"] svg')).not.toBeNull();
  expect(root.querySelector('[data-gloom-role="pane-footer"]')).not.toBeNull();
  expect(root.textContent).not.toContain("Source publication date unavailable.");
  expect(root.textContent).not.toContain("Loading a normal source");
  expect(root.querySelector('[data-gloom-role="pane-hint"]')).toBeNull();
  expect(bodyHeight()).toBe("22");

  await act(async () => update({ warning: true, active: false }));
  expect(root.querySelector('[data-gloom-role="pane-footer"]')).toBeNull();
  expect(bodyHeight()).toBe("23");

  await act(async () => update({ warning: true, active: true }));
  expect(root.querySelector('button[aria-label="Data warnings"]')).not.toBeNull();
  await act(async () => update({ warning: false, active: true }));
  expect(root.querySelector('[data-gloom-role="pane-footer"]')).toBeNull();
  expect(bodyHeight()).toBe("23");

  await act(async () => update({ warning: false, active: true, preserveStatus: true }));
  expect(root.textContent).toContain("Loading a normal source");
  expect(root.querySelector('[data-gloom-role="pane-hint"]')).toBeNull();
  expect(bodyHeight()).toBe("22");
});

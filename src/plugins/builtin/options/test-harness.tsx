import { act } from "react";
import { PaneFooterBar, PaneFooterKeys, PaneFooterProvider, type CombinedPaneFooter } from "../../../components/layout/pane/footer";
import { takeSavedTextFile, type testRender } from "../../../renderers/opentui/test-utils";
import { exportPaneTable } from "../../../state/pane-table-export-registry";
import { Box } from "../../../ui";
import { OptionsView } from "./view";

type Setup = Awaited<ReturnType<typeof testRender>>;

/** OptionsView above its footer bar. With `footerKeysPaneId` the pane's footer key handlers are live too. */
export function OptionsFrame({ width, height, footerKeysPaneId, onFooter }: {
  width: number;
  height: number;
  footerKeysPaneId?: string;
  onFooter?: (footer: CombinedPaneFooter) => void;
}) {
  return (
    <PaneFooterProvider>
      {(footer) => {
        onFooter?.(footer);
        return (
          <Box width={width} height={height} flexDirection="column">
            <Box width={width} height={height - 1}><OptionsView width={width} height={height - 1} focused /></Box>
            <PaneFooterBar footer={footer} focused width={width} />
            {footerKeysPaneId ? <PaneFooterKeys paneId={footerKeysPaneId} footer={footer} focused /> : null}
          </Box>
        );
      }}
    </PaneFooterProvider>
  );
}

/**
 * Settle, key and capture helpers for an OptionsView render. `keyHoldMs` waits
 * after each key, for suites whose assertions follow the throttled cursor.
 */
export function createOptionsControls(getSetup: () => Setup, { keyHoldMs = 0 }: { keyHoldMs?: number } = {}) {
  async function settle() {
    for (let i = 0; i < 4; i += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        await getSetup().renderOnce();
      });
    }
  }

  async function key(name: string) {
    const input = getSetup().mockInput;
    await act(async () => {
      if (name === "enter") input.pressEnter();
      else if (name === "down" || name === "up" || name === "left" || name === "right") input.pressArrow(name);
      else input.pressKey(name);
    });
    if (keyHoldMs > 0) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, keyHoldMs));
      });
    }
    await settle();
  }

  /** Press c to launch the calculator, then read what it launched, the table's CSV export and the frame. */
  async function capture<T>(paneId: string, filename: string, launches: readonly T[]) {
    const count = launches.length;
    await key("c");
    await exportPaneTable(paneId, filename);
    const csv = takeSavedTextFile()?.text ?? "";
    const frame = getSetup().captureCharFrame();
    return { launch: launches.length > count ? launches.at(-1) : undefined, csv, frame };
  }

  return { settle, key, capture };
}

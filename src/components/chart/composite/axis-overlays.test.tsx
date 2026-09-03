import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import {
  UiHostProvider,
  type RendererHost,
  type UiHost,
} from "../../../ui";
import { WebBox } from "../../../renderers/electrobun/view/host/box";
import { WebText } from "../../../renderers/electrobun/view/host/text";
import { StaticXAxisLabels } from "./axis-overlays";

const renderer: RendererHost = {
  requestExit() {},
  async openExternal() {},
  async copyText() {},
  async readText() {
    return "";
  },
  notify() {},
};

function renderAxis(kind: "opentui" | "desktop-web"): string {
  const ui = {
    kind,
    capabilities: {
      cellWidthPx: 8,
      fractionalViewport: kind === "desktop-web",
    },
    Box: WebBox,
    Text: WebText,
  } as unknown as UiHost;
  const fallback = "Nov 3 2025                    Mar                    Jul 29 2026";
  return renderToStaticMarkup(
    <UiHostProvider ui={ui} renderer={renderer}>
      <StaticXAxisLabels
        labels={[fallback]}
        positionedLabels={[
          { label: "Nov 3 2025", ratio: 0 },
          { label: "Mar", ratio: 0.5 },
          { label: "Jul 29 2026", ratio: 1 },
        ]}
        width={80}
      />
    </UiHostProvider>,
  );
}

describe("StaticXAxisLabels", () => {
  test("positions desktop labels by chart ratio instead of font-space advances", () => {
    const html = renderAxis("desktop-web");

    expect(html).toContain('data-gloom-role="chart-time-axis"');
    expect(html).toContain('data-gloom-label="Nov 3 2025 Mar Jul 29 2026"');
    expect(html).toContain("left:50%");
    expect(html).toContain("transform:translateX(-50%)");
    expect(html).toContain("right:0");
    expect(html).not.toContain("Nov 3 2025                    Mar");
  });

  test("keeps the fixed-width axis string for terminal cells", () => {
    const html = renderAxis("opentui");

    expect(html).toContain("Nov 3 2025                    Mar");
    expect(html).not.toContain("left:50%");
  });
});

/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act } from "react";
import { createDomTestHarness } from "../../../renderers/dom/test-utils";
import { createDomUiHost } from "../../../renderers/dom/dom-ui-host";
import { InputHostProvider } from "../../../react/input";
import { UiHostProvider } from "../../../ui";
import { noopRendererHost } from "../../../test-support/renderer-host";
import { SupplyGraph } from "./graph";
import { graphPayload } from "./test-fixture-graph";

const { render } = createDomTestHarness({ withUi: false });
test("desktop graph keeps real SVG connections, dims lower confidence and mouse-recenters private identities", async () => {
  const data = graphPayload(), centered: string[] = [], visible: string[][] = [];
  data.links[1]!.confidence = .3;
  const container = await render(<UiHostProvider ui={createDomUiHost("linux")} renderer={noopRendererHost}>
    <InputHostProvider host={{ useShortcut() {}, useViewport: () => ({ width: 120, height: 24 }) }}>
      <SupplyGraph data={data} width={120} height={24} focused={false} selectedId={null} selectedPath={null} collapsed={[]} onSelect={() => {}} onRecenter={entity => centered.push(entity.id)} onVisible={ids => visible.push(ids)} />
    </InputHostProvider>
  </UiHostProvider>);
  const links = [...container.querySelectorAll("svg polyline")];
  expect(links).toHaveLength(2);
  expect(links[0]!.getAttribute("stroke")).not.toBe(links[1]!.getAttribute("stroke"));
  expect(container.textContent).not.toMatch(/[\u2800-\u28ff]/);
  const privateNode = [...container.querySelectorAll("button")].find(button => button.getAttribute("aria-label") === "Private supplier")!;
  await act(async () => privateNode.click());
  expect(centered).toEqual(["2"]);
  expect(visible.at(-1)).toEqual(["a", "b"]);
});

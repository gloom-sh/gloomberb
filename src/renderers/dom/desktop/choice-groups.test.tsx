/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, useState } from "react";
import { QueryBar } from "../../../components/ui/query-bar";
import { SelectField } from "../../../components/ui/select-field";
import { noopRendererHost } from "../../../test-support/renderer-host";
import { UiHostProvider } from "../../../ui";
import { createDomUiHost } from "../dom-ui-host";
import { WebInputHostProvider } from "../input-host";
import { createDomTestHarness } from "../test-utils";

const { render } = createDomTestHarness({ withUi: false });
const options = [
  { value: "all", label: "All" },
  { value: "disabled", label: "Unavailable", group: "Sectors", disabled: true },
  { value: "technology", label: "Technology", group: "Sectors" },
  ...Array.from({ length: 14 }, (_, index) => ({ value: `industry-${index}`, label: `Industry ${index}`, group: "Industries" })),
];

test.each(["field", "query"] as const)("%s menus skip group headings and disabled choices with mouse and keyboard", async (kind) => {
  const chosen: string[] = [];
  function Control() {
    const [value, setValue] = useState("all");
    const onChange = (next: string) => { chosen.push(next); setValue(next); };
    return kind === "field"
      ? <SelectField label="Names" value={value} options={options} onChange={onChange} />
      : <QueryBar width={80} filters={[{ id: "names", label: "Names", value, options, onChange }]} />;
  }
  const container = await render(
    <UiHostProvider ui={createDomUiHost("linux")} renderer={noopRendererHost}>
      <WebInputHostProvider><Control /></WebInputHostProvider>
    </UiHostProvider>,
  );
  const trigger = container.querySelector<HTMLButtonElement>("button[aria-haspopup=listbox]")!;
  await act(async () => { trigger.click(); });
  const headings = [...document.querySelectorAll<HTMLElement>(".gloom-menu-title")];
  expect(headings.map((heading) => heading.textContent)).toEqual(["Sectors", "Industries"]);
  await act(async () => { headings[0]!.click(); });
  expect(chosen).toEqual([]);
  expect(trigger.getAttribute("aria-expanded")).toBe("true");

  async function key(name: string) {
    await act(async () => { document.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true })); });
  }
  await key("ArrowDown");
  expect(document.querySelector("[data-highlighted=true]")?.textContent).toBe("Technology");
  await key("ArrowDown");
  expect(document.querySelector("[data-highlighted=true]")?.textContent).toBe("Industry 0");
  await key("End");
  await key("Enter");
  expect(chosen).toEqual(["industry-13"]);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");

  await act(async () => { trigger.click(); });
  expect(document.querySelector("[data-highlighted=true]")?.textContent).toBe("Industry 13");
  await act(async () => { document.querySelector<HTMLElement>("[role=option]")!.click(); });
  expect(chosen).toEqual(["industry-13", "all"]);
});

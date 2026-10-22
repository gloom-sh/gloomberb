import { expect, test } from "bun:test";
import { createDomTestHarness } from "../../renderers/dom/test-utils";
import { flagRegion, withCountryFlag } from "./country-flag";
import { KeyValueRow } from "./display";

const { render } = createDomTestHarness();

test("a country resolves to its flag by code, alpha-3 code, alias or English name, and nothing else does", () => {
  const cases: Array<[string | null | undefined, string | null]> = [
    ["GB", "GB"], ["gbr", "GB"], ["UK", "GB"], ["United Kingdom", "GB"], [" Japan ", "JP"],
    ["Korea", "KR"], ["South Korea", "KR"], ["Hong Kong", "HK"], ["Türkiye", "TR"],
    ["Ivory Coast", "CI"], ["Côte d’Ivoire", "CI"], ["Dominican Republic", "DO"],
    ["EU", "EU"], ["EA", "EU"], ["Euro area", "EU"], ["European Union", "EU"],
    // A code with no art, a region, a city, several countries and nothing at all.
    ["XK", null], ["Asia", null], ["Paris", null], ["US, CA", null], ["", null], [null, null], [undefined, null],
  ];
  for (const [value, region] of cases) expect([value, flagRegion(value)]).toEqual([value, region]);
});

test("the terminal's cell is untouched; the desktop's leads with the flag, or its blank room when there is none", async () => {
  const cell = { text: "Atlantis", color: "#fff" };
  expect(withCountryFlag(cell, "GB", false)).toBe(cell);
  const container = await render(<>
    {withCountryFlag({ text: "GB" }, "GB", true).leading}
    {withCountryFlag(cell, "Atlantis", true).leading}
    <KeyValueRow label="Country" value="France" country="France" />
    <KeyValueRow label="Country" value="Atlantis" country="Atlantis" />
  </>);
  const regions = [...container.querySelectorAll('[data-gloom-role="country-flag"]')].map((flag) => flag.getAttribute("data-region"));
  expect(regions).toEqual(["GB", "FR"]);
  expect(container.querySelectorAll('[data-gloom-role="country-flag-room"]').length).toBe(1);
  expect(container.querySelectorAll('[data-gloom-role="country-flag"][aria-hidden="true"]').length).toBe(2);
});

import { describe, expect, test } from "bun:test";
import { act } from "react";
import { createDomTestHarness } from "../renderers/dom/test-utils";
import { colors } from "../theme/colors";
import { CompanyLogoMark, withCompanyLogo } from "./company-logo";
import type { DataTableCell } from "./ui/data-table";

const { render, window } = createDomTestHarness();

const tile = (container: HTMLElement) => container.querySelector("[data-gloom-role=logo-mark]") as HTMLElement;

describe("company logos in table cells", () => {
  test("the terminal keeps the cell as it was; the desktop leads it with the company's or the coin's logo", async () => {
    const cell: DataTableCell = { text: "NVIDIA Corporation", color: colors.text };
    expect(withCompanyLogo(cell, { symbol: "NVDA" }, false)).toBe(cell);
    expect(withCompanyLogo(cell, null, true)).toBe(cell);

    const company = await render(withCompanyLogo(cell, { symbol: "NVDA" }, true).leading);
    expect(company.querySelector("img")?.getAttribute("src")).toMatch(/\/cloud\/logos\/ticker\/NVDA$/);
    const coin = await render(withCompanyLogo({ text: "Bitcoin" }, { symbol: "BTC", assetCategory: "CRYPTO" }, true).leading);
    expect(coin.querySelector("img")?.getAttribute("src")).toMatch(/\/cloud\/logos\/crypto\/BTC$/);
  });

  test("a logo that fails falls back to the name's initial on the same tile, at once when the row comes back", async () => {
    const first = await render(<CompanyLogoMark symbol="ZZQX" name="Zeta Quux Holdings" />);
    const box = tile(first);
    const size = { width: box.style.width, height: box.style.height };
    expect(size.width).toBe(size.height);
    await act(async () => {
      first.querySelector("img")!.dispatchEvent(new window.Event("error") as unknown as Event);
    });
    expect(first.querySelector("img")).toBeNull();
    expect(tile(first).textContent).toBe("Z");
    expect({ width: tile(first).style.width, height: tile(first).style.height }).toEqual(size);

    // Scrolled away and back: the row draws the initial without asking for the logo again.
    const again = await render(<CompanyLogoMark symbol="ZZQX" name="Zeta Quux Holdings" />);
    expect(again.querySelector("img")).toBeNull();
    expect(tile(again).textContent).toBe("Z");
  });
});

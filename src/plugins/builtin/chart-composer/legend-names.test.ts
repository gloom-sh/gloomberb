import { expect, test } from "bun:test";
import { companyLegendLabels } from "./legend-names";

// CMP of GUBRF.IS, BAGFS.IS, NTR and CF read "CF CF Industries Holdings" in its legend.
test("a company whose name starts with its ticker is named once in the legend; any other gets its ticker and name", () => {
  expect(companyLegendLabels("CF", "CF", "CF Industries", true)).toEqual({ label: "CF Industries", compactLabel: "CF Industries" });
  // A labelled series keeps its label, and the fallback still names the ticker once.
  expect(companyLegendLabels("CF Price", "CF", "CF Industries", true)).toEqual({ label: "CF Price · CF Industries", compactLabel: "CF Industries" });
  expect(companyLegendLabels("NTR", "NTR", "Nutrien", true)).toEqual({ label: "NTR · Nutrien", compactLabel: "NTR Nutrien" });
  // A name that only starts with the ticker's letters is another word: CF beside "CFG Bank".
  expect(companyLegendLabels("CF", "CF", "CFG Bank", true)).toEqual({ label: "CF · CFG Bank", compactLabel: "CF CFG Bank" });
  // A company charted in several series has no fallback of its own.
  expect(companyLegendLabels("CF", "CF", "CF Industries", false)).toEqual({ label: "CF Industries" });
});

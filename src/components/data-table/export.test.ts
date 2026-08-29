import { expect, test } from "bun:test";
import { EXCEL_CSV_BOM } from "../../utils/csv";
import { createDataTableCsv } from "./export";

test("exports displayed table cells and skips section headers", () => {
  const items = [
    { type: "section", name: "Americas", value: "" },
    { type: "row", name: "S&P 500", value: "+1.25%" },
  ];
  const csv = createDataTableCsv({
    columns: [
      { id: "name", label: "Name", width: 20, align: "left" },
      { id: "value", label: "Change", width: 10, align: "right" },
    ],
    items,
    renderSectionHeader: (item) => item.type === "section" ? { text: item.name } : null,
    renderCell: (item, column) => ({ text: item[column.id as "name" | "value"] }),
  });

  expect(csv).toBe(`${EXCEL_CSV_BOM}Name,Change\nS&P 500,'+1.25%`);
});

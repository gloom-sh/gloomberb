import { test } from "bun:test";
import { createDataTableCsv } from "./src/components/data-table/export";
import { serializeCsv } from "./src/utils/csv";

function run(label: string, texts: string[], align: "left" | "right" = "right") {
  const csv = createDataTableCsv({
    columns: [{ id: "a", label, width: 10, align }],
    items: texts,
    renderCell: (item: string) => ({ text: item }),
  });
  console.log(JSON.stringify(texts), "=>", JSON.stringify(csv.slice(1).split("\n")));
}

test("scratch", () => {
  run("Tenor", ["1M", "3M", "6M"]);
  run("Term", ["1M", "3M", "12M"]);
  run("Year", ["2026", "2027"]);
  run("Px", ["$1,234.50", "-$2.00", "$-3.00"]);
  run("Cap", ["0.5M", "1.23456B", "999"]);
  run("Chg", ["+0.00%", "-0.00%", "0.00%"]);
  run("Spd", ["  12.5 bp", "3bps", "-4bp ↑"]);
  run("Ratio", ["N/A", "1.2x"]);
  run("Weird", ["1e5", "-1e5"]);
  run("Pad", ["      466.8       ", "  -0.32  "]);
  run("PadMixed", ["   466.8  +6.4%", "  -0.32  -219%"]);
  run("Name", ["  =HYPERLINK(\"x\")", "-", "--", "…"], "left");
  run("Dot", ["●", "○"]);
  run("Big", ["12345678901234567890", "1.5T"]);
  run("Ccy", ["HK$12.00", "US$1.00"]);
  run("Ccy2", ["12.00 USD", "3.50 USD"]);
  run("Frac", [".5", "0.25"]);
  run("Neg0", ["-0", "+0"]);
  console.log(serializeCsv([["+1", "-1%", "+1,234", "-1.5e+3", "+.5", "-.5%", "- 1", "+ 1"]], { excelCompatible: true }));
});

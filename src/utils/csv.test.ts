import { describe, expect, test } from "bun:test";
import { EXCEL_CSV_BOM, csvDecimal, serializeCsv, setCsvDecimal } from "./csv";
import { renderReportCsv } from "../cli/report-tables";

describe("serializeCsv", () => {
  test("escapes cells and can emit an Excel UTF-8 BOM", () => {
    const csv = serializeCsv([
      ["Name", "Note", "Value"],
      ["ACME, Inc.", "said \"hello\"\nagain", "=1+1"],
    ], { excelCompatible: true });

    expect(csv).toBe(`${EXCEL_CSV_BOM}Name,Note,Value\n"ACME, Inc.","said ""hello""\nagain",'=1+1`);
  });

  test("guards formulas but leaves signed numbers as numbers", () => {
    const csv = serializeCsv([
      [-2.1, "-2.10", "+3.45%", "-1,234.5", "1e-7", " -4"],
      ["-2+3+cmd|' /C calc'!A0", "+cmd", "@SUM(A1)", "\t=1", "\r=1", "  =HYPERLINK(\"x\")"],
      ["-", "--", "-Infinity", "+", "+-1"],
    ], { excelCompatible: true });

    expect(csv.slice(1).split("\n")).toEqual([
      "-2.1,-2.10,+3.45%,\"-1,234.5\",1e-7, -4",
      "'-2+3+cmd|' /C calc'!A0,'+cmd,'@SUM(A1),'\t=1,\"'\r=1\",\"'  =HYPERLINK(\"\"x\"\")\"",
      "'-,'--,'-Infinity,'+,'+-1",
    ]);
  });

  test("plain CSV is not guarded", () => {
    expect(serializeCsv([["=1+1", -2, new Date(Date.UTC(2026, 8, 25)), new Date(NaN)]]))
      .toBe("=1+1,-2,2026-09-25T00:00:00.000Z,");
  });

  test("a decimal comma writes numbers as a decimal-comma spreadsheet reads them, cells split by ;, text and dates as they are", () => {
    // RV's Visa row: pasted into a German spreadsheet, 17.2 read as 17 February and 24.8 as 24 August.
    const rows = [["Ticker", "Name", "Last", "Chg%", "EV/S", "Note", "as_of"],
      ["V", "Visa, Inc.", 425.76, "+1.30%", 17.2038710209, "a;b", "2026-11-14T00:56:24.504Z"],
      ["MCO", "1,234.5", -0.0681134911687, "-", 1e-7, "FY28", "2026-11-13"]];
    expect(serializeCsv(rows, { decimal: "comma" }).split("\n")).toEqual([
      "Ticker;Name;Last;Chg%;EV/S;Note;as_of",
      "V;Visa, Inc.;425,76;+1,30%;17,2038710209;\"a;b\";2026-11-14T00:56:24.504Z",
      "MCO;1234,5;-0,0681134911687;-;1e-7;FY28;2026-11-13",
    ]);
    // The setting is every export's default, a report's tables and closing lines included; a dot is as before.
    setCsvDecimal("comma");
    try {
      expect(csvDecimal()).toBe("comma");
      const csv = renderReportCsv({ tables: [{ title: "FA", columns: ["Metric", "FY2026"], rows: [["ROIC (%)", 38.7951]] }], footer: ["Source: Gloom Cloud"] });
      expect(csv).toBe("Metric;FY2026\nROIC (%);38,7951\n\n# Source: Gloom Cloud");
    } finally {
      setCsvDecimal(null);
    }
    expect(serializeCsv([[17.2, "a,b"]])).toBe('17.2,"a,b"');
  });
});

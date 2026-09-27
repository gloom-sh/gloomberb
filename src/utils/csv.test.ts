import { describe, expect, test } from "bun:test";
import { EXCEL_CSV_BOM, serializeCsv } from "./csv";

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
});

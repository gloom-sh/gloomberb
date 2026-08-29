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
});

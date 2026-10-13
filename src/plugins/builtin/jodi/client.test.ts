import { describe, expect, test } from "bun:test";
import { parseJodiCsv } from "./client";

const HEADER = "REF_AREA,TIME_PERIOD,ENERGY_PRODUCT,FLOW_BREAKDOWN,UNIT_MEASURE,OBS_VALUE,ASSESSMENT_CODE";

describe("parseJodiCsv", () => {
  test("keeps the latest crude month for the tracked countries", () => {
    const board = parseJodiCsv([
      HEADER,
      "US,2024-01,CRUDEOIL,INDPROD,KBD,100.5,1",
      "US,2024-02,CRUDEOIL,INDPROD,KBD,110.25,1",
      "US,2024-02,CRUDEOIL,INDPROD,KBBL,99999,1",
      "US,2024-02,CRUDEOIL,TOTDEMO,KBD,77,1",
      "US,2024-02,CRUDEOIL,TOTIMPSB,KBD,50,1",
      "US,2024-02,CRUDEOIL,TOTEXPSB,KBD,40,1",
      "US,2024-02,CRUDEOIL,CLOSTLV,KBD,x,3",
      "US,2024-02,CRUDEOIL,CLOSTLV,KBBL,900.5,1",
      "US,2024-02,CRUDEOIL,DIRECUSE,KBD,N/A,3",
      "US,2024-02,NGL,INDPROD,KBD,999,1",
      "US,2024-03,CRUDEOIL,INDPROD,KBD,-,3",
      "CN,2024-02,CRUDEOIL,INDPROD,KBD,80,1",
      "RU,2024-01,CRUDEOIL,INDPROD,KBD,300,1",
      "FR,2024-02,CRUDEOIL,INDPROD,KBD,12,1",
      "XX,2024-04,CRUDEOIL,INDPROD,KBD,1,1",
    ].join("\n"));

    expect(board.commodity).toBe("oil");
    expect(board.month).toBe("2024-02");
    expect(board.rows.map((row) => row.country)).toEqual([
      "United States", "China", "Saudi Arabia", "Russia", "India",
      "Japan", "Germany", "United Kingdom", "Brazil", "Korea",
    ]);
    expect(board.rows[0]).toEqual({
      country: "United States",
      production: 110.25,
      demand: 77,
      imports: 50,
      exports: 40,
      stocks: 900.5,
      unit: "kb/d, kbbl",
    });
    expect(board.rows[1]).toMatchObject({ country: "China", production: 80, demand: null, stocks: null });
    expect(board.rows.find((row) => row.country === "Russia")).toMatchObject({ production: null, imports: null });
  });

  test("reads natural gas demand in million cubic metres", () => {
    const board = parseJodiCsv([
      HEADER,
      "JP,2025-06,NATGAS,INDPROD,M3,10,1",
      "JP,2025-07,NATGAS,INDPROD,TJ,99999,1",
      "JP,2025-07,NATGAS,INDPROD,M3,134,1",
      "JP,2025-07,NATGAS,TOTDEMO,M3,7346,1",
      "JP,2025-07,NATGAS,TOTIMPSB,M3,6726,1",
      "JP,2025-07,NATGAS,TOTEXPSB,M3,0,1",
      "JP,2025-07,NATGAS,CLOSTLV,M3,6706,1",
      "US,2025-07,NATGAS,INDPROD,M3,96318,1",
    ].join("\r\n"));

    expect(board).toMatchObject({ month: "2025-07", commodity: "gas" });
    expect(board.rows.find((row) => row.country === "Japan")).toEqual({
      country: "Japan",
      production: 134,
      demand: 7346,
      imports: 6726,
      exports: 0,
      stocks: 6706,
      unit: "million m3",
    });
    expect(board.rows[0]).toMatchObject({ country: "United States", production: 96318, unit: "million m3" });
  });

  test("rejects a file that is not a balance table", () => {
    expect(() => parseJodiCsv("")).toThrow("The file is empty.");
    expect(() => parseJodiCsv("not,a,balance")).toThrow("The file is not a monthly balance table.");
    expect(() => parseJodiCsv(`${HEADER}\n`)).toThrow("The file has no balance rows.");
    expect(() => parseJodiCsv([
      HEADER,
      "US,2024-02,CRUDEOIL,INDPROD,KBD,1,1",
      "US,2024-02,NATGAS,INDPROD,M3,1,1",
    ].join("\n"))).toThrow("The file mixes oil and gas balances.");
  });
});

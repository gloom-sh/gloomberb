import { describe, expect, test } from "bun:test";
import { colors } from "../../../theme/colors";
import type { EarningsEvent } from "../../../types/data-provider";
import { buildEarningsColumns, renderEarningsCell, type EarningsColumn } from "./table";

function event(values: Partial<EarningsEvent> = {}): EarningsEvent {
  return {
    symbol: "TEST", name: "Controlled estimate", earningsDate: new Date("2026-09-12T00:00:00Z"),
    epsEstimate: 4, epsActual: null, revenueEstimate: null, revenueActual: null,
    surprise: null, timing: "", ...values,
  };
}

function cell(id: EarningsColumn["id"], values: Partial<EarningsEvent>) {
  return renderEarningsCell({ kind: "event", key: "test", eventIdx: 0, event: event(values) },
    buildEarningsColumns(180).find((column) => column.id === id)!, false);
}

describe("earnings estimate comparison basis", () => {
  test("30-day changes do not substitute 7-day observations", () => {
    expect(cell("epsTrend", { epsTrend7dAgo: 3, epsTrend30dAgo: null }).text).toBe("—");
    expect(cell("epsTrend", { epsTrend7dAgo: 3, epsTrend30dAgo: 2 }).text).toBe("2.00");
    expect(cell("epsTrend", { epsEstimate: 0, epsTrend30dAgo: 2 }).text).toBe("-2.00");
    expect(cell("epsTrend", { epsEstimate: null, epsTrend30dAgo: 2 }).text).toBe("—");
  });

  test("revision counts preserve one horizon and distinguish unknown from zero", () => {
    const partial = cell("epsRevisions", {
      epsRevisionUp30d: 3, epsRevisionDown30d: null, epsRevisionDown7d: 2,
    });
    expect(partial.text).toBe("3/—");
    expect(partial.color).toBe(colors.textDim);
    expect(cell("epsRevisions", { epsRevisionUp7d: 3, epsRevisionDown7d: 2 }).text).toBe("—");
    expect(cell("epsRevisions", { epsRevisionUp30d: null, epsRevisionDown30d: 0 }).text).toBe("—/0");
    expect(cell("epsRevisions", { epsRevisionUp30d: 0, epsRevisionDown30d: 0 }).text).toBe("0/0");
    expect(cell("epsRevisions", { epsRevisionUp30d: 3, epsRevisionDown30d: 0 }).color).toBe(colors.positive);
    expect(cell("epsRevisions", { epsRevisionUp30d: 0, epsRevisionDown30d: 3 }).color).toBe(colors.negative);
  });

  test("calendar dates agree with UTC grouping across time zones and year boundaries", () => {
    const modulePath = new URL("./table.ts", import.meta.url).pathname;
    const script = `import { buildEarningsColumns, renderEarningsCell } from ${JSON.stringify(modulePath)};
      const column = buildEarningsColumns(180).find(c => c.id === 'date');
      const dates = ['2026-09-12T00:00:00Z', '2026-12-31T23:00:00Z'];
      console.log(JSON.stringify(dates.map(date => renderEarningsCell({kind:'event', event:{earningsDate:new Date(date)}},column,false).text)));`;
    for (const timezone of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati"]) {
      const result = Bun.spawnSync([process.execPath, "-e", script], { env: { ...process.env, TZ: timezone } });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual(["Sep 12", "Dec 31"]);
    }
  });
});

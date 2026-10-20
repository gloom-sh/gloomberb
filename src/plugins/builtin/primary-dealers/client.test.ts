import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { cachedDealerHistory, fetchPrimaryDealers, loadDealerHistory, resetPrimaryDealersCache } from "./client";

const BREAKS = { pd: { seriesbreaks: [
  { label: "JAN 2022 TO JUN 2024", seriesbreak: "SBN2022", startdate: "2022-01-05", enddate: "2024-07-02" },
  { label: "JUL 2024 AND ON", seriesbreak: "SBN2024", startdate: "2024-07-03", enddate: "9999-12-31" },
] } };

const row = (keyid: string, value: string, asofdate = "2026-10-07") => ({ asofdate, keyid, value });

/** The newest figures of the series the board reads, as the release serves them, `*` where it suppresses one. */
const LATEST = { pd: { timeseries: [
  row("PDPOSGST-TOT", "444683"), row("PDPOSGST-TOTC", "12651"),
  row("PDPOSGS-B", "109081"), row("PDPOSGS-BC", "*"),
  ...["PDPOSTIPS-L2", "PDPOSTIPS-G2", "PDPOSTIPS-G6L11", "PDPOSTIPS-G11"].flatMap((key, index) => [row(key, String(10 + index)), row(`${key}C`, "1")]),
  row("PDFTD-USTET", "121178"), row("PDFTD-USTETC", "-9511"),
  row("PDPOSMBS-TOT", "N/A"),
] } };

const history = (key: string, values: number[]) => ({ pd: { timeseries: values.map((value, index) => ({
  asofdate: new Date(Date.UTC(2026, 8, 16) + index * 7 * 86_400_000).toISOString().slice(0, 10), keyid: key, value: String(value),
})) } });

let requests: string[] = [];

beforeEach(() => {
  requests = [];
  resetPrimaryDealersCache();
  setHttpFetchTransport(async (url) => {
    requests.push(String(url).replace("https://markets.newyorkfed.org/api/pd/", ""));
    const path = requests.at(-1)!;
    if (path === "list/seriesbreaks.json") return Response.json(BREAKS);
    if (path === "latest/SBN2024.json") return Response.json(LATEST);
    const key = /^get\/SBN2024\/timeseries\/(.+)\.json$/.exec(path)?.[1];
    if (key) return Response.json(history(key, key.startsWith("PDPOSTIPS") ? [1, 2, 3] : [100, 110, 120]));
    return new Response("not found", { status: 404 });
  });
});

afterEach(() => setHttpFetchTransport(null));

describe("primary dealer reads", () => {
  test("opening the board is two reads for every series: the break, then the latest figures with their changes", async () => {
    const board = await fetchPrimaryDealers();
    expect(requests).toEqual(["list/seriesbreaks.json", "latest/SBN2024.json"]);
    expect(board.seriesBreak).toBe("SBN2024");
    expect(board.asOf).toBe("2026-10-07");
    expect(board.positions.map((entry) => [entry.label, entry.latest, entry.change])).toEqual([
      ["Treasuries", 444_683, 12_651],
      ["Bills", 109_081, null],
      ["TIPS", 46, 4],
    ]);
    expect(board.fails.map((entry) => [entry.label, entry.previous])).toEqual([["Treasuries ex-TIPS, fails to deliver", 130_689]]);

    // The break is read once a session; refreshing the board is one read.
    await fetchPrimaryDealers();
    expect(requests).toEqual(["list/seriesbreaks.json", "latest/SBN2024.json", "latest/SBN2024.json"]);
  });

  test("a row's history is read when asked for, once per series, and summed across the series behind it", async () => {
    const board = await fetchPrimaryDealers();
    requests = [];
    const tips = board.positions.find((entry) => entry.id === "tips")!;
    expect(cachedDealerHistory("SBN2024", tips)).toBeNull();

    const loaded = await loadDealerHistory("SBN2024", tips);
    expect(requests.sort()).toEqual(["PDPOSTIPS-G11", "PDPOSTIPS-G2", "PDPOSTIPS-G6L11", "PDPOSTIPS-L2"].map((key) => `get/SBN2024/timeseries/${key}.json`));
    expect(loaded).toEqual({ rowId: "tips", points: [
      { asOf: "2026-09-16", value: 4 }, { asOf: "2026-09-23", value: 8 }, { asOf: "2026-09-30", value: 12 },
    ] });

    // Read again, from what is in hand, until a refresh asks for it.
    requests = [];
    expect(cachedDealerHistory("SBN2024", tips)).toEqual(loaded);
    await loadDealerHistory("SBN2024", tips);
    expect(requests).toEqual([]);
    await loadDealerHistory("SBN2024", tips, true);
    expect(requests).toHaveLength(4);
  });

  test("a failed read of a series is not kept", async () => {
    setHttpFetchTransport(async () => new Response("down", { status: 503 }));
    await expect(loadDealerHistory("SBN2024", { id: "bills", keys: ["PDPOSGS-B"] })).rejects.toThrow("503");
    expect(cachedDealerHistory("SBN2024", { id: "bills", keys: ["PDPOSGS-B"] })).toBeNull();
    setHttpFetchTransport(async () => Response.json(history("PDPOSGS-B", [1, 2])));
    expect((await loadDealerHistory("SBN2024", { id: "bills", keys: ["PDPOSGS-B"] })).points).toHaveLength(2);
  });
});

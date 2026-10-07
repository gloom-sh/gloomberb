import type { HeadlessPaneDefinition } from "../../../types/plugin";
import { fetchPowerBoard, fetchAllPowerHistory } from "./client";
import { powerQuery } from "./query";
import { POWER_TABS, powerTab } from "./model";

export const powerHeadless: HeadlessPaneDefinition<"bundle"> = {
  shape: "bundle", argument: { kind: "free-text", optional: true, placeholder: "ticker", description: "Optional listed developer or utility ticker, with exchange suffix where needed." },
  options: [
    { key: "tab", type: "enum", settingKey: "tab", defaultValue: "queue", values: POWER_TABS.map(({ value }) => ({ value })), description: "Queue, history, outcomes, large loads, utility exposure, capacity or coverage." },
    ...["country", "region", "fuel", "status", "search", "sourceId", "from", "to"].map((key) => ({ key, type: "string" as const, settingKey: key, description: `Filter by ${key}.` })),
    { key: "context", type: "enum", settingKey: "context", values: [{ value: "capacity" }, { value: "generation" }, { value: "utility" }], defaultValue: "capacity", description: "Generation capacity, monthly generation or utility context on the Capacity tab." },
    { key: "loadClass", aliases: ["load-class"], type: "enum", settingKey: "loadClass", values: [{ value: "datacenter" }], description: "Only loads explicitly classified as datacenters." },
    { key: "historical", type: "boolean", settingKey: "historical", defaultValue: false, description: "Use historical benchmark queues separately from direct observations." },
  ],
  discovery: { aliases: ["POWER"], dataRequirements: ["Gloom Cloud power queues and large-load disclosures"],
    limitations: ["Pro dataset; free accounts see three rows per section and limited history", "Proposed projects are not committed supply; requests and approvals are distinct", "Coverage varies by jurisdiction; missing MW and unavailable sources remain explicit"] },
  describe: "Power queues, large loads and utility exposure (Pro)",
  async load(args, ctx) {
    const tab = powerTab(args.options.tab);
    const symbol = (Array.isArray(args.argument) ? args.argument.join(" ") : args.argument)?.trim();
    const filter = { ...powerQuery(args.options, symbol), limit: 500 };
    const board = await fetchPowerBoard(filter, ctx.apiClient);
    const projects = [...board.projects];
    const ids = new Set(projects.map((row) => row.id));
    let offset = board.nextOffset;
    let hasMore = board.hasMore;
    // Export traverses every page; a stuck cursor fails visibly instead of silently truncating.
    while (["queue", "loads", "capacity"].includes(tab) && hasMore) {
      if (offset === null || offset < projects.length) throw new Error("Power pagination did not advance.");
      const page = await fetchPowerBoard({ ...filter, offset }, ctx.apiClient);
      if (page.hasMore && (page.nextOffset === null || page.nextOffset <= offset)) throw new Error("Power pagination did not advance.");
      if (page.projects.some((row) => ids.has(row.id))) throw new Error("Power records changed during export; retry the request.");
      for (const row of page.projects) ids.add(row.id);
      projects.push(...page.projects); offset = page.nextOffset; hasMore = page.hasMore;
    }
    const history = tab === "history" ? await fetchAllPowerHistory(filter, ctx.apiClient) : null;
    const rows = tab === "history" ? history!.points : tab === "outcomes" ? board.rates : tab === "utilities" ? board.exposure : tab === "coverage" ? board.coverage : projects;
    const locked = history?.locked ?? (tab === "outcomes" ? board.locked.rates : tab === "utilities" ? board.locked.exposure : tab === "coverage" ? 0 : board.locked.projects);
    return { complete: locked === 0, sections: [{ title: POWER_TABS.find((t) => t.value === tab)!.label, rows: rows.map((r) => ({ ...r })) }],
      metadata: { generatedAt: board.generatedAt, access: board.access, locked, total: board.total, units: "MW unless specified", filters: filter, aggregates: board.aggregates, coverage: board.coverage },
      errors: [...(locked ? ["Additional records and history need Gloom Pro."] : []), ...board.coverage.filter((c) => c.status !== "current").map((c) => `${c.region}: ${c.status}${c.reason ? `: ${c.reason}` : ""}`)] };
  },
};

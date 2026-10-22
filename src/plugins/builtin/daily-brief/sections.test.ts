import { expect, test } from "bun:test";
import { summarizePaneSettingValue } from "../../../components/pane-settings-dialog/value";
import {
  briefTableChoices,
  capBriefView,
  defaultBriefLayout,
  parseBriefSections,
  presentBriefTables,
  resolveBriefLayout,
  serializeBriefLayout,
  storeBriefTables,
} from "./sections";
const tweets = {
  source: { pane: "N", options: { limit: 8 } },
  projection: { columns: ["publishedAt", "source", "headline"], limit: 5 },
  presentation: { title: "Top tweets" },
};

test("a blank setting is the headlines, calendar, and earnings tables", () => {
  const parsed = parseBriefSections("");
  expect("layout" in parsed).toBe(true);
  if (!("layout" in parsed)) return;
  expect(parsed.layout.sections.map((section) => section.kind === "builtin" ? section.builtin : section.title))
    .toEqual(["headlines", "today", "earnings"]);
  expect(parseBriefSections(serializeBriefLayout(defaultBriefLayout()))).toEqual(parsed);
  expect(parseBriefSections("  ")).toEqual(parsed);
  expect(parseBriefSections([])).toEqual({ layout: { version: 1, sections: [] } });
});

test("a view spec is accepted in the same shape as a worksheet and kept short", () => {
  const parsed = parseBriefSections({
    sections: ["headlines", { title: "Wire", spec: tweets }, { builtin: "earnings", title: "Reports" }],
  });
  expect("error" in parsed).toBe(false);
  if (!("layout" in parsed)) return;
  const view = parsed.layout.sections[1];
  expect(view?.kind).toBe("view");
  if (view?.kind !== "view") return;
  expect(view.title).toBe("Wire");
  expect(view.spec.source).toMatchObject({ kind: "inline", pane: "N" });
  expect(view.spec.projection.limit).toBe(5);
  expect(parsed.layout.sections[2]).toMatchObject({ kind: "builtin", builtin: "earnings", title: "Reports" });
});

test("an oversized view is cut to a small table", () => {
  const parsed = parseBriefSections([{ source: { pane: "ERN" }, projection: { limit: 200 } }]);
  if (!("layout" in parsed)) throw new Error("expected a layout");
  const section = parsed.layout.sections[0];
  expect(section?.kind).toBe("view");
  if (section?.kind !== "view") return;
  expect(section.spec.projection.limit).toBe(12);
  const spec = { version: 1 as const, source: { kind: "inline" as const, pane: "ERN" }, projection: { columns: [], filters: [] }, presentation: {} };
  expect(capBriefView(spec).projection.limit).toBe(8);
});

test("a broken view is rejected and does not change the brief", () => {
  const parsed = parseBriefSections({ sections: [{ spec: { source: { pane: "" } } }] });
  expect(parsed).toEqual({ error: expect.stringContaining("source.pane") });
  expect(parseBriefSections({ sections: [{ builtin: "gpu" }] })).toEqual({
    error: expect.stringContaining("unknown table"),
  });
  expect(parseBriefSections({ version: 2, sections: [] })).toEqual({ error: "Unknown tables version." });
  const tooMany = parseBriefSections(Array.from({ length: 9 }, () => "today"));
  expect(tooMany).toEqual({ error: "A brief holds at most 8 tables." });
});

test("the checklist shows table names and keeps a view when the order changes", () => {
  const stored = serializeBriefLayout({
    version: 1,
    sections: [
      { kind: "builtin", id: "headlines", builtin: "headlines" },
      { kind: "view", id: "wire", title: "Wire", spec: {
        version: 1,
        source: { kind: "inline", pane: "N" },
        projection: { columns: [{ key: "headline" }], filters: [], limit: 4 },
        presentation: { title: "Wire" },
      } },
    ],
  });
  expect(presentBriefTables("")).toEqual(["headlines", "today", "earnings"]);
  expect(presentBriefTables(serializeBriefLayout({ version: 1, sections: [] }))).toEqual([]);
  expect(presentBriefTables("{")).toEqual(["headlines", "today", "earnings"]);
  expect(presentBriefTables(stored)).toEqual(["headlines", "wire"]);

  const parsed = parseBriefSections(stored);
  if (!("layout" in parsed)) throw new Error("expected a layout");
  const choices = briefTableChoices(parsed.layout);
  expect(choices.map((choice) => choice.label)).toEqual(["Headlines", "Wire", "Today", "Earnings"]);
  expect(choices.find((choice) => choice.label === "Wire")?.description).toBe("View");
  const defaultLayout = resolveBriefLayout("");
  expect(summarizePaneSettingValue({
    key: "sections",
    label: "Tables",
    type: "ordered-multi-select",
    options: briefTableChoices(defaultLayout),
  }, presentBriefTables(""))).toBe("Headlines, Today, Earnings");

  const reordered = storeBriefTables(["wire", "earnings", "headlines"], stored);
  const again = parseBriefSections(reordered);
  if (!("layout" in again)) throw new Error("expected a layout");
  expect(again.layout.sections.map((section) => section.id)).toEqual(["wire", "earnings", "headlines"]);
  const wire = again.layout.sections[0];
  expect(wire?.kind).toBe("view");
  if (wire?.kind === "view") expect(wire.spec.source).toMatchObject({ pane: "N" });
  expect(again.layout.sections[1]).toMatchObject({ kind: "builtin", builtin: "earnings" });

  expect(storeBriefTables([], stored)).toBe(serializeBriefLayout({ version: 1, sections: [] }));
  expect(() => storeBriefTables(["missing"], stored)).toThrow("Unknown table");
  expect(() => storeBriefTables(Array.from({ length: 9 }, () => "headlines"), stored)).toThrow("at most 8");
});

test("the stored json round-trips a mixed list", () => {
  const parsed = parseBriefSections(["today", tweets]);
  if (!("layout" in parsed)) throw new Error("expected a layout");
  const again = parseBriefSections(serializeBriefLayout(parsed.layout));
  expect(again).toEqual(parsed);
  const view = parsed.layout.sections[1];
  expect(view?.kind).toBe("view");
  if (view?.kind !== "view") return;
  expect(view.spec.presentation.title).toBe("Top tweets");
});

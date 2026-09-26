import { describe, expect, test } from "bun:test";
import { CURRENT_CONFIG_VERSION } from "../types/config";
import {
  computeLayoutRequirements,
  layoutContentFingerprint,
  parseCloudLayoutEntry,
  parseCloudLayoutList,
  parseCloudLayoutRevisions,
} from "./cloud";
import type { LayoutMarketplacePayload } from "./payload";

const payload: LayoutMarketplacePayload = {
  schemaVersion: 2,
  sourceConfigVersion: CURRENT_CONFIG_VERSION,
  layout: {
    dockRoot: {
      kind: "split",
      axis: "horizontal",
      ratio: 0.5,
      first: { kind: "pane", instanceId: "p1" },
      second: { kind: "pane", instanceId: "p2" },
    },
    instances: [
      { instanceId: "p1", paneId: "ticker-research", binding: { kind: "fixed", symbol: "AAPL" }, settings: { tab: "news" } },
      { instanceId: "p2", paneId: "chart", binding: { kind: "follow", sourceInstanceId: "p1" } },
    ],
    floating: [],
    detached: [],
  },
  paneState: { p1: { activeTabId: "news" } },
};

const entry = {
  id: "a".repeat(32),
  name: "Morning",
  owner: { kind: "team", id: "org-1" },
  visibility: "team",
  revision: 3,
  paneIds: ["ticker-research", "chart"],
  requires: [{ pluginId: "gloomberb-tv", repo: "gloom-sh/gloomberb-tv", minVersion: "1.0.0" }, { bad: true }],
  note: "moved chart",
  author: { username: "ada", displayName: "Ada" },
  createdBy: "u1",
  publishedAt: "2026-09-14T12:00:00.000Z",
  createdAt: "2026-09-14T11:00:00.000Z",
  updatedAt: "2026-09-14T12:00:00.000Z",
  somethingNewer: { the: "server learned" },
  ...payload,
};

describe("cloud layout parsing", () => {
  test("accepts the full shape and ignores unknown keys", () => {
    const parsed = parseCloudLayoutEntry(entry);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      id: entry.id,
      name: "Morning",
      owner: { kind: "team", id: "org-1" },
      visibility: "team",
      revision: 3,
      paneIds: ["ticker-research", "chart"],
      requires: [{ pluginId: "gloomberb-tv", repo: "gloom-sh/gloomberb-tv", minVersion: "1.0.0" }],
      note: "moved chart",
      author: { username: "ada", displayName: "Ada" },
    });
    expect(parsed?.layout.instances).toHaveLength(2);
    expect(parsed?.paneState.p1).toEqual({ activeTabId: "news" });
  });

  test("rejects a broken owner, revision, or payload", () => {
    expect(parseCloudLayoutEntry({ ...entry, owner: { kind: "group", id: "x" } })).toBeNull();
    expect(parseCloudLayoutEntry({ ...entry, revision: 0 })).toBeNull();
    expect(parseCloudLayoutEntry({ ...entry, layout: { instances: "nope" } })).toBeNull();
    expect(parseCloudLayoutEntry({ ...entry, id: "short" })).toBeNull();
  });

  test("parses lists and revision histories", () => {
    expect(parseCloudLayoutList({ items: [entry] })?.map((item) => item.revision)).toEqual([3]);
    expect(parseCloudLayoutList({ items: [entry, { junk: true }] })).toBeNull();
    expect(parseCloudLayoutRevisions({
      items: [
        { revision: 3, note: "moved chart", requires: [], author: { username: null, displayName: "Alice" }, publishedAt: "2026-09-14T12:00:00.000Z" },
        { revision: 2, note: null, author: { username: "ada", displayName: "Ada" }, publishedAt: "2026-09-13T12:00:00.000Z" },
      ],
    })).toEqual([
      { revision: 3, note: "moved chart", requires: [], author: { username: null, displayName: "Alice" }, publishedAt: "2026-09-14T12:00:00.000Z" },
      { revision: 2, note: null, requires: [], author: { username: "ada", displayName: "Ada" }, publishedAt: "2026-09-13T12:00:00.000Z" },
    ]);
  });
});

describe("layoutContentFingerprint", () => {
  test("ignores arrangement and instance order but sees content edits", () => {
    const base = layoutContentFingerprint(payload);
    const rearranged: LayoutMarketplacePayload = {
      ...payload,
      layout: {
        ...payload.layout,
        dockRoot: { kind: "pane", instanceId: "p1" },
        floating: [{ instanceId: "p2", x: 1, y: 1, width: 40, height: 10 }],
        instances: [...payload.layout.instances].reverse(),
      },
    };
    expect(layoutContentFingerprint(rearranged)).toBe(base);

    const edited: LayoutMarketplacePayload = {
      ...payload,
      layout: {
        ...payload.layout,
        instances: [
          { ...payload.layout.instances[0]!, binding: { kind: "fixed", symbol: "MSFT" } },
          payload.layout.instances[1]!,
        ],
      },
    };
    expect(layoutContentFingerprint(edited)).not.toBe(base);

    const stateEdited: LayoutMarketplacePayload = { ...payload, paneState: { p1: { activeTabId: "filings" } } };
    expect(layoutContentFingerprint(stateEdited)).not.toBe(base);

    const added: LayoutMarketplacePayload = {
      ...payload,
      layout: { ...payload.layout, instances: [...payload.layout.instances, { instanceId: "p3", paneId: "news" }] },
    };
    expect(layoutContentFingerprint(added)).not.toBe(base);
  });
});

describe("computeLayoutRequirements", () => {
  test("lists external plugins once with their repo and version", () => {
    const requires = computeLayoutRequirements(
      {
        dockRoot: null,
        instances: [
          { instanceId: "a", paneId: "tv:chart" },
          { instanceId: "b", paneId: "tv:screener" },
          { instanceId: "c", paneId: "ticker-research" },
          { instanceId: "d", paneId: "unknown-pane" },
        ],
        floating: [],
        detached: [],
      },
      {
        panePluginId: (paneId) => (paneId.startsWith("tv:") ? "gloomberb-tv" : paneId === "ticker-research" ? "core" : undefined),
        pluginInfo: (pluginId) => (
          pluginId === "gloomberb-tv"
            ? { repo: "gloom-sh/gloomberb-tv", version: "1.2.0", builtin: false }
            : { builtin: true }
        ),
      },
    );
    expect(requires).toEqual([{ pluginId: "gloomberb-tv", repo: "gloom-sh/gloomberb-tv", minVersion: "1.2.0" }]);
  });
});

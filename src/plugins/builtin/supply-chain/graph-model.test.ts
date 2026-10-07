import { expect, test } from "bun:test";
import { graphOptions, validateGraph } from "./graph-client";
import { entityKey, exposureLabel, graphNodes } from "./graph-model";
import { graphPayload } from "./test-fixture-graph";

test("unlisted recenter retains stable identity and exposure keeps its denominator", () => {
  const data = graphPayload();
  expect(entityKey(data.nodes[1]!)).toBe("id:2");
  expect(exposureLabel(data.upstream[1]!.bestPath, data)).toBe("20% est. of 1 revenue");
});
test("collapse removes descendants while retaining the branch, including a selected path", () => {
  const data = graphPayload(), path = data.upstream[1]!.bestPath;
  expect(graphNodes(data, [], path).map(node => node.entity.id)).toEqual(["3", "2", "1"]);
  expect(graphNodes(data, ["2"], path).map(node => node.entity.id)).toEqual(["2", "1"]);
});
test("target-only responses retain every route node and upstream direction", () => {
  const data = graphPayload(); data.paths = [data.upstream[1]!.bestPath]; data.upstream = [];
  const nodes = graphNodes(data, [], data.paths[0]!);
  expect(nodes.map(node => [node.entity.id, node.column])).toEqual([["3", -2], ["2", -1], ["1", 0]]);
});
test("graph boundary rejects disconnected hops, unsupported source URLs and unlabelled exposure", () => {
  expect(validateGraph(graphPayload()).links).toHaveLength(2);
  for (const corrupt of [(data: ReturnType<typeof graphPayload>) => { data.links[1]!.from = "1"; },
    (data: ReturnType<typeof graphPayload>) => { data.links[0]!.evidence[0]!.filingUrl = "javascript:alert(1)"; },
    (data: ReturnType<typeof graphPayload>) => { data.upstream[1]!.bestPath.exposure!.denominatorEntityId = "unrelated"; }]) {
    const data = graphPayload(); corrupt(data); expect(() => validateGraph(data)).toThrow("unreadable");
  }
});
test("filters reject impossible dates, thresholds, dimensions and fractional hops", () => {
  expect(graphOptions({ depth: 4, "min-confidence": ".6", tiers: "primary,structured", "as-of": "2024-02-29" }).minConfidence).toBe(.6);
  for (const options of [{ asOf: "2025-02-29" }, { depth: 1.5 }, { minPct: "NaN" }, { minConfidence: 1.1 }, { roles: "owner" }, { limit: 51 }]) expect(() => graphOptions(options)).toThrow("Invalid");
});

test("layer placement retains connectors omitted by endpoint limits and follows the ranked route", () => {
  const data = graphPayload();
  const indirect = data.upstream[1]!.bestPath;
  data.upstream = [data.upstream[1]!];
  expect(graphNodes(data, [], null).map(node => node.entity.id)).toEqual(["3", "2", "1"]);
  data.links.push({ ...data.links[0]!, id: "direct", from: "3", to: "1" });
  data.upstream[0]!.shortestPath = { ...indirect, id: "upstream|direct", nodeIds: ["1", "3"], linkIds: ["direct"], hops: 1 };
  data.upstream[0]!.hops = 1;
  expect(graphNodes(data, [], null).find(node => node.entity.id === "3")!.hops).toBe(2);
  data.options.ranking = "shortest";
  expect(graphNodes(data, [], null).map(node => [node.entity.id, node.hops])).toEqual([["3", 1], ["1", 0]]);
});

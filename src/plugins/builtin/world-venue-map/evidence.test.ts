import { expect, test } from "bun:test";
import { worldMapScreenshotEvidence } from "./evidence";

// `shot MAP` drew its default layer in full, and --strict said it "did not match the requested capability".
test("a bare MAP takes the layers it drew; layers asked for must be the ones drawn", () => {
  const drawn = worldMapScreenshotEvidence.read({
    kind: "world-map", version: 1, complete: true, plottedValueCount: 56, tokens: ["chokepoints"], tableRows: 28,
    layers: [{ id: "chokepoints", phase: "ready", features: 28, clusters: 0 }],
  })!;
  const request = (layer?: string, arg = "") => ({ resolved: { options: layer ? { layer } : {}, createOptions: { arg } }, payload: {} }) as never;
  expect(worldMapScreenshotEvidence.mismatches(drawn, request())).toEqual([]);
  expect(worldMapScreenshotEvidence.mismatches(drawn, request("chokepoints"))).toEqual([]);
  expect(worldMapScreenshotEvidence.mismatches(drawn, request(undefined, "ports"))).toEqual(["Map layers differ from the request"]);
});

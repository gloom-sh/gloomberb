import { expect, test } from "bun:test";
import { flowGeometry } from "./flow-layout";
import { supplyRow } from "./test-fixture";

test("ribbons leave exactly at their card's edge and land on the focus card's edge in card order, so none cross", () => {
  const rows = [
    ...[30, 20, 10].map((pct, i) => supplyRow(`customer-${i}`, { pctOfRevenue: pct })),
    ...[0, 1, 2, 3].map((i) => supplyRow(`supplier-${i}`, { role: "supplier", direction: "in", pctOfRevenue: null, pctBasis: null })),
  ];
  for (const [width, height] of [[160, 26], [90, 16], [240, 56]] as const) {
    const geometry = flowGeometry(rows, { width, height, focusId: "FOCUS", focusLabelWidth: 5 });
    const { center } = geometry;
    for (const band of ["suppliers", "customers"] as const) {
      const ribbons = geometry.ribbons.filter((ribbon) => ribbon.band === band);
      const cards = geometry.nodes.filter((node) => node.band === band && node.row);
      expect(ribbons.map((ribbon) => ribbon.id)).toEqual(cards.map((card) => card.id));
      let previous = -Infinity;
      ribbons.forEach((ribbon, index) => {
        const card = cards[index]!;
        const [cardEdge, cardY, focusEdge, focusY] = band === "suppliers"
          ? [ribbon.x0, ribbon.y0, ribbon.x1, ribbon.y1] : [ribbon.x1, ribbon.y1, ribbon.x0, ribbon.y0];
        expect(cardEdge).toBe(band === "suppliers" ? card.x + card.width : card.x);
        expect(cardY).toBe(card.y + card.height / 2);
        expect(focusEdge).toBe(band === "suppliers" ? center.x : center.x + center.width);
        expect(focusY).toBeGreaterThan(center.y);
        expect(focusY).toBeLessThan(center.y + center.height);
        expect(focusY).toBeGreaterThan(previous);
        previous = focusY;
      });
    }
    // Cards never overlap the focus card or run past the pane.
    for (const node of geometry.nodes) {
      expect(node.x + node.width).toBeLessThanOrEqual(width);
      if (node.band !== "related") expect(node.x + node.width <= center.x || node.x >= center.x + center.width).toBe(true);
    }
    expect(geometry.ribbons.find((ribbon) => ribbon.band === "suppliers")?.thickness).toBeNull();
  }
});

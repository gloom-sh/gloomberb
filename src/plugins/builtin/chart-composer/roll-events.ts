import type { CompositeChartEvent } from "../../../components/chart/composite/types";
import type { ResolvedSeries } from "../../../time-series/types";

const ROLL_ID = ":roll:";

/**
 * A futures formula's rolls as chart events: a guide on each point a leg
 * rolls on, captioned with the contracts it rolls to (`Roll to RBZ26 HOZ26
 * CLZ26`), else `Roll`. A crack priced in one delivery month rolls every leg
 * on its leader's day, so it has one guide per roll. Two formulas rolling on
 * the same point share its guide.
 */
export function formulaRollEvents(series: readonly ResolvedSeries[]): CompositeChartEvent[] {
  const events = new Map<number, CompositeChartEvent>();
  for (const entry of series) {
    if (!entry.formulaLegs) continue;
    entry.points.forEach((point, index) => {
      if (!point.roll || !point.legs?.length) return;
      const time = point.date.getTime();
      if (events.has(time)) return;
      const before = entry.points[index - 1]?.legs;
      const rolled = point.legs.flatMap((leg, position) => (
        leg.contract && leg.contract !== before?.[position]?.contract ? [leg.contract] : []
      ));
      events.set(time, {
        id: `${entry.id}${ROLL_ID}${time}`,
        time,
        captions: rolled.length ? [`Roll to ${rolled.join(" ")}`, "Roll"] : ["Roll"],
      });
    });
  }
  return [...events.values()];
}

/** Whether a chart event is a formula's roll (`formulaRollEvents`). */
export function isRollEvent(event: Pick<CompositeChartEvent, "id">): boolean {
  return event.id.includes(ROLL_ID);
}

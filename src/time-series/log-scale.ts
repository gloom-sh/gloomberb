/** A value a log axis cannot place: zero or below. */
export function hiddenOnLogScale(value: number | null | undefined): boolean {
  return typeof value === "number" && Number.isFinite(value) && value <= 0;
}

/** What a log panel says about the values it leaves out, by the name of what holds them. */
export function logScaleHiddenWarning(name: string, hiddenCount: number): string {
  return `${name}: ${hiddenCount} non-positive observation${hiddenCount === 1 ? " is" : "s are"} hidden on the logarithmic scale.`;
}

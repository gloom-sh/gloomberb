/**
 * The step a daily study takes before it reads closes (BT's run, HVG's
 * estimates): the newest session is left out while it is not final, and the
 * report says so. Not final is a session still trading (`partial`: its close
 * is the latest price) or a future's closed session whose settlement is not
 * in yet (`unsettled`: its close is the last trade). Either close moves
 * before the day is done, so a study that kept it would give another answer
 * read again.
 */
interface DatedBar {
  partial?: boolean;
  unsettled?: boolean;
}

export function isFormingBar(bar: DatedBar): boolean {
  return bar.partial === true || bar.unsettled === true;
}

/**
 * What the bars left out are, after their dates: "is still forming
 * (partial)", "is not settled yet (unsettled)", or for several of both kinds
 * "are still forming or not settled yet".
 */
export function formingBarsState(bars: readonly DatedBar[]): string {
  const verb = bars.length === 1 ? "is" : "are";
  if (bars.every((bar) => bar.partial === true)) return `${verb} still forming (partial)`;
  if (bars.every((bar) => bar.unsettled === true && bar.partial !== true)) return `${verb} not settled yet (unsettled)`;
  return `${verb} still forming or not settled yet`;
}

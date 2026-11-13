import type { CliCommandContext } from "../types/plugin";
import { cliStyles } from "../utils/cli-output";

/** A list this slow says how far it has got, so it never looks stuck: first after two seconds, then every five. */
const PROGRESS_AFTER_MS = 2_000;
const PROGRESS_EVERY_MS = 5_000;

/**
 * Lines on standard error while a command works through a list of symbols
 * slowly, worded by `line` from how many are settled, how many there are, and
 * whether a line was printed already: two seconds in, then every five seconds
 * until all are. Nothing for one symbol or a list that is quick, nor with
 * `--quiet`. It is told (0, total) as the list starts and again as each
 * symbol settles; the lines come from a timer, so a list waiting on one slow
 * answer still says so.
 */
export function listProgressNotice(
  ctx: Pick<CliCommandContext, "cliOptions">,
  line: (settled: number, total: number, told: boolean) => string,
  { afterMs = PROGRESS_AFTER_MS, everyMs = PROGRESS_EVERY_MS }: { afterMs?: number; everyMs?: number } = {},
): (settled: number, total: number) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let settled = 0, total = 0, told = false;
  const tell = () => {
    timer = undefined;
    if (settled >= total) return;
    console.error(cliStyles.muted(line(settled, total, told)));
    told = true;
    schedule(everyMs);
  };
  const schedule = (ms: number) => {
    timer = setTimeout(tell, ms);
    // The command's own end, not this line, decides when the process exits.
    (timer as { unref?: () => void }).unref?.();
  };
  return (done, of) => {
    if (ctx.cliOptions.quiet || of < 2) return;
    settled = done;
    total = of;
    if (settled >= total) {
      if (timer) clearTimeout(timer);
      timer = undefined;
    } else if (!timer) schedule(afterMs);
  };
}

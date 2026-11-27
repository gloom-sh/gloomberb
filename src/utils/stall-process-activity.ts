const IO_COUNTERS = ["readOps", "writeOps", "otherOps", "readBytes", "writeBytes", "otherBytes"] as const;

type IoCounter = typeof IO_COUNTERS[number];
type CounterStatus = "unavailable" | "failed" | "reset";
type CounterReading<T> = T | null | undefined;

export interface ProcessActivityReading {
  pageFaults: CounterReading<bigint>;
  io: CounterReading<ReadonlyArray<bigint>>;
}

export interface ProcessActivityDelta {
  pageFaults: number | CounterStatus;
  io: Record<IoCounter, number> | CounterStatus;
}

function pageFaultDelta(before: CounterReading<bigint>, after: CounterReading<bigint>): number | CounterStatus {
  if (before === null || after === null) return "failed";
  if (before === undefined || after === undefined) return "unavailable";
  return difference(before, after);
}

function difference(before: bigint, after: bigint): number | "reset" {
  return after < before ? "reset" : Math.min(Number.MAX_SAFE_INTEGER, Number(after - before));
}

export function processActivityDelta(
  before: ProcessActivityReading | null | undefined,
  after: ProcessActivityReading | null | undefined,
): ProcessActivityDelta | undefined {
  if (!before && !after) return undefined;
  const beforeIo = before === null ? null : before?.io;
  const afterIo = after === null ? null : after?.io;
  let io: ProcessActivityDelta["io"];
  if (beforeIo === null || afterIo === null) io = "failed";
  else if (!beforeIo || !afterIo) io = "unavailable";
  else {
    const counts = {} as Record<IoCounter, number>;
    io = counts;
    for (const [index, counter] of IO_COUNTERS.entries()) {
      const count = difference(beforeIo[index]!, afterIo[index]!);
      if (count === "reset") {
        io = count;
        break;
      }
      counts[counter] = count;
    }
  }
  return {
    pageFaults: pageFaultDelta(before === null ? null : before?.pageFaults, after === null ? null : after?.pageFaults),
    io,
  };
}

export function formatProcessActivity(activity: ProcessActivityDelta): string[] {
  const { io } = activity;
  return [
    `pageFaults=${activity.pageFaults}`,
    ...(typeof io === "string" ? [`io=${io}`] : IO_COUNTERS.map((counter) => `${counter}=${io[counter]}`)),
  ];
}

/** Compact, fixed-order counters for the crash reporter's bounded details field. */
export function formatProcessActivitySummary({ pageFaults, io }: ProcessActivityDelta): string[] {
  const bucket = (value: number | CounterStatus): string => {
    if (typeof value !== "number") return value === "unavailable" ? "na" : value === "failed" ? "err" : "reset";
    return value < 100 ? String(value) : `e${Math.floor(Math.log10(value))}`;
  };
  return [`pf=${bucket(pageFaults)}`, `io=${typeof io === "string" ? bucket(io) : IO_COUNTERS.map((counter) => bucket(io[counter])).join("/")}`];
}

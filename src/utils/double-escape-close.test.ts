import { describe, expect, test } from "bun:test";
import {
  armDoubleEscapeClose,
  createDoubleEscapeCloseState,
  resetDoubleEscapeClose,
  takeDoubleEscapeClose,
} from "./double-escape-close";

interface Press {
  at: number;
  pane: string;
  /** What the host says: true a held key's repeat, false a fresh press, absent where it cannot tell. */
  repeat?: boolean;
}

/** Each Esc as the shell sees it: the second of a pair closes, any other arms. Returns the panes closed, in order. */
function play(presses: Press[]): string[] {
  const state = createDoubleEscapeCloseState();
  const closed: string[] = [];
  for (const { at, pane, repeat } of presses) {
    if (takeDoubleEscapeClose(state, pane, at, repeat)) closed.push(pane);
    else armDoubleEscapeClose(state, pane, at, repeat);
  }
  return closed;
}

/** Esc Esc on each pane in turn: `pairGap` between the two, `nextGap` from the closing Esc to the next pane's first. */
function closeInTurn(panes: string[], { pairGap, nextGap, repeat }: { pairGap: number; nextGap: number; repeat?: boolean }): Press[] {
  const presses: Press[] = [];
  let at = 0;
  for (const pane of panes) {
    presses.push({ at, pane, repeat });
    at += pairGap;
    presses.push({ at, pane, repeat });
    at += nextGap;
  }
  return presses;
}

describe("double escape close detector", () => {
  test("matches a second escape for the same target inside the threshold", () => {
    const state = createDoubleEscapeCloseState();

    expect(takeDoubleEscapeClose(state, "pane:a", 1000)).toBe(false);
    armDoubleEscapeClose(state, "pane:a", 1000);
    expect(takeDoubleEscapeClose(state, "pane:a", 1200)).toBe(true);
    expect(state.targetId).toBe(null);
  });

  test("requires the same target and a recent first escape", () => {
    const state = createDoubleEscapeCloseState();

    armDoubleEscapeClose(state, "pane:a", 1000);
    expect(takeDoubleEscapeClose(state, "pane:b", 1100)).toBe(false);
    armDoubleEscapeClose(state, "pane:b", 1100);
    expect(takeDoubleEscapeClose(state, "pane:b", 2000)).toBe(false);
    armDoubleEscapeClose(state, "pane:b", 2000);
    expect(takeDoubleEscapeClose(state, "pane:b", 2100)).toBe(true);
  });

  test("can be reset by non-escape input", () => {
    const state = createDoubleEscapeCloseState();

    armDoubleEscapeClose(state, "pane:a", 1000);
    resetDoubleEscapeClose(state);
    expect(takeDoubleEscapeClose(state, "pane:a", 1100)).toBe(false);
  });
});

describe("a held Esc", () => {
  test("closes one pane and arms nothing for the next while the stream lasts", () => {
    const state = createDoubleEscapeCloseState();
    let closes = 0;
    // One press, then repeats from 400 ms on every 33 ms for 3 s, as a terminal sends them.
    const presses = [0, ...Array.from({ length: 90 }, (_, index) => 400 + index * 33)];
    for (const at of presses) {
      if (takeDoubleEscapeClose(state, "pane:a", at)) closes += 1;
      else armDoubleEscapeClose(state, "pane:a", at);
    }

    expect(closes).toBe(1);
  });

  test("two separate pairs still close two panes", () => {
    const state = createDoubleEscapeCloseState();

    armDoubleEscapeClose(state, "pane:a", 1000);
    expect(takeDoubleEscapeClose(state, "pane:a", 1200)).toBe(true);
    armDoubleEscapeClose(state, "pane:b", 2000);
    expect(takeDoubleEscapeClose(state, "pane:b", 2200)).toBe(true);
  });
});

describe("closing panes one after another", () => {
  const panes = ["pane:a", "pane:b", "pane:c", "pane:d"];
  // Where the host cannot tell (a terminal) and where it reports each press.
  const hosts = [{ name: "a terminal", repeat: undefined }, { name: "a host that reports repeats", repeat: false }];

  for (const { name, repeat } of hosts) {
    test(`closes every pane at a comfortable pace on ${name}`, () => {
      expect(play(closeInTurn(panes, { pairGap: 180, nextGap: 300, repeat }))).toEqual(panes);
    });

    test(`closes every pane at a quick pace on ${name}`, () => {
      expect(play(closeInTurn(panes, { pairGap: 140, nextGap: 140, repeat }))).toEqual(panes);
    });

    test(`closes a pane with every second press when mashing eight a second on ${name}`, () => {
      const state = createDoubleEscapeCloseState();
      const closed: string[] = [];
      for (let press = 0; press < 8; press += 1) {
        const pane = panes[closed.length]!;
        if (takeDoubleEscapeClose(state, pane, press * 125, repeat)) closed.push(pane);
        else armDoubleEscapeClose(state, pane, press * 125, repeat);
      }
      expect(closed).toEqual(panes);
    });
  }

  test("a host that reports repeats takes a press right after a close as a press, a terminal as the held key", () => {
    const rapid = (repeat: boolean | undefined): Press[] => [
      { at: 0, pane: "pane:a", repeat },
      { at: 100, pane: "pane:a", repeat },
      { at: 150, pane: "pane:b", repeat },
      { at: 200, pane: "pane:b", repeat },
    ];

    expect(play(rapid(false))).toEqual(["pane:a", "pane:b"]);
    expect(play(rapid(undefined))).toEqual(["pane:a"]);
  });
});

describe("a held Esc on a terminal that cannot flag repeats", () => {
  /** One press, then repeats from `delay` on every `interval` for three seconds. */
  const held = (pane: string, { delay, interval }: { delay: number; interval: number }): Press[] => [
    { at: 0, pane },
    ...Array.from({ length: Math.floor(3_000 / interval) }, (_, index) => ({ at: delay + index * interval, pane })),
  ];

  // The slowest stock repeat (macOS: 90 ms after 375 ms) and a fast one (X11: 25 ms after 660 ms).
  test("closes one pane at the stock repeat rates", () => {
    expect(play(held("pane:a", { delay: 375, interval: 90 }))).toEqual(["pane:a"]);
    expect(play(held("pane:a", { delay: 660, interval: 25 }))).toEqual(["pane:a"]);
  });

  // A stall (the redraw after the close, a busy frame) holds a repeat back and the ones behind it arrive together.
  test("closes one pane when a stall delays a repeat and bunches the ones behind it", () => {
    const at = (times: number[]): Press[] => times.map((time) => ({ at: time, pane: "pane:a" }));

    // Closed at 375, repeats every 90 ms, a 230 ms stall, then two repeats 20 ms apart.
    expect(play(at([0, 375, 465, 555, 785, 805, 895, 985, 1075]))).toEqual(["pane:a"]);
    // The first repeat after the close is the one held back.
    expect(play(at([0, 375, 525, 545, 635, 725]))).toEqual(["pane:a"]);
  });

  test("lets the next pair close the next pane once the key is up", () => {
    const stream = held("pane:a", { delay: 400, interval: 33 });
    const released = stream[stream.length - 1]!.at;

    expect(play([
      ...stream,
      { at: released + 300, pane: "pane:b" },
      { at: released + 450, pane: "pane:b" },
    ])).toEqual(["pane:a", "pane:b"]);
  });
});

describe("a held Esc on a host that flags repeats", () => {
  test("never counts a flagged repeat, so a held key closes nothing", () => {
    const stream: Press[] = [
      { at: 0, pane: "pane:a", repeat: false },
      ...Array.from({ length: 90 }, (_, index) => ({ at: 400 + index * 33, pane: "pane:a", repeat: true })),
    ];

    expect(play(stream)).toEqual([]);
  });

  test("arms nothing on the next pane after a close, so the repeats never close it", () => {
    const stream: Press[] = [
      { at: 0, pane: "pane:a", repeat: false },
      { at: 150, pane: "pane:a", repeat: false },
      // The key is still down: the browser keeps sending it, flagged.
      ...Array.from({ length: 60 }, (_, index) => ({ at: 500 + index * 33, pane: "pane:b", repeat: true })),
    ];

    expect(play(stream)).toEqual(["pane:a"]);
  });

  test("an unflagged press right after the repeats is a press of its own", () => {
    expect(play([
      { at: 0, pane: "pane:a", repeat: false },
      { at: 400, pane: "pane:a", repeat: true },
      { at: 433, pane: "pane:a", repeat: true },
      { at: 700, pane: "pane:a", repeat: false },
      { at: 800, pane: "pane:a", repeat: false },
    ])).toEqual(["pane:a"]);
  });
});

import { expect, test } from "bun:test";
import type { CloudTranscriptTurnPayload } from "../../../api-client";
import { findInLines, lineAt, transcriptLineStarts } from "./model";

const turn = (startSeconds: number | null, paragraphs: string[], paragraphStarts?: number[]): CloudTranscriptTurnPayload => ({
  speaker: "Jane Roe", text: paragraphs.join(" "), paragraphs, isQa: false, startSeconds, ...(paragraphStarts ? { paragraphStarts } : {}),
});

test("paragraph starts come from the server, and a transcript held from before them is placed by text", () => {
  const turns = [
    turn(4, ["Good afternoon."]),
    turn(12, ["a".repeat(100), "b".repeat(100), "c".repeat(199)], [12, 47, 82]),
    // Held in the cache before the server sent starts: spread from the turn's
    // start to the next turn's by how far into the turn each paragraph sits.
    turn(120, ["d".repeat(99), "e".repeat(99), "f".repeat(199)]),
    turn(220, ["Thank you."]),
  ];
  expect(transcriptLineStarts(turns, 3000)).toEqual([
    [4],
    [12, 47, 82],
    [120, 145, 170],
    [220],
  ]);
  // The last turn runs to the end of the call.
  expect(transcriptLineStarts([turn(100, ["x".repeat(99), "y".repeat(99)])], 300)).toEqual([[100, 200]]);
  // A document the company published has no times to play from.
  expect(transcriptLineStarts([turn(null, ["Prepared remarks."])], 300)).toEqual([[null]]);
});

test("the paragraph being spoken is the last one to have started", () => {
  const starts = [[4], [12, 47, 82], [null], [82, 120]];
  expect(lineAt(starts, 0)).toBeNull();
  expect(lineAt(starts, 4)).toEqual({ turn: 0, paragraph: 0 });
  expect(lineAt(starts, 46.9)).toEqual({ turn: 1, paragraph: 0 });
  expect(lineAt(starts, 47)).toEqual({ turn: 1, paragraph: 1 });
  // A turn that starts on the same second as the paragraph before it takes over.
  expect(lineAt(starts, 90)).toEqual({ turn: 3, paragraph: 0 });
  expect(lineAt(starts, 5000)).toEqual({ turn: 3, paragraph: 1 });
});

test("a find starts at two characters: one letter matches nothing", () => {
  const lines = [
    { turn: 0, paragraph: 0, text: "Revenue grew this quarter." },
    { turn: 1, paragraph: 0, text: "The quarter closed. Quarterly margins held." },
  ];
  expect(findInLines(lines, "q")).toEqual([]);
  expect(findInLines(lines, " q ")).toEqual([]);
  expect(findInLines(lines, "qu").map((match) => [match.turn, match.occurrence])).toEqual([[0, 0], [1, 0], [1, 1]]);
});

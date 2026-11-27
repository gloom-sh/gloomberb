import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "../api-client/errors";
import { CloudHeardFromApi, type HeardFromAnswer, type HeardFromState } from "../api-client/heard-from";
import {
  heardFromDueAccount,
  type HeardFromChoice,
  markHeardFromDue,
  runHeardFromQuestion,
  takeHeardFromDue,
} from "./heard-from";

function deps({ state, choice = null, fail, pick }: {
  state: () => Promise<HeardFromState>;
  choice?: HeardFromChoice;
  fail?: "writes";
  /** Picked before the card resolves, as Instagram, TikTok, YouTube and X are. */
  pick?: HeardFromAnswer;
}) {
  const calls: string[] = [];
  const write = (name: string) => async () => {
    calls.push(name);
    if (fail === "writes") throw new Error("offline");
  };
  return {
    calls,
    deps: {
      getState: state,
      reportShown: write("shown"),
      answer: async (answer: string, note?: string) => {
        calls.push(note ? `answer ${answer} ${note}` : `answer ${answer}`);
        if (fail === "writes") throw new Error("offline");
      },
      skip: write("skip"),
      ask: async (shown: () => void, picked: (answer: HeardFromAnswer) => void) => {
        shown();
        shown();
        if (pick) {
          picked(pick);
          picked(pick);
        }
        calls.push("asked");
        return choice;
      },
    },
  };
}

describe("when the app asks where an account heard about Gloom", () => {
  test("a just-made account is asked, and its answer kept", async () => {
    const run = deps({
      state: async () => ({ ask: true, settled: false }),
      choice: { answer: "other", note: "a podcast" },
    });
    expect(await runHeardFromQuestion(run.deps)).toBe("answered");
    expect(run.calls).toEqual(["shown", "asked", "answer other a podcast"]);
  });

  test("Skip is kept as a skip", async () => {
    const run = deps({ state: async () => ({ ask: true, settled: false }), choice: null });
    expect(await runHeardFromQuestion(run.deps)).toBe("skipped");
    expect(run.calls).toEqual(["shown", "asked", "skip"]);
  });

  test("an answer that asks which account or post is kept when picked; its note follows", async () => {
    const run = deps({
      state: async () => ({ ask: true, settled: false }),
      pick: "instagram",
      choice: { answer: "instagram", note: "@la_bourse" },
    });
    expect(await runHeardFromQuestion(run.deps)).toBe("answered");
    expect(run.calls).toEqual(["shown", "answer instagram", "asked", "answer instagram @la_bourse"]);
  });

  test("leaving the note keeps the answer picked: never a skip, nothing sent twice", async () => {
    for (const choice of [null, { answer: "tiktok" as const }]) {
      const run = deps({ state: async () => ({ ask: true, settled: false }), pick: "tiktok", choice });
      expect(await runHeardFromQuestion(run.deps)).toBe("answered");
      expect(run.calls).toEqual(["shown", "answer tiktok", "asked"]);
    }
    const failed = deps({ state: async () => ({ ask: true, settled: false }), pick: "x", choice: { answer: "x", note: "a thread" }, fail: "writes" });
    expect(await runHeardFromQuestion(failed.deps)).toBe("answered");
    expect(failed.calls).toEqual(["shown", "answer x", "asked", "answer x a thread"]);
  });

  test("an account the service has settled (answered, skipped, too old) is not asked", async () => {
    const run = deps({ state: async () => ({ ask: false, settled: true }) });
    expect(await runHeardFromQuestion(run.deps)).toBe("not-asked");
    expect(run.calls).toEqual([]);
  });

  test("a failed read, or a service too old to know the question, asks nothing and never throws", async () => {
    for (const error of [new Error("network down"), new ApiRequestError("Not found", 404)]) {
      const run = deps({ state: async () => { throw error; } });
      expect(await runHeardFromQuestion(run.deps)).toBe("not-asked");
      expect(run.calls).toEqual([]);
    }
    const garbled = deps({ state: () => new CloudHeardFromApi(async () => ({ ok: true }) as never).getHeardFrom() });
    expect(await runHeardFromQuestion(garbled.deps)).toBe("not-asked");
  });

  test("failed writes after the question closed are only logged", async () => {
    const run = deps({ state: async () => ({ ask: true, settled: false }), choice: { answer: "youtube" }, fail: "writes" });
    expect(await runHeardFromQuestion(run.deps)).toBe("answered");
    expect(run.calls).toEqual(["shown", "asked", "answer youtube"]);
  });

  test("a sign-in marks its account once; taking the mark asks at most once", () => {
    markHeardFromDue("u1");
    expect(heardFromDueAccount()).toBe("u1");
    expect(takeHeardFromDue("u2")).toBe(false);
    expect(takeHeardFromDue("u1")).toBe(true);
    expect(takeHeardFromDue("u1")).toBe(false);
    expect(heardFromDueAccount()).toBeNull();
  });
});

describe("the service calls", () => {
  test("ask before email confirmation; Other sends other, and eligible follow-ups send note, cut to 120 characters", async () => {
    const sent: Array<[string, RequestInit | undefined]> = [];
    const api = new CloudHeardFromApi(async (path, options) => {
      sent.push([path, options]);
      return { ask: true, settled: false, outcome: null } as never;
    });
    expect(await api.getHeardFrom()).toEqual({ ask: true, settled: false });
    await api.reportHeardFromShown();
    await api.answerHeardFrom("search", "ignored");
    await api.answerHeardFrom("other", `  ${"\u{1F4FA}".repeat(130)}  `);
    await api.answerHeardFrom("other", "   ");
    await api.answerHeardFrom("instagram", "  @la_bourse\n en 5 min ");
    await api.answerHeardFrom("ai_assistant");
    await api.answerHeardFrom("ai_assistant", "図".repeat(121));
    await api.answerHeardFrom("x", "");
    await api.skipHeardFrom();
    expect(sent.map(([path, options]) => [path, options?.method ?? "GET", options?.body ?? null])).toEqual([
      ["/account/heard-from?unconfirmed=1", "GET", null],
      ["/account/heard-from/shown?unconfirmed=1", "POST", null],
      ["/account/heard-from", "POST", JSON.stringify({ answer: "search" })],
      ["/account/heard-from", "POST", JSON.stringify({ answer: "other", other: "\u{1F4FA}".repeat(120) })],
      ["/account/heard-from", "POST", JSON.stringify({ answer: "other" })],
      ["/account/heard-from", "POST", JSON.stringify({ answer: "instagram", note: "@la_bourse en 5 min" })],
      ["/account/heard-from", "POST", JSON.stringify({ answer: "ai_assistant" })],
      ["/account/heard-from", "POST", JSON.stringify({ answer: "ai_assistant", note: "図".repeat(120) })],
      ["/account/heard-from", "POST", JSON.stringify({ answer: "x" })],
      ["/account/heard-from", "POST", JSON.stringify({ skip: true })],
    ]);
  });
});

import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { explainRefusal, refusedLock } from "./cloud-denied";
import { proLockNote } from "./pro-lock-note";

const free = (ticker: string, company: string) => `gloomberb events ${ticker} lists ${company}'s earnings dates.`;

test("a lock note says what the function is, what a free reader can still run, and how to unlock it, to the wall the reader is behind", () => {
  const pane = { token: "CALLS", does: "it reads each call", shows: "it", free } as const;
  const signedOut = proLockNote({ gate: "sign-in", symbol: "KO" }, pane).split("\n");
  expect(signedOut).toEqual([
    "CALLS is part of Gloom Cloud Pro: it reads each call. Signed out it shows none of it.",
    "Free, with no sign-in: gloomberb events KO lists KO's earnings dates.",
    "To read it in CALLS, open the app (gloomberb), log in or sign up from the command bar (Ctrl+P, Log In or Sign Up), then upgrade (Ctrl+P, UPGRADE); gloomberb fn CALLS KO then reads with that session.",
  ]);
  expect(proLockNote({ gate: "sign-in", symbol: "KO", verifyEmail: true }, pane))
    .toContain("Until the email is verified it shows none of it.");
  expect(proLockNote({ gate: "sign-in", symbol: "KO", verifyEmail: true }, pane))
    .toContain("verify your email (Ctrl+P, Resend Verification Email), then upgrade");
  expect(proLockNote({ gate: "pro", symbol: null }, pane)).toContain("To read it in CALLS, upgrade in the app (gloomberb, then Ctrl+P, UPGRADE); gloomberb fn CALLS <ticker> then");
});

test("a function that needs only a sign-in says so, names no free route it does not have, and is Pro once the server refuses a plan", () => {
  const pane = { token: "BUZZ", does: "it counts posts", shows: "it", needs: "sign-in" } as const;
  expect(proLockNote({ gate: "sign-in", symbol: "KO" }, pane)).toBe([
    "BUZZ needs a free Gloom sign-in: it counts posts. Signed out it shows none of it.",
    "To read it in BUZZ, open the app (gloomberb), log in or sign up free from the command bar (Ctrl+P, Log In or Sign Up); gloomberb fn BUZZ KO then reads with that session.",
  ].join("\n"));
  expect(proLockNote({ gate: "pro", symbol: "KO" }, pane)).toContain("BUZZ is part of Gloom Cloud Pro: it counts posts. On a free account");
});

test("the command that reads with a session repeats the ticker only where the function takes one and the reader gave one", () => {
  const base = { token: "JOBS", does: "it reads jobs", shows: "it" } as const;
  expect(proLockNote({ gate: "sign-in", symbol: null }, { ...base, argument: "optional" })).toContain("gloomberb fn JOBS then reads");
  expect(proLockNote({ gate: "sign-in", symbol: "KO" }, { ...base, argument: "optional" })).toContain("gloomberb fn JOBS KO then reads");
  expect(proLockNote({ gate: "sign-in", symbol: "KO" }, { ...base, argument: "none" })).toContain("gloomberb fn JOBS then reads");
  // A pane that serves several functions names the one that was run.
  expect(proLockNote({ gate: "sign-in", symbol: "KO", token: "GUID" }, { ...base, token: "EM" })).toContain("GUID is part of Gloom Cloud Pro");
});

test("a refusal is found behind the errors written for the reader, and any other failure is no refusal", () => {
  const refusal = (status: number) => new ApiRequestError("Refused", status);
  expect(refusedLock(refusal(401))).toEqual({ gate: "sign-in" });
  expect(refusedLock(refusal(403))).toEqual({ gate: "sign-in", verifyEmail: true });
  expect(refusedLock(refusal(402))).toEqual({ gate: "pro" });
  expect(refusedLock(new Error("Wrapped", { cause: new Error("Twice", { cause: refusal(402) }) }))).toEqual({ gate: "pro" });
  expect(refusedLock(refusal(500))).toBeNull();
  expect(refusedLock("402")).toBeNull();

  const note = () => "Line one\nline two";
  const explained = explainRefusal(refusal(401), note, { symbol: null }) as Error;
  expect(explained.message).toBe("Line one line two");
  expect(explained.cause).toBeInstanceOf(ApiRequestError);
  const other = refusal(500);
  expect(explainRefusal(other, note, { symbol: null })).toBe(other);
});

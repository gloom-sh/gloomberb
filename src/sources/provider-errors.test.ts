import { expect, test } from "bun:test";
import { sourceDidNotAnswer, ApiRequestError } from "../api-client/errors";
import { OperationTimeoutError } from "../utils/async-deadline";
import {
  cleanProviderReason,
  createProviderMiss,
  isNoProviderMessage,
  isNoSourceAnswer,
  isSourceFailure,
  noProviderError,
  noteProviderAnswer,
  noteProviderMiss,
  notATickerSymbol,
  providerMissReason,
  shouldLogProviderError,
  type ProviderMissNote,
} from "./provider-errors";

test("a service reason is trimmed to one clean line of at most 200 characters", () => {
  expect(cleanProviderReason("  Spot gold is not quoted; GC=F is the front-month future.  "))
    .toBe("Spot gold is not quoted; GC=F is the front-month future.");
  expect(cleanProviderReason("First line.\r\n\n  Second\tline.")).toBe("First line. Second line.");
  // Escape sequences and reordering controls never reach a terminal.
  expect(cleanProviderReason("\u001b[31mNot quoted\u001b[0m\u0007 \u202eelbat\u202c\u0000")).toBe("Not quoted elbat");
  for (const missing of [undefined, null, 42, {}, "", "  \n\t ", "\u0000\u001b"]) expect(cleanProviderReason(missing)).toBeUndefined();

  const capped = cleanProviderReason(`${"word ".repeat(80)}tail`)!;
  expect(Array.from(capped)).toHaveLength(200);
  expect(capped.endsWith("…")).toBe(true);
  // A cap never splits a surrogate pair.
  expect(cleanProviderReason("😀".repeat(300))!.replace("…", "")).toBe("😀".repeat(199));
});

test("the final no-provider error carries a reason only when a provider gave one", () => {
  const withReason = noProviderError("No quote provider available for XAU/USD", { reason: "Spot gold is not quoted." });
  expect(withReason.message).toBe("Spot gold is not quoted.");
  expect(providerMissReason(withReason)).toBe("Spot gold is not quoted.");

  for (const note of [undefined, {}]) {
    const generic = noProviderError("No quote provider available for XAU/USD", note);
    expect(generic.message).toBe("No quote provider available for XAU/USD");
    expect(providerMissReason(generic)).toBeUndefined();
  }
  expect(providerMissReason(createProviderMiss("NOT_FOUND"))).toBeUndefined();
  expect(providerMissReason(new Error("Spot gold is not quoted."))).toBeUndefined();
});

test("the final error says not a ticker only while every provider that failed found no listing", () => {
  const notFound = () => createProviderMiss("NOT_FOUND", undefined, { notFound: true });
  const noted = (...errors: unknown[]): ProviderMissNote => {
    const note: ProviderMissNote = {};
    for (const error of errors) noteProviderMiss(note, error);
    return note;
  };
  const message = (note: ProviderMissNote, symbol?: string) => noProviderError("No quote provider available for APPLE", note, symbol).message;

  expect(message(noted(notFound()), "APPLE")).toBe("Not a ticker: APPLE.");
  expect(message(noted(notFound(), notFound()), "APPLE")).toBe("Not a ticker: APPLE.");
  // A timeout, a miss with no listing verdict, or an answer the router could not use all clear it, in any order.
  for (const errors of [[new Error("timed out")], [createProviderMiss("NO_DATA")], [notFound(), new Error("timed out")], [new Error("timed out"), notFound()]]) {
    expect(message(noted(...errors), "APPLE")).toBe("No quote provider available for APPLE");
  }
  const answered = noted(notFound());
  noteProviderAnswer(answered);
  expect(message(answered, "APPLE")).toBe("No quote provider available for APPLE");
  // Nothing was asked, or no symbol was given to name.
  expect(message({}, "APPLE")).toBe("No quote provider available for APPLE");
  expect(message(noted(notFound()))).toBe("No quote provider available for APPLE");
});

test("only the router's own words name a symbol as not a ticker", () => {
  expect(notATickerSymbol("Not a ticker: BRK.B.")).toBe("BRK.B");
  expect(notATickerSymbol("Not a ticker: APPLE INC.\nTry again")).toBe("APPLE INC");
  // A command can name the pair search offered after it.
  expect(notATickerSymbol("Not a ticker: USD_NGN. Did you mean USDNGN=X?")).toBe("USD_NGN");
  for (const text of ["No quote provider available for APPLE", "Not a ticker", "APPLE is not a ticker."]) expect(notATickerSymbol(text)).toBeNull();
  expect(isNoProviderMessage("No history provider available for 2222")).toBe(true);
  expect(isNoProviderMessage("Not a ticker: 2222.")).toBe(true);
  expect(isNoProviderMessage("request timed out")).toBe(false);
});

test("a miss raised by another copy of the module, as a plugin's can be, is still a miss", async () => {
  // A plugin that resolves gloomberb/market-data from the source tree gets its own copy of this module.
  const copy = await import(`./provider-errors.ts?copy=${Date.now()}`) as typeof import("./provider-errors");
  const foreign = copy.createProviderMiss("No quote for SIVE.", "No quote for SIVE.");
  expect(foreign).not.toBeInstanceOf((createProviderMiss("x") as Error).constructor);
  expect(shouldLogProviderError(foreign)).toBe(false);
  expect(providerMissReason(foreign)).toBe("No quote for SIVE.");
});

// A known listing whose source blinked read as one no source covers ("No quote provider available for YAR:OSL").
test("a data service that failed to answer, or answered too slowly, says so and to try again, never that no source covers the listing", () => {
  const failures = [sourceDidNotAnswer("UPSTREAM_ERROR"), new ApiRequestError("Bad gateway", 502),
    new OperationTimeoutError("Cloud market request timed out after 10000ms: /market/quotes/batch")];
  for (const failure of failures) {
    const note: ProviderMissNote = {};
    noteProviderMiss(note, failure);
    const error = noProviderError("No quote provider available for YAR:OSL", note, "YAR:OSL");
    expect(error.message).toBe("Gloom's data service did not answer for YAR:OSL. Try again in a moment.");
    expect(isNoProviderMessage(error.message)).toBe(false);
    expect(isSourceFailure(error)).toBe(true);
    expect(isNoSourceAnswer(error)).toBe(false);
  }
  // A refusal, a rate limit or another program's timeout keeps the router's words.
  for (const failure of [new ApiRequestError("Forbidden", 403), new ApiRequestError("Too many requests", 429), new OperationTimeoutError("13F filer status timed out after 5000ms")]) {
    const note: ProviderMissNote = {};
    noteProviderMiss(note, failure);
    expect(noProviderError("No quote provider available for YAR:OSL", note, "YAR:OSL").message).toBe("No quote provider available for YAR:OSL");
  }
});

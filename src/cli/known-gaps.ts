/**
 * Where data finer than a minute is: nowhere as bars. GIP draws 1-minute
 * bars and QR lists each trade, timestamped to the millisecond.
 */
export function subMinuteDataMessage(symbol = "<ticker>"): string {
  return `No second or tick bars; spread series are daily. 1-minute bars: gloomberb fn GIP ${symbol}. `
    + `Individual trades with ms timestamps: gloomberb fn QR ${symbol}.`;
}

/**
 * Data people look for under a name search cannot find: where the app has it,
 * or, while no source carries it, the nearest thing the app does have, with
 * the traded proxies either way. `search` and `catalog` answer a query that
 * names one with this line instead of pointing at each other. One entry per
 * subject; every proxy named is a listing `gloomberb quote` answers (checked
 * 2026-10-11: CO2:LSE is the physical EUA ETC, while a bare CO2 is a Brent
 * future) or a function `fn` runs.
 */
const KNOWN_GAPS: ReadonlyArray<{ terms: readonly string[]; message: string }> = [
  {
    terms: ["EUA", "EUAs", "EU ETS", "EU allowance", "EU allowances", "EU carbon", "carbon", "carbon allowance", "carbon allowances",
      "carbon price", "carbon prices", "carbon credits", "emission allowances", "emissions allowances"],
    message: "EU carbon (EUA): the auction price is in EPWR, chart CAP:carbon:eua. Traded proxies: CO2:LSE, KRBN.",
  },
  {
    terms: ["EU gas storage", "European gas storage", "Europe gas storage", "EU gas inventories", "European gas inventories",
      "AGSI", "AGSI+", "GIE AGSI", "gas storage Europe"],
    message: "European gas storage: EPWR GAS, or EPWR GAS DE for one country; chart CAP:gas-storage:eu. US storage is NGS.",
  },
  {
    terms: ["tick", "ticks", "tick data", "tick bars", "tick by tick", "second", "seconds", "second bars", "1s", "1 second",
      "1 second bars", "sub-minute", "sub minute bars", "subsecond"],
    message: subMinuteDataMessage(),
  },
];

/**
 * Topics a query asks the terminal about that no function covers, with the nearest functions that do part of it.
 * A query naming one (as a phrase, so "us defense budget 2027" does too) is answered with the pointer instead of
 * the loose matches its words would find: "budget" is OSA's hedge budget, not a defense one. One line per topic:
 * its name, the words that ask for it, and the function codes closest to it with what each gives. Drop a topic
 * once a function covers it.
 */
const TOPIC_POINTERS: ReadonlyArray<{
  topic: string;
  phrases: readonly string[];
  closest: ReadonlyArray<readonly [code: string, gives: string]>;
}> = [
  {
    topic: "defense budget",
    phrases: ["defense budget", "defence budget", "defense spending", "defence spending", "dod", "department of defense",
      "military budget", "military spending", "pentagon budget", "pentagon spending"],
    closest: [["AWARDS", "government contract awards by company"], ["THEM", "defense and aerospace theme: fn THEM defense"]],
  },
];

/** The words of a text, lower case: `DoD-budget` and `dod budget` read alike. */
function words(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

/** Whether `phrase` is a run of consecutive words in `query`. */
function containsWords(query: readonly string[], phrase: readonly string[]): boolean {
  for (let at = 0; at + phrase.length <= query.length; at += 1) {
    if (phrase.every((word, index) => query[at + index] === word)) return true;
  }
  return false;
}

/** The pointer for a query that asks about a topic no function covers, with the function codes it names. */
export function topicPointer(query: string): { message: string; codes: string[] } | null {
  const asked = words(query);
  const pointer = TOPIC_POINTERS.find(({ phrases }) => phrases.some((phrase) => containsWords(asked, words(phrase))));
  if (!pointer) return null;
  const closest = pointer.closest.map(([code, gives]) => `${code} (${gives})`).join(", ");
  return { message: `${pointer.topic}: not in the terminal yet; closest: ${closest}`, codes: pointer.closest.map(([code]) => code) };
}

/** Letters and digits only, lower case: `EU-ETS`, `eu ets` and `EUETS` are one lookup. */
function lookupKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The line for a query that names a known subject as a whole ("carbon allowances", "EUA") or asks about a topic with no function ("defense budget"), else null. */
export function knownGapMessage(query: string): string | null {
  const key = lookupKey(query);
  if (!key) return null;
  return KNOWN_GAPS.find((gap) => gap.terms.some((term) => lookupKey(term) === key))?.message ?? topicPointer(query)?.message ?? null;
}

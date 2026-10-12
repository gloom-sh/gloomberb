/**
 * Plain words the empty bar suggests as its placeholder, one per opening. Each
 * was typed into the bar signed out, in the terminal and on the web, and leads
 * with a row that answers it: the company, or the function of that name.
 * "apple earnings" is not here: signed out nothing matches it.
 */
const COMMAND_BAR_EXAMPLES = [
  "apple",
  "top news",
  "economic calendar",
  "nvidia",
  "yield curve",
] as const;

let nextExampleIndex = Math.floor(Math.random() * COMMAND_BAR_EXAMPLES.length);

/** The example for this opening of the bar; the next opening gets the next one. */
export function takeCommandBarExample(): string {
  const example = COMMAND_BAR_EXAMPLES[nextExampleIndex % COMMAND_BAR_EXAMPLES.length]!;
  nextExampleIndex = (nextExampleIndex + 1) % COMMAND_BAR_EXAMPLES.length;
  return example;
}

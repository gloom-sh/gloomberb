import { format } from "util";
import { asciiText } from "../utils/ascii-text";

const NON_ASCII = /[^\x00-\x7F]/;

type ConsoleMethod = "log" | "info" | "warn" | "error";
const CONSOLE_STREAMS: ReadonlyArray<readonly [ConsoleMethod, "stdout" | "stderr"]> = [
  ["log", "stdout"], ["info", "stdout"], ["warn", "stderr"], ["error", "stderr"],
];

/**
 * Writes the command's text in ASCII while `enabled` says so (`cliAsciiEnabled`:
 * plain output to a terminal that cannot show UTF-8), whichever way it is
 * written: `process.stdout.write`, `process.stderr.write` or the console, which
 * Bun writes without going through either stream. Tables are already ASCII
 * when they are drawn, so their columns line up (`renderTable`); this catches
 * the lines around them, such as a source line's `·`. A chunk that is not a
 * string (a PNG on stdout) passes as it is, and so does all output while
 * `enabled` is false.
 */
export function writeAsciiWhile(enabled: () => boolean): void {
  const needsAscii = (text: string) => NON_ASCII.test(text) && enabled();
  for (const name of ["stdout", "stderr"] as const) {
    const stream = process[name];
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => write(
      typeof chunk === "string" && needsAscii(chunk) ? asciiText(chunk) : chunk,
      ...rest,
    )) as typeof stream.write;
  }
  for (const [method, name] of CONSOLE_STREAMS) {
    const original = console[method].bind(console);
    console[method] = (...args: unknown[]) => {
      const text = format(...args);
      if (!needsAscii(text)) {
        original(...args);
        return;
      }
      process[name].write(`${asciiText(text)}\n`);
    };
  }
}

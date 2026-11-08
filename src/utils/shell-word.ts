/**
 * One word of a command line as a shell reads it back: as written when it
 * holds nothing a shell treats specially (`NVDA`, `SAN:EPA`, `BRK.B`), else
 * in single quotes (`'Altria Group'`, `'$nvda'`, `'AT&T'`).
 */
export function shellWord(word: string): string {
  return /^[\p{L}\p{N}._:@%+,/][\p{L}\p{N}._:@%+,/=-]*$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/**
 * A word of a command the CLI suggests, which may be run in cmd.exe or
 * PowerShell as well as a POSIX shell: as written when nothing in it is
 * special (`NVDA`, `SAN:EPA`), else in double quotes, which all three read as
 * typed (`"^SPX"`, `"Main Portfolio"`). cmd.exe reads `^` as its escape and
 * dropped it, so `gloom quote ^SPX` asked for SPX there. A word with a
 * character double quotes would expand is quoted as `shellWord` quotes it.
 */
export function commandWord(word: string): string {
  if (/^[\p{L}\p{N}._:@%+,/][\p{L}\p{N}._:@%+,/=-]*$/u.test(word)) return word;
  return /["$`!%\\]/.test(word) ? shellWord(word) : `"${word}"`;
}

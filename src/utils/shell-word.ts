/**
 * One word of a command line as a shell reads it back: as written when it
 * holds nothing a shell treats specially (`NVDA`, `SAN:EPA`, `BRK.B`), else
 * in single quotes (`'Altria Group'`, `'$nvda'`, `'AT&T'`).
 */
export function shellWord(word: string): string {
  return /^[\p{L}\p{N}._:@%+,/][\p{L}\p{N}._:@%+,/=-]*$/u.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

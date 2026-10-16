/**
 * The edits (insert, delete, replace, swap two neighbours) between two
 * strings, up to two; anything further apart is 2. One slip of the keys is
 * 1, so `RCDF` is one from `RDCF` and `USDNGM` one from `USDNGN`.
 */
export function typoDistance(left: string, right: string): number {
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > 1) return 2;
  const rows: number[][] = Array.from({ length: left.length + 1 }, (_, row) => [row, ...new Array<number>(right.length).fill(0)]);
  for (let column = 1; column <= right.length; column += 1) rows[0]![column] = column;
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const same = left[row - 1] === right[column - 1] ? 0 : 1;
      let best = Math.min(rows[row - 1]![column]! + 1, rows[row]![column - 1]! + 1, rows[row - 1]![column - 1]! + same);
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1]) {
        best = Math.min(best, rows[row - 2]![column - 2]! + 1);
      }
      rows[row]![column] = best;
    }
  }
  return Math.min(2, rows[left.length]![right.length]!);
}

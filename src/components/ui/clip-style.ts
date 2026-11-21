/**
 * One line of text that ends in an ellipsis where its box ends, in CSS, on the
 * desktop and the web: the browser clips it at the width it is laid out to,
 * which a count of columns cannot match (a cell is wider than a glyph).
 */
export const NATIVE_CLIP_STYLE = { display: "block", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "pre" } as const;

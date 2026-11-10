import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { countContentFigures } from "./content-figures";

function paneRoot(html: string): HTMLElement {
  const window = new Window();
  window.document.body.innerHTML = `<div id="root"><div data-gloom-role="pane-body">${html}</div></div>`;
  return window.document.getElementById("root") as unknown as HTMLElement;
}

const count = (root: HTMLElement) => countContentFigures(root, () => true);
const repeat = (times: number, html: (index: number) => string) => Array.from({ length: times }, (_, index) => html(index)).join("");

// Each text node with a digit was a figure, so one line React writes in pieces, or a labelled grid of
// "-" placeholders, passed `--strict` as a pane with content.
test("a pane's figures are counted by the blocks that show them, never by the labels over them", () => {
  // `Page {a} of {b}` and its like: one line, however React splits it into text nodes or spans.
  const pieces = paneRoot("<div></div><div>Updated <span>10</span>:<span>32</span> on <span>3</span> of <span>4</span></div>");
  const line = pieces.querySelector("[data-gloom-role=\"pane-body\"] > div")!;
  for (const text of ["Page ", "1", " of ", "4", " · ", "2", " · ", "3"]) line.appendChild(pieces.ownerDocument.createTextNode(text));
  expect(count(pieces)).toBe(2);

  // Labels with digits over placeholders: a table's header and labelled values.
  const placeholders = paneRoot(
    `<table><thead><tr>${repeat(4, (index) => `<th>${index + 1}0Y</th>`)}</tr></thead><tbody><tr>${repeat(4, () => "<td>-</td>")}</tr></tbody></table>`
    + `<div data-gloom-role="data-table-header-row">${repeat(4, (index) => `<div data-gloom-role="data-table-header-cell">${index + 1}M</div>`)}</div>`
    + repeat(4, (index) => `<div data-gloom-ui="key-value-row"><div>${index + 5}2W High</div><div>-</div></div>`)
    + repeat(4, (index) => `<div data-gloom-role="stat-grid-cell"><div>Q${index + 1}</div><div>-</div></div>`),
  );
  expect(count(placeholders)).toBe(0);

  // Data: prose with figures, and labelled values that hold them.
  const prose = paneRoot(repeat(3, (index) => `<p>Revenue rose ${index + 10}% to <b>$${index + 2}.1B</b>.</p>`)
    + repeat(2, (index) => `<div data-gloom-ui="key-value-row"><div>${index + 5}2W High</div><div>${index + 180}.20</div></div>`));
  expect(count(prose)).toBe(5);
  // Controls and states are not data.
  expect(count(paneRoot(repeat(6, (index) => `<button>${index}M</button>`) + `<div data-gloom-ui="empty-state">No rows since 2024</div>`))).toBe(0);

  // The browser runner evaluates the serialized function, which must carry no import.
  const evaluated = new Function(`return (${countContentFigures.toString()})`)() as typeof countContentFigures;
  expect(evaluated(prose, () => true)).toBe(5);
});

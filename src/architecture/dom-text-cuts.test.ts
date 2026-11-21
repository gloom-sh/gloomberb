import { expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  collectDomTextCuts,
  countDomTextCuts,
  findDomTextCutsIn,
  formatDomTextCutsAllowlist,
  type DomTextCutsEntry,
} from "../../scripts/update-dom-text-cuts-allowlist";

const ROOT = resolve(import.meta.dir, "../..");
const ALLOWLIST = new URL("./dom-text-cuts-allowlist.json", import.meta.url);
const UPDATE = "bun scripts/update-dom-text-cuts-allowlist.ts";

test("the desktop and the web get no more text cut to a count of cells than they did", async () => {
  const allowlist: Record<string, DomTextCutsEntry> = await Bun.file(ALLOWLIST).json();
  const found = collectDomTextCuts(ROOT);
  const current = countDomTextCuts(found);
  const grown = Object.entries(current)
    .filter(([file, count]) => count > (allowlist[file]?.uses ?? 0))
    .map(([file, count]) => `${file}: ${count} (allowed ${allowlist[file]?.uses ?? 0})\n${found
      .filter((cut) => cut.file === file)
      .map((cut) => `  ${file}:${cut.line} ${cut.cut}`)
      .join("\n")}`);
  const shrunk = Object.entries(allowlist)
    .filter(([file, entry]) => (current[file] ?? 0) < entry.uses)
    .map(([file, entry]) => `${file}: ${current[file] ?? 0} (allowlist says ${entry.uses})`);
  const failures: string[] = [];
  if (grown.length) {
    failures.push("Text cut to a count of cells where the desktop and the web draw it:\n" + grown.join("\n")
      + "\nThe desktop and the web cut a line where its box ends, in CSS: pass the whole string to ClippedText"
      + " (with the terminal's own `cut`, `lead` or `keepEnd`), or keep the cut in the terminal's branch"
      + " (`nativePaneChrome ? text : truncateToDisplayWidth(text, width)`). See docs/pane-conventions.md, \"Text that may not fit\".");
  }
  if (shrunk.length) {
    failures.push("Fewer cuts than the allowlist records:\n" + shrunk.join("\n")
      + `\nRun \`${UPDATE}\` so the allowance goes down with them.`);
  }
  if (failures.length) throw new Error(failures.join("\n\n"));
});

test("the DOM text cuts allowlist is sorted, names existing files and says why each stays", async () => {
  const text = await Bun.file(ALLOWLIST).text();
  const allowlist: Record<string, DomTextCutsEntry> = JSON.parse(text);
  expect(text, `Run \`${UPDATE}\` to sort the allowlist.`).toBe(formatDomTextCutsAllowlist(allowlist));
  for (const [file, entry] of Object.entries(allowlist)) {
    expect(await Bun.file(resolve(ROOT, file)).exists(), `${file} does not exist. Run \`${UPDATE}\`.`).toBe(true);
    expect(entry.why.trim(), `${file}: say in "why" why its cuts stay (a length cap on data, a cut CSS cannot make).`).not.toBe("");
  }
});

test("a cut counts where the desktop and the web can reach it, not in the terminal's branch", () => {
  const cuts = findDomTextCutsIn({
    "src/pane.tsx": `
      import { truncateToDisplayWidth as cut } from "../utils/format";
      import { truncateWithEllipsis } from "../utils/text-wrap";

      // A function of ours that returns a cut is one: its callers count, not the cuts inside it.
      function label(text: string, width: number) {
        const short = truncateWithEllipsis(text, width - 2);
        return \`\${cut(short, width)}:\`;
      }

      export function Row({ name, note, width }) {
        const { nativePaneChrome: desktop } = useUiCapabilities();
        const plain = !desktop;
        if (plain) return <Text>{cut(name, width)}</Text>;
        return (
          <Box>
            <Text>{label(name, width)}</Text>
            <Text>{desktop ? note : cut(note, width)}</Text>
            <Text>{\`\${note.slice(0, width - 1)}…\`}</Text>
            <ClippedText text={name} width={width} cut={(text, room) => truncateWithEllipsis(text, room)} />
          </Box>
        );
      }

      function terminalHeading(title: string, width: number) {
        return <Text>{cut(title, width)}</Text>;
      }
    `,
    "src/other.tsx": `
      // A name of the file's own is not the cut it shadows.
      function padTo(value: string) { return value; }
      export const Cell = ({ value }) => <Text>{padTo(value)}</Text>;
    `,
  });
  expect(cuts.map(({ line, cut }) => `${line} ${cut}`)).toEqual(["17 label", "19 slice and …"]);
});

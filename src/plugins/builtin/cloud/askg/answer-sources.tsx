import {
  DesktopPaneLinkChip,
  TerminalPaneLinkChip,
  type PaneLinkChipContent,
} from "../../../../components/ui";
import { useThemeColors } from "../../../../theme/theme-context";
import { Box, Text, useUiCapabilities } from "../../../../ui";
import { formatSourceCommand, type ASKGAnswerSource } from "./sources";
import { describeToolRow, type ToolDisplayContext } from "./tool-display";

/**
 * What one source's chip says: the function, ticker and options that show it
 * and the pane that is, with its number in the chip's square, the square its
 * citations in the answer are drawn as. A read no pane shows, or a number no
 * read carries, says so.
 */
export function answerSourceChip(source: ASKGAnswerSource, context: ToolDisplayContext): PaneLinkChipContent {
  const icon = source.ref === null ? source.target.kind === "pane" ? source.target.icon : "" : String(source.ref);
  if (source.target.kind === "pane") {
    return { title: formatSourceCommand(source.target.command), detail: source.target.label, icon };
  }
  if (!source.row) return { title: "Not found", detail: "No read carries this number", icon };
  const view = describeToolRow(source.row, context);
  return { title: [view.title, view.subject].filter(Boolean).join(" "), detail: "No pane shows this read", icon };
}

/** One source as a line of text: `[2] HP NVDA --range 6M`, or what was read when no pane shows it. */
export function answerSourceLabel(source: ASKGAnswerSource, context: ToolDisplayContext): string {
  const ref = source.ref === null ? "" : `[${source.ref}] `;
  const chip = answerSourceChip(source, context);
  return source.target.kind === "pane" ? `${ref}${chip.title}` : `${ref}${chip.title}, ${chip.detail.toLowerCase()}`;
}

/**
 * The sources under an answer, each the chip a pane shared in chat is: its
 * number, the function, ticker and options that show it, and the pane, opened
 * by a press as a shared pane opens. A cited read that no pane shows, or a
 * number no read carries, is the same chip saying so, and opens nothing; an
 * answer with figures that read no data says that instead.
 */
export function AnswerSources({
  sources,
  readNothing,
  width,
  context,
  onOpen,
}: {
  sources: readonly ASKGAnswerSource[];
  readNothing: boolean;
  width: number;
  context: ToolDisplayContext;
  onOpen: (source: ASKGAnswerSource) => void;
}) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  if (sources.length === 0) {
    return readNothing ? (
      <Box paddingTop={1}>
        <Text fg={colors.textMuted}>No sources: this answer read no data</Text>
      </Box>
    ) : null;
  }
  const chips = sources.map((source, index) => ({
    key: `${source.ref ?? "read"}:${index}`,
    content: answerSourceChip(source, context),
    open: source.target.kind === "pane" ? () => onOpen(source) : undefined,
    linkKey: source.target.kind === "pane" ? `source:${formatSourceCommand(source.target.command)}` : "source:none",
  }));
  if (nativePaneChrome) {
    return (
      <Box
        flexDirection="row"
        flexWrap="wrap"
        paddingTop={1}
        data-gloom-role="askg-answer-sources"
        style={{ columnGap: "var(--gloom-space-sm)", alignItems: "flex-start" }}
      >
        {chips.map((chip) => (
          <DesktopPaneLinkChip
            key={chip.key}
            content={chip.content}
            variant="card"
            fit
            dimmed={!chip.open}
            onOpen={chip.open}
            role="askg-source-chip"
            linkKey={chip.linkKey}
          />
        ))}
      </Box>
    );
  }
  return (
    <Box flexDirection="row" flexWrap="wrap" paddingTop={1} width={width}>
      {chips.map((chip) => (
        <Box key={chip.key} flexDirection="row" marginRight={1}>
          <TerminalPaneLinkChip content={chip.content} width={width} onOpen={chip.open} />
        </Box>
      ))}
    </Box>
  );
}

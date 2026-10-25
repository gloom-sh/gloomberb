import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useUiHost } from "../../ui";
import { type PromptContext, useDialogKeyboard } from "../../ui/dialog";
import { useThemeColors } from "../../theme/theme-context";
import { t } from "../../i18n";
import { DialogFrame, fitDialogWidth } from "./frame";
import { ListView, listCursorMove, type ListViewItem } from "./list-view";
import { clampIndex } from "../../utils/math";
import { withChoiceGroupHeadings } from "./choice-groups";

export interface ChoiceDialogChoice {
  id: string;
  label: string;
  /** Heading for consecutive choices in the same group. */
  group?: string;
  description?: string;
  detail?: string;
  disabled?: boolean;
  /** Tints the label, e.g. a status in its tone. */
  color?: string;
}

export interface ChoiceDialogProps extends PromptContext<string> {
  title: string;
  choices: ChoiceDialogChoice[];
  selectedChoiceId?: string;
  footer?: string;
  bgColor?: string;
}

const MAX_VISIBLE_CHOICE_ROWS = 12;

function getChoiceDescription(choice: ChoiceDialogChoice | undefined): string {
  return choice?.description ?? "";
}

function getInitialChoiceIndex(choices: ListViewItem[], selectedChoiceId: string | undefined): number {
  if (!selectedChoiceId) return choices.findIndex((choice) => !choice.disabled);
  const selectedIndex = choices.findIndex((choice) => choice.id === selectedChoiceId && choice.kind !== "heading");
  return selectedIndex >= 0 ? selectedIndex : choices.findIndex((choice) => choice.kind !== "heading");
}

function choiceDialogWidth(title: string, choices: ChoiceDialogChoice[]): number {
  const contentWidth = Math.max(
    title.length,
    ...choices.map((choice) => choice.label.length + (choice.detail ? choice.detail.length + 4 : 0)),
    ...choices.map((choice) => getChoiceDescription(choice).length),
    ...choices.map((choice) => choice.group?.length ?? 0),
  );
  return Math.max(34, Math.min(76, contentWidth + 4));
}

export function ChoiceDialog({
  resolve,
  title,
  choices,
  selectedChoiceId,
  footer,
  bgColor,
}: ChoiceDialogProps) {
  const colors = useThemeColors();
  const desktop = useUiHost().kind === "desktop-web";
  const items = useMemo<ListViewItem[]>(() => withChoiceGroupHeadings(choices.map((choice) => ({
    id: choice.id,
    label: choice.label,
    group: choice.group,
    description: getChoiceDescription(choice),
    detail: choice.detail,
    disabled: choice.disabled,
    color: choice.color,
  }))), [choices]);
  const [index, setIndex] = useState(() =>
    clampIndex(getInitialChoiceIndex(items, selectedChoiceId), items.length, -1)
  );
  const selectedIndex = clampIndex(index, items.length, -1);
  const selectedChoice = selectedIndex >= 0 ? items[selectedIndex] : undefined;
  // Terminal input can deliver navigation and Enter before React renders.
  const cursor = useRef(selectedIndex);
  const selectIndex = (next: number) => { cursor.current = next; setIndex(next); };
  const width = useMemo(() => choiceDialogWidth(title, choices), [choices, title]);

  useEffect(() => {
    selectIndex(clampIndex(cursor.current, items.length, -1));
  }, [items.length]);

  const activateChoice = (choice: ChoiceDialogChoice | undefined) => {
    if (!choice || choice.disabled) return;
    resolve(choice.id);
  };

  useDialogKeyboard((event) => {
    event.stopPropagation();
    const move = listCursorMove(event, MAX_VISIBLE_CHOICE_ROWS - 1);
    if (move) {
      selectIndex(move(items, cursor.current));
    } else if (event.name === "enter" || event.name === "return") {
      activateChoice(items[clampIndex(cursor.current, items.length, -1)]);
    } else if (event.name === "escape") {
      resolve("");
    }
  });

  return (
    <DialogFrame title={title} footer={footer} showTitleDivider={false}>
      {/* Never wider than the dialog: the terminal's box is 60 columns, a phone narrower than the cells asked for. */}
      <Box flexDirection="column" {...(desktop ? { style: { width: fitDialogWidth(width) } } : { width, maxWidth: "100%" })}>
        <ListView
          items={items}
          selectedIndex={selectedIndex}
          bgColor={bgColor ?? colors.bg}
          emptyMessage={t("No choices.")}
          rowGap={0}
          surface="framed"
          height={Math.min(Math.max(items.length, 1), MAX_VISIBLE_CHOICE_ROWS)}
          scrollable={items.length > MAX_VISIBLE_CHOICE_ROWS}
          selectOnHover
          onSelect={selectIndex}
          onActivate={activateChoice}
        />
        <Box height={1} />
        <Text fg={colors.textDim} wrapText>{getChoiceDescription(selectedChoice)}</Text>
      </Box>
    </DialogFrame>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useUiHost, type InputRenderable } from "../../ui";
import { type PromptContext, useDialogKeyboard } from "../../ui/dialog";
import { useThemeColors } from "../../theme/theme-context";
import { t } from "../../i18n";
import { DialogFrame, fitDialogWidth } from "./frame";
import { ListView, listCursorMove, type ListViewItem } from "./list-view";
import { clampIndex } from "../../utils/math";
import { withChoiceGroupHeadings } from "./choice-groups";
import { TextField } from "./fields";
import { isTextKey } from "../../utils/keyboard";

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

/** What typing in a long list's filter box matches: the words on the row and its group. */
function matchesChoice(choice: ChoiceDialogChoice, needle: string): boolean {
  return [choice.label, choice.group, choice.description, choice.detail]
    .some((text) => text?.toLowerCase().includes(needle));
}

/** The first row Enter can choose. */
function firstChoiceIndex(items: ListViewItem[]): number {
  return items.findIndex((item) => item.kind !== "heading" && !item.disabled);
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
  // A list longer than its rows gets a filter box over it in the terminal, as a long
  // multi-select has (review, 12 Nov 2026: EQS's forty fields had none).
  const searchable = !desktop && choices.length > MAX_VISIBLE_CHOICE_ROWS;
  const [filter, setFilter] = useState("");
  const filterRef = useRef<InputRenderable | null>(null);
  const needle = searchable ? filter.trim().toLowerCase() : "";
  const shownChoices = useMemo(() => (needle ? choices.filter((choice) => matchesChoice(choice, needle)) : choices), [choices, needle]);
  const items = useMemo<ListViewItem[]>(() => withChoiceGroupHeadings(shownChoices.map((choice) => ({
    id: choice.id,
    label: choice.label,
    group: choice.group,
    description: getChoiceDescription(choice),
    detail: choice.detail,
    disabled: choice.disabled,
    color: choice.color,
  }))), [shownChoices]);
  const [index, setIndex] = useState(() =>
    clampIndex(getInitialChoiceIndex(items, selectedChoiceId), items.length, -1)
  );
  const selectedIndex = clampIndex(index, items.length, -1);
  const selectedChoice = selectedIndex >= 0 ? items[selectedIndex] : undefined;
  // Terminal input can deliver navigation and Enter before React renders.
  const cursor = useRef(selectedIndex);
  const selectIndex = (next: number) => { cursor.current = next; setIndex(next); };
  const width = useMemo(() => choiceDialogWidth(title, choices), [choices, title]);
  // The line under the list is kept only by a dialog whose choices say something there, so it is never a blank row.
  const described = useMemo(() => items.some((item) => !!item.description), [items]);

  useEffect(() => {
    selectIndex(clampIndex(cursor.current, items.length, -1));
  }, [items.length]);
  // A narrowed list starts on its first match.
  useEffect(() => {
    if (needle) selectIndex(firstChoiceIndex(items));
  }, [items, needle]);

  const activateChoice = (choice: ChoiceDialogChoice | undefined) => {
    if (!choice || choice.disabled) return;
    resolve(choice.id);
  };

  useDialogKeyboard((event) => {
    if (searchable) {
      // The box owns every key that types or edits text; the list keeps the rest, Home and End too.
      const typing = event.targetEditable === true;
      const editsText = isTextKey(event)
        || (typing && ["backspace", "delete", "left", "right"].includes(event.name ?? ""));
      const backsUp = !typing && filter !== "" && (event.name === "backspace" || event.name === "delete");
      if (editsText || backsUp) {
        if (!typing) filterRef.current?.focus?.();
        return;
      }
    }
    event.stopPropagation();
    const move = listCursorMove(event, MAX_VISIBLE_CHOICE_ROWS - 1);
    if (move) {
      selectIndex(move(items, cursor.current));
    } else if (event.name === "enter" || event.name === "return") {
      activateChoice(items[clampIndex(cursor.current, items.length, -1)]);
    } else if (event.name === "escape") {
      resolve("");
    }
  }, searchable ? { allowEditable: true } : undefined);

  return (
    <DialogFrame title={title} footer={footer} showTitleDivider={false}>
      {/* Never wider than the dialog: a phone is narrower than the cells asked for. The terminal's list spans its box,
          60 columns, so its scrollbar runs down the box's edge rather than through the middle of it. */}
      <Box flexDirection="column" {...(desktop ? { style: { width: fitDialogWidth(width) } } : { width: "100%" })}>
        {searchable ? (
          <Box marginBottom={1}>
            <TextField inputRef={filterRef} value={filter} placeholder="Filter" focused onChange={setFilter} />
          </Box>
        ) : null}
        <ListView
          items={items}
          selectedIndex={selectedIndex}
          bgColor={bgColor ?? colors.bg}
          emptyMessage={t(needle ? "No matches" : "No choices.")}
          remoteLabel={title}
          rowGap={0}
          surface="framed"
          // Held at the whole list's height, so the dialog does not jump as the filter narrows it.
          height={searchable ? MAX_VISIBLE_CHOICE_ROWS : Math.min(Math.max(items.length, 1), MAX_VISIBLE_CHOICE_ROWS)}
          scrollable={items.length > MAX_VISIBLE_CHOICE_ROWS}
          selectOnHover
          onSelect={selectIndex}
          onActivate={activateChoice}
        />
        {described ? (
          <>
            <Box height={1} />
            <Text fg={colors.textDim} wrapText>{getChoiceDescription(selectedChoice)}</Text>
          </>
        ) : null}
      </Box>
    </DialogFrame>
  );
}

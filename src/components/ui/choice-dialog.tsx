import { useEffect, useMemo, useState } from "react";
import { Box, Text } from "../../ui";
import { type PromptContext, useDialogKeyboard } from "../../ui/dialog";
import { useThemeColors } from "../../theme/theme-context";
import { t } from "../../i18n";
import { isPlainKey } from "../../utils/keyboard";
import { DialogFrame } from "./frame";
import { ListView, type ListViewItem } from "./list-view";

export interface ChoiceDialogChoice {
  id: string;
  label: string;
  description?: string;
  detail?: string;
  disabled?: boolean;
}

export interface ChoiceDialogProps extends PromptContext<string> {
  title: string;
  choices: ChoiceDialogChoice[];
  selectedChoiceId?: string;
  footer?: string;
  bgColor?: string;
}

const MAX_VISIBLE_CHOICE_ROWS = 12;

function clampChoiceIndex(index: number, length: number): number {
  if (length <= 0) return -1;
  return Math.max(0, Math.min(length - 1, index));
}

function getChoiceDescription(choice: ChoiceDialogChoice | undefined): string {
  return choice?.description ?? "";
}

function getInitialChoiceIndex(choices: ChoiceDialogChoice[], selectedChoiceId: string | undefined): number {
  if (!selectedChoiceId) return choices.findIndex((choice) => !choice.disabled);
  const selectedIndex = choices.findIndex((choice) => choice.id === selectedChoiceId);
  return selectedIndex >= 0 ? selectedIndex : 0;
}

function choiceDialogWidth(title: string, choices: ChoiceDialogChoice[]): number {
  const contentWidth = Math.max(
    title.length,
    ...choices.map((choice) => choice.label.length + (choice.detail ? choice.detail.length + 4 : 0)),
    ...choices.map((choice) => getChoiceDescription(choice).length),
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
  const [index, setIndex] = useState(() =>
    clampChoiceIndex(getInitialChoiceIndex(choices, selectedChoiceId), choices.length)
  );
  const selectedIndex = clampChoiceIndex(index, choices.length);
  const selectedChoice = selectedIndex >= 0 ? choices[selectedIndex] : undefined;
  const items = useMemo<ListViewItem[]>(() => choices.map((choice) => ({
    id: choice.id,
    label: choice.label,
    description: getChoiceDescription(choice),
    detail: choice.detail,
    disabled: choice.disabled,
  })), [choices]);
  const width = useMemo(() => choiceDialogWidth(title, choices), [choices, title]);

  useEffect(() => {
    setIndex((current) => clampChoiceIndex(current, choices.length));
  }, [choices.length]);

  const activateChoice = (choice: ChoiceDialogChoice | undefined) => {
    if (!choice || choice.disabled) return;
    resolve(choice.id);
  };
  const moveSelection = (direction: -1 | 1) => {
    setIndex((current) => {
      for (let next = current + direction; next >= 0 && next < choices.length; next += direction) {
        if (!choices[next]?.disabled) return next;
      }
      return current;
    });
  };

  useDialogKeyboard((event) => {
    event.stopPropagation();
    if (isPlainKey(event, "up", "k")) {
      moveSelection(-1);
    } else if (isPlainKey(event, "down", "j")) {
      moveSelection(1);
    } else if (event.name === "enter" || event.name === "return") {
      activateChoice(selectedChoice);
    } else if (event.name === "escape") {
      resolve("");
    }
  });

  return (
    <DialogFrame title={title} footer={footer} showTitleDivider={false}>
      <Box flexDirection="column" width={width}>
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
          onSelect={setIndex}
          onActivate={(_, nextIndex) => activateChoice(choices[nextIndex])}
        />
        <Box height={1} />
        <Text fg={colors.textDim} wrapText width={width}>{getChoiceDescription(selectedChoice)}</Text>
      </Box>
    </DialogFrame>
  );
}

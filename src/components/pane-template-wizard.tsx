import { Box, Text, Textarea } from "../ui";
import { useEffect, useRef, useState } from "react";
import { type InputRenderable, type TextareaRenderable } from "../ui";
import { type AlertContext, type PromptContext, useDialogKeyboard } from "../ui/dialog";
import type { WizardStep } from "../types/plugin";
import { colors } from "../theme/colors";
import { isPlainKey } from "../utils/keyboard";
import { DialogFrame, ListView, TextField } from "./ui";
import { t } from "../i18n";

export function PaneTemplateInfoStep({
  dismiss,
  dialogId,
  step,
}: AlertContext & { step: WizardStep }) {
  useDialogKeyboard((event) => {
    event.stopPropagation();
    if (event.name === "return" || event.name === "enter" || event.name === "escape") {
      dismiss();
    }
  }, dialogId);

  return (
    <DialogFrame title={step.label} footer="Press Enter to continue">
      <Box flexDirection="column">
        {step.body?.map((line, index) => (
          <Box key={`${step.key}:${index}`} height={1}>
            <Text fg={colors.textDim}>{line ? t(line) : " "}</Text>
          </Box>
        ))}
      </Box>
    </DialogFrame>
  );
}

export function PaneTemplateInputStep({
  resolve,
  step,
}: PromptContext<string> & { step: WizardStep }) {
  const inputRef = useRef<InputRenderable>(null);
  const [value, setValue] = useState(step.defaultValue ?? "");

  useEffect(() => {
    inputRef.current?.focus?.();
  }, []);

  return (
    <DialogFrame
      title={step.label}
      footer={step.defaultValue
        ? `Press Enter to use ${step.defaultValue}`
        : step.required === false
          ? "Enter to keep the default"
          : "Enter to continue"}
    >
      <Box flexDirection="column">
        {step.body?.map((line, index) => (
          <Box key={`${step.key}:${index}`} height={1}>
            <Text fg={colors.textDim}>{line ? t(line) : " "}</Text>
          </Box>
        ))}
        <Box height={1} />
        <TextField
          inputRef={inputRef}
          value={value}
          placeholder={step.placeholder ? t(step.placeholder) : ""}
          type={step.type === "password" ? "password" : "text"}
          focused
          onChange={setValue}
          onSubmit={(submittedValue) => {
            const submitted = submittedValue.trim() || step.defaultValue || "";
            if (submitted || step.required === false) resolve(submitted);
          }}
        />
      </Box>
    </DialogFrame>
  );
}

export function PaneTemplateTextareaStep({
  resolve,
  step,
  dialogId,
}: PromptContext<string> & { step: WizardStep }) {
  const textareaRef = useRef<TextareaRenderable>(null);

  useEffect(() => {
    textareaRef.current?.focus?.();
  }, []);

  useDialogKeyboard((event) => {
    event.stopPropagation();
    if (event.name === "escape") {
      resolve("");
      return;
    }
    if (event.ctrl && event.name === "s") {
      const submitted = textareaRef.current?.editBuffer.getText().trim() || step.defaultValue || "";
      if (submitted) resolve(submitted);
    }
  }, { scope: dialogId, allowEditable: true });

  const commit = () => {
    const submitted = textareaRef.current?.editBuffer.getText().trim() || step.defaultValue || "";
    if (submitted) resolve(submitted);
  };

  return (
    <DialogFrame
      title={step.label}
      footer="Ctrl+S save · Esc cancel"
    >
      <Box flexDirection="column" flexGrow={1}>
        {step.body?.map((line, index) => (
          <Box key={`${step.key}:${index}`} height={1}>
            <Text fg={colors.textDim}>{line ? t(line) : " "}</Text>
          </Box>
        ))}
        <Box height={1} />
        <Box
          flexGrow={1}
          minHeight={8}
          border
          borderColor={colors.border}
          backgroundColor={colors.panel}
        >
          <Textarea
            ref={textareaRef}
            initialValue={step.defaultValue ?? ""}
            placeholder={step.placeholder ? t(step.placeholder) : ""}
            focused
            textColor={colors.text}
            placeholderColor={colors.textDim}
            backgroundColor={colors.panel}
            flexGrow={1}
            wrapText
          />
        </Box>
        <Box height={1} />
        <Box flexDirection="row" gap={1}>
          <Box
            backgroundColor={colors.selected}
            onMouseDown={commit}
          >
            <Text fg={colors.selectedText}>{` ${t("Save")} `}</Text>
          </Box>
          <Box
            backgroundColor={colors.panel}
            onMouseDown={() => resolve("")}
          >
            <Text fg={colors.text}>{` ${t("Cancel")} `}</Text>
          </Box>
        </Box>
      </Box>
    </DialogFrame>
  );
}

export function PaneTemplateSelectStep({
  resolve,
  step,
  dialogId,
}: PromptContext<string> & { step: WizardStep }) {
  const options = step.options ?? [];
  const [selectedIndex, setSelectedIndex] = useState(() => {
    const defaultIndex = step.defaultValue
      ? options.findIndex((option) => option.value === step.defaultValue)
      : -1;
    return defaultIndex >= 0 ? defaultIndex : 0;
  });

  useDialogKeyboard((event) => {
    event.stopPropagation();
    if (isPlainKey(event, "up", "k")) {
      setSelectedIndex((index) => Math.max(0, index - 1));
    } else if (isPlainKey(event, "down", "j")) {
      setSelectedIndex((index) => Math.min(options.length - 1, index + 1));
    } else if (event.name === "return" || event.name === "enter") {
      resolve(options[selectedIndex]?.value ?? "");
    } else if (event.name === "escape") {
      resolve("");
    }
  }, dialogId);

  return (
    <DialogFrame title={step.label} footer="Use ↑↓ to choose · enter to select · esc to cancel">
      <Box flexDirection="column">
        {step.body?.map((line, index) => (
          <Box key={`${step.key}:${index}`} height={1}>
            <Text fg={colors.textDim}>{line ? t(line) : " "}</Text>
          </Box>
        ))}
        <Box height={1} />
        <ListView
          items={options.map((option) => ({
            id: option.value,
            label: t(option.label),
          }))}
          selectedIndex={selectedIndex}
          bgColor={colors.commandBg}
          onSelect={setSelectedIndex}
          onActivate={(item) => resolve(item.id)}
        />
      </Box>
    </DialogFrame>
  );
}

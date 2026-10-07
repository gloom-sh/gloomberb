import { Box, Text } from "../ui";
import { useEffect, useRef, useState } from "react";
import { type InputRenderable } from "../ui";
import { type PromptContext } from "../ui/dialog";
import type { WizardStep } from "../types/plugin";
import { colors } from "../theme/colors";
import { DialogFrame, TextField } from "./ui";
import { t } from "../i18n";

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

import { Box, Input, Text } from "gloomberb/ui";
import { TextAttributes } from "gloomberb/ui";
import { type InputRenderable } from "gloomberb/ui";
import { useEffect, useRef, useState } from "react";
import { type PromptContext } from "gloomberb/dialog";
import type { WizardStep } from "gloomberb/types/plugin";
import { colors } from "gloomberb/theme";

export { ChoiceDialog } from "gloomberb/components";

export function InputDialog({ resolve, step }: PromptContext<string> & { step: WizardStep }) {
  const inputRef = useRef<InputRenderable>(null);
  const [value, setValue] = useState("");

  useEffect(() => {
    inputRef.current?.focus?.();
  }, []);

  return (
    <Box flexDirection="column">
      <Text attributes={TextAttributes.BOLD} fg={colors.text}>{step.label}</Text>
      <Box height={1} />
      {step.body?.map((line, index) => (
        <Text key={index} fg={colors.textDim}>{line || " "}</Text>
      ))}
      <Box height={1} />
      <Input
        ref={inputRef}
        focused
        placeholder={step.placeholder || ""}
        textColor={colors.text}
        placeholderColor={colors.textDim}
        backgroundColor={colors.bg}
        onInput={(nextValue: string) => setValue(nextValue)}
        onChange={(nextValue: string) => setValue(nextValue)}
        onSubmit={() => resolve(value.trim())}
      />
    </Box>
  );
}

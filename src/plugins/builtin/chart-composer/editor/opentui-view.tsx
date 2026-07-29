import { type ReactNode } from "react";
import { Box, Text } from "../../../../ui";
import { SegmentedControl } from "../../../../components";
import { Button } from "../../../../components/ui";
import { colors } from "../../../../theme/colors";
import type {
  SeriesEditorActionModel,
  SeriesEditorFieldModel,
  SeriesEditorFocus,
} from "./model";

function TuiEditorField({
  label,
  focused,
  onFocus,
  children,
}: {
  label: string;
  focused: boolean;
  onFocus: () => void;
  children: ReactNode;
}) {
  return (
    <Box
      flexDirection="column"
      width="100%"
      overflow="hidden"
      onMouseDown={onFocus}
    >
      <Text fg={focused ? colors.textBright : colors.textDim}>
        {focused ? `› ${label}` : label}
      </Text>
      {children}
    </Box>
  );
}

export function OpenTuiSeriesEditorFields({
  fields,
  keyboardFocus,
  dialogId,
  onFocus,
}: {
  fields: SeriesEditorFieldModel[];
  keyboardFocus: SeriesEditorFocus;
  dialogId?: string;
  onFocus: (focus: SeriesEditorFocus) => void;
}) {
  return (
    <>
      {fields.map((field) => {
        const focused = keyboardFocus === field.id;
        return (
          <TuiEditorField
            key={field.id}
            label={field.label}
            focused={focused}
            onFocus={() => onFocus(field.id)}
          >
            {field.kind === "panel" ? (
              <Box flexDirection="row" width="100%" minWidth={0} gap={1} overflow="hidden">
                <Box flexGrow={1} minWidth={0} overflow="hidden">
                  <SegmentedControl
                    options={field.options}
                    value={field.value}
                    onChange={field.onChange}
                    focused={focused}
                    shortcutScope={dialogId}
                    width="100%"
                    wrap
                  />
                </Box>
                <Button label="New Panel" shortcut="N" onPress={field.onAddPanel} />
              </Box>
            ) : (
              <SegmentedControl
                options={field.options}
                value={field.value}
                onChange={field.onChange}
                focused={focused}
                shortcutScope={dialogId}
                width="100%"
                wrap
              />
            )}
          </TuiEditorField>
        );
      })}
    </>
  );
}

export function OpenTuiSeriesEditorActions({ actions }: { actions: SeriesEditorActionModel[] }) {
  return (
    <Box flexDirection="row" gap={1} width="100%">
      {actions.map((action) => (
        <Button
          key={action.id}
          label={action.label}
          shortcut={action.shortcut}
          variant={action.variant}
          disabled={action.disabled}
          onPress={action.onPress}
        />
      ))}
    </Box>
  );
}

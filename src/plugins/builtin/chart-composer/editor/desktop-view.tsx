import { type ReactNode } from "react";
import { Box, Text } from "../../../../ui";
import { Button, Checkbox } from "../../../../components/ui";
import { NativeSelect } from "../../../../components/ui/native-select";
import { colors } from "../../../../theme/colors";
import type {
  SeriesEditorActionModel,
  SeriesEditorFieldId,
  SeriesEditorFieldModel,
} from "./model";

function DesktopEditorField({
  label,
  children,
  width = "calc(50% - 6px)",
}: {
  label: string;
  children: ReactNode;
  width?: string;
}) {
  return (
    <Box flexDirection="column" width={width} minWidth="220px" style={{ gap: 4 }}>
      <Text fg={colors.textDim} style={{ fontWeight: 600 }}>{label}</Text>
      {children}
    </Box>
  );
}

const SECURITY_FIELD_ORDER: SeriesEditorFieldId[] = [
  "style",
  "transform",
  "axis",
  "period",
  "timing",
  "panel",
  "scale",
  "visibility",
];

const NON_SECURITY_FIELD_ORDER: SeriesEditorFieldId[] = [
  "style",
  "transform",
  "axis",
  "visibility",
  "panel",
  "scale",
];

export function DesktopSeriesEditorFields({ fields }: { fields: SeriesEditorFieldModel[] }) {
  const fieldById = new Map(fields.map((field) => [field.id, field]));
  const isSecurity = fieldById.has("period");
  const orderedFields = (isSecurity ? SECURITY_FIELD_ORDER : NON_SECURITY_FIELD_ORDER)
    .map((id) => fieldById.get(id))
    .filter((field): field is SeriesEditorFieldModel => !!field);

  return (
    <Box
      flexDirection="row"
      flexWrap="wrap"
      width="100%"
      style={{ columnGap: 12, rowGap: 10 }}
    >
      {orderedFields.map((field) => (
        <DesktopEditorField
          key={field.id}
          label={field.label}
          width={field.id === "visibility" && isSecurity ? "100%" : undefined}
        >
          {field.kind === "visibility" ? (
            <Box height="28px" justifyContent="center">
              <Checkbox
                label="Show series"
                checked={field.value === "shown"}
                variant="desktop"
                onChange={(checked) => field.onChange(checked ? "shown" : "hidden")}
              />
            </Box>
          ) : field.kind === "panel" ? (
            <Box flexDirection="row" width="100%" style={{ gap: 6 }}>
              <Box flexGrow={1} minWidth={0}>
                <NativeSelect
                  value={field.value}
                  options={field.options}
                  width="100%"
                  onChange={field.onChange}
                />
              </Box>
              <Button label="New Panel" onPress={field.onAddPanel} />
            </Box>
          ) : (
            <NativeSelect
              value={field.value}
              options={field.options}
              width="100%"
              onChange={field.onChange}
            />
          )}
        </DesktopEditorField>
      ))}
    </Box>
  );
}

export function DesktopSeriesEditorActions({ actions }: { actions: SeriesEditorActionModel[] }) {
  const seriesActions = actions.filter((action) => action.group === "series");
  const confirmActions = actions.filter((action) => action.group === "confirm");
  return (
    <Box flexDirection="row" gap={1} width="100%" style={{ gap: 6, paddingTop: 2 }}>
      <Box flexDirection="row" style={{ gap: 6 }}>
        {seriesActions.map((action) => (
          <Button
            key={action.id}
            label={action.label}
            variant={action.variant}
            disabled={action.disabled}
            onPress={action.onPress}
          />
        ))}
      </Box>
      <Box flexGrow={1} />
      <Box flexDirection="row" style={{ gap: 6 }}>
        {confirmActions.map((action) => (
          <Button
            key={action.id}
            label={action.label}
            variant={action.variant}
            disabled={action.disabled}
            onPress={action.onPress}
          />
        ))}
      </Box>
    </Box>
  );
}

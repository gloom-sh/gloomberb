import type { RefObject } from "react";
import { t } from "../../../i18n";
import { useEffect } from "react";
import {
  Box,
  ScrollBox,
  Text,
  type InputRenderable,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "../../../ui";
import { Button, Spinner } from "../../ui";
import type { NativeSelectElement } from "../../ui/native-select";
import {
  getVisibleWorkflowFields,
} from "../helpers";
import type {
  CommandBarFieldValue,
  CommandBarWorkflowField,
  CommandBarWorkflowRoute,
} from "./types";
import { truncateText } from "../view-model";
import { CommandBarWorkflowFieldRow } from "./field-row";

interface CommandBarWorkflowBodyProps {
  route: CommandBarWorkflowRoute;
  bodyHeight: number;
  contentPadding: number;
  inputBg: string;
  nativePaneChrome: boolean;
  paletteBg: string;
  paletteSelectedBg: string;
  paletteSubtleText: string;
  paletteText: string;
  panelBg: string;
  queryDisplayWidth: number;
  themeBorder: string;
  themeBorderFocused: string;
  themeNegative: string;
  themePanel: string;
  workflowScrollRef: RefObject<ScrollBoxRenderable | null>;
  getWorkflowInputRef: (fieldId: string) => RefObject<InputRenderable | TextareaRenderable | null>;
  onActiveTextareaSync: (route: CommandBarWorkflowRoute) => void;
  onFieldFocus: (fieldId: string) => void;
  onFieldPickerOpen: (route: CommandBarWorkflowRoute, field: CommandBarWorkflowField) => void;
  onFieldValueChange: (fieldId: string, value: CommandBarFieldValue) => void;
  onMoveFieldFocus: (delta: number) => void;
  onNativeSelectRef: (fieldId: string, element: NativeSelectElement | null) => void;
  onSubmit: (route: CommandBarWorkflowRoute) => void | Promise<void>;
}

export function CommandBarWorkflowBody({
  route,
  bodyHeight,
  contentPadding,
  inputBg,
  nativePaneChrome,
  paletteBg,
  paletteSelectedBg,
  paletteSubtleText,
  paletteText,
  panelBg,
  queryDisplayWidth,
  themeBorder,
  themeBorderFocused,
  themeNegative,
  themePanel,
  workflowScrollRef,
  getWorkflowInputRef,
  onActiveTextareaSync,
  onFieldFocus,
  onFieldPickerOpen,
  onFieldValueChange,
  onMoveFieldFocus,
  onNativeSelectRef,
  onSubmit,
}: CommandBarWorkflowBodyProps) {
  const visibleFields = getVisibleWorkflowFields(route.fields, route.values);

  useEffect(() => {
    if (!nativePaneChrome) return;
    const scrollBox = workflowScrollRef.current;
    if (!scrollBox) return;
    const activeIndex = visibleFields.findIndex((field) => field.id === route.activeFieldId);
    if (activeIndex < 0) return;

    const estimatedFieldHeight = 4;
    const fieldTop = activeIndex * estimatedFieldHeight;
    const fieldBottom = fieldTop + estimatedFieldHeight;
    const viewportHeight = Math.max(1, scrollBox.viewport?.height ?? bodyHeight);
    if (fieldTop < scrollBox.scrollTop) {
      scrollBox.scrollTo(fieldTop);
    } else if (fieldBottom > scrollBox.scrollTop + viewportHeight) {
      scrollBox.scrollTo(fieldBottom - viewportHeight);
    }
  }, [bodyHeight, nativePaneChrome, route.activeFieldId, visibleFields, workflowScrollRef]);

  const workflowContent = (
    <>
      {route.subtitle && (
        <Box height={1}>
          <Text fg={paletteSubtleText}>{truncateText(t(route.subtitle), queryDisplayWidth)}</Text>
        </Box>
      )}
      {route.description?.map((line, index) => (
        <Box key={`workflow-desc:${index}`} height={1}>
          <Text fg={paletteSubtleText}>{truncateText(t(line), queryDisplayWidth)}</Text>
        </Box>
      ))}
      {route.subtitle || (route.description?.length ?? 0) > 0 ? <Box height={1} /> : null}
      {visibleFields.map((field, fieldIndex) => {
        return (
          <CommandBarWorkflowFieldRow
            key={field.id}
            route={route}
            field={field}
            isLastField={fieldIndex === visibleFields.length - 1}
            inputBg={inputBg}
            nativePaneChrome={nativePaneChrome}
            paletteBg={paletteBg}
            paletteSelectedBg={paletteSelectedBg}
            paletteSubtleText={paletteSubtleText}
            paletteText={paletteText}
            panelBg={panelBg}
            queryDisplayWidth={queryDisplayWidth}
            themeBorder={themeBorder}
            themeBorderFocused={themeBorderFocused}
            themePanel={themePanel}
            getWorkflowInputRef={getWorkflowInputRef}
            onActiveTextareaSync={onActiveTextareaSync}
            onFieldFocus={onFieldFocus}
            onFieldPickerOpen={onFieldPickerOpen}
            onFieldValueChange={onFieldValueChange}
            onMoveFieldFocus={onMoveFieldFocus}
            onNativeSelectRef={onNativeSelectRef}
            onSubmit={onSubmit}
          />
        );
      })}
      {route.error && (
        <Box height={1}>
          <Text fg={themeNegative}>{truncateText(route.error, queryDisplayWidth)}</Text>
        </Box>
      )}
      {route.pendingLabel && route.pending && (
        <Box height={1}>
          <Spinner label={t(route.pendingLabel)} />
        </Box>
      )}
      {!nativePaneChrome && <Box flexGrow={1} />}
      <Box flexDirection="row" gap={1} justifyContent={visibleFields.some((field) => field.type === "textarea") ? "flex-end" : "flex-start"}>
        <Button label={t(route.submitLabel)} variant="primary" onPress={() => { void onSubmit(route); }} disabled={route.pending} />
      </Box>
    </>
  );

  if (nativePaneChrome) {
    return (
      <ScrollBox
        ref={workflowScrollRef}
        height={bodyHeight}
        scrollY
        style={{ overflowX: "hidden", paddingRight: 4 }}
      >
        <Box
          flexDirection="column"
          paddingX={contentPadding}
        >
          {workflowContent}
        </Box>
      </ScrollBox>
    );
  }

  return (
    <Box flexDirection="column" height={bodyHeight} paddingX={contentPadding}>
      {workflowContent}
    </Box>
  );
}

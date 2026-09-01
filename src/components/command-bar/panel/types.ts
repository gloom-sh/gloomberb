import type { RefObject } from "react";
import type {
  InputRenderable,
  ScrollBoxRenderable,
  TextareaRenderable,
} from "../../../ui";
import type { LayoutBounds } from "../../../plugins/pane-manager";
import type { NativeSelectElement } from "../../ui/native-select";
import type { CommandBarListRow, ListScreenState, ResultItem } from "../list/model";
import type { CommandBarListScrollEvent } from "../list/view";
import type { ThemePickerHandle } from "../theme-picker";
import type {
  CommandBarFieldValue,
  CommandBarRoute,
  CommandBarWorkflowField,
  CommandBarWorkflowRoute,
} from "../workflow/types";

export interface CommandBarPanelPalette {
  inputBg: string;
  paletteAccentText: string;
  paletteBg: string;
  paletteHeadingText: string;
  paletteHoverBg: string;
  paletteSelectedBg: string;
  paletteSelectedText: string;
  paletteSubtleText: string;
  paletteText: string;
  panelBg: string;
}

export interface CommandBarPanelProps {
  bodyHeight: number;
  bodySlotKey: string;
  committedThemeId: string;
  contentPadding: number;
  currentRoute: CommandBarRoute | null;
  getWorkflowInputRef: (fieldId: string) => RefObject<InputRenderable | TextareaRenderable | null>;
  labelWidth: number;
  listBodyHeight: number;
  nativeListRows: CommandBarListRow[];
  nativeListScrollRef: RefObject<ScrollBoxRenderable | null>;
  nativeOccluderRect: LayoutBounds;
  nativePaneChrome: boolean;
  onBack: () => void;
  onConfirmRoute: () => void;
  onFieldFocus: (fieldId: string) => void;
  onFieldPickerOpen: (route: CommandBarWorkflowRoute, field: CommandBarWorkflowField) => void;
  onFieldValueChange: (fieldId: string, value: CommandBarFieldValue) => void;
  onListHoverIndex: (index: number | null) => void;
  onListRowMouseDown: (event: any, item: ResultItem, globalIdx: number) => void;
  onListScroll: (event: CommandBarListScrollEvent) => void;
  onMoveFieldFocus: (delta: number) => void;
  onMultiSelectCommit: () => void;
  onMultiSelectSelect: (index: number) => void;
  onMultiSelectToggle: (id: string) => void;
  onNativeOccluderChange?: (rect: LayoutBounds | null) => void;
  onNativeSelectRef: (fieldId: string, element: NativeSelectElement | null) => void;
  onOverlayClose: () => void;
  onQueryChange: (query: string) => void;
  onThemeCommit: (themeId: string) => void;
  onThemePreview: (themeId: string | null) => void;
  onWorkflowActiveTextareaSync: (route: CommandBarWorkflowRoute) => void;
  onWorkflowSubmit: (route: CommandBarWorkflowRoute) => void | Promise<void>;
  panelBounds: LayoutBounds;
  queryDisplayWidth: number;
  rootGhostSuffix: string | null;
  rootShortcutFeedback: string | null;
  /**
   * Line the scroll box has to reach for the selected row to be fully visible,
   * or -1 when nothing is selected. Rows are not all one line tall, so this is a
   * line offset rather than a row index.
   */
  selectedScrollRowIndex: number;
  termHeight: number;
  termWidth: number;
  themePickerActive: boolean;
  themePickerFilter: string;
  themePickerRef: RefObject<ThemePickerHandle | null>;
  trailingWidth: number;
  visibleListState: ListScreenState | null;
  workflowScrollRef: RefObject<ScrollBoxRenderable | null>;
}

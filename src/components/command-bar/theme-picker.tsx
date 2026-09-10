import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { t } from "../../i18n";
import { getPresets, presetLabels, stylesAreSelectable } from "../../theme/presets";
import { getScheme, getThemeIds, isDarkTheme } from "../../theme/schemes";
import { useGlyphs } from "../../theme/theme-context";
import { Box, Text, TextAttributes } from "../../ui";
import { ListView, type ListViewItem } from "../ui";
import type { ListRowState } from "../ui/list-view";
import { useCommandBarPalette } from "./panel/palette";
import type { ThemeSelection } from "./theme-preview";
import { truncateText } from "./view-model";

const THEME_PREVIEW_DEBOUNCE_MS = 120;
/** The dark marker plus the space that keeps names on one left edge, dark or light. */
const GLYPH_GUTTER_WIDTH = 2;
/** Widest style name plus two cells of air, so scheme names share a left edge. */
const STYLE_COLUMN_WIDTH = 10;

/** `theme` picks a whole theme; `colors` swaps the palette under the style. */
export type ThemePickerMode = "theme" | "colors";

export interface ThemeOption {
  id: string;
  /** Structural half. Empty in `colors` mode, where the style does not change. */
  styleId: string;
  schemeId: string;
  styleName: string;
  schemeName: string;
  name: string;
  dark: boolean;
}

/**
 * With one style shipping there is nothing to group by, so the list sorts by
 * scheme name and drops the style column. The moment a second style ships the
 * entries group by style again without any change here.
 */
const SHOW_STYLE_COLUMN = stylesAreSelectable();

const PRESET_OPTIONS: ThemeOption[] = getPresets()
  .map((preset) => {
    const labels = presetLabels(preset);
    return {
      id: preset.id,
      styleId: preset.styleId,
      schemeId: preset.schemeId,
      styleName: labels.style,
      schemeName: labels.scheme,
      name: SHOW_STYLE_COLUMN ? labels.full : labels.scheme,
      dark: labels.dark,
    };
  })
  .sort((a, b) => (SHOW_STYLE_COLUMN
    ? a.styleName.localeCompare(b.styleName) || a.schemeName.localeCompare(b.schemeName)
    : a.schemeName.localeCompare(b.schemeName)));

const SCHEME_OPTIONS: ThemeOption[] = getThemeIds()
  .map((id) => ({
    id,
    styleId: "",
    schemeId: id,
    styleName: "",
    schemeName: getScheme(id).name,
    name: getScheme(id).name,
    dark: isDarkTheme(id),
  }))
  .sort((a, b) => a.schemeName.localeCompare(b.schemeName));

function optionsFor(mode: ThemePickerMode): ThemeOption[] {
  return mode === "colors" ? SCHEME_OPTIONS : PRESET_OPTIONS;
}

/**
 * Shared with the panel layout, which sizes the sheet to whatever this returns
 * so the picker never opens taller than the entries it can show.
 */
export function matchThemeOptions(filter: string, mode: ThemePickerMode = "theme"): ThemeOption[] {
  const options = optionsFor(mode);
  const normalized = filter.trim().toLowerCase();
  if (!normalized) return options;
  return options.filter((option) => (
    option.name.toLowerCase().includes(normalized)
    || option.id.toLowerCase().includes(normalized)
    || option.schemeId.toLowerCase().includes(normalized)
    || option.styleId.toLowerCase().includes(normalized)
  ));
}

function isCurrentOption(option: ThemeOption, committedThemeId: string, committedStyleId: string): boolean {
  if (option.schemeId !== committedThemeId) return false;
  return option.styleId === "" || option.styleId === committedStyleId;
}

function selectionOf(option: ThemeOption): ThemeSelection {
  return option.styleId ? { themeId: option.schemeId, styleId: option.styleId } : { themeId: option.schemeId };
}

interface ThemePickerScrollEvent {
  stopPropagation: () => void;
  preventDefault: () => void;
  scroll?: { direction?: string; delta?: number };
}

interface ThemePickerProps {
  filter: string;
  mode?: ThemePickerMode;
  committedThemeId: string;
  committedStyleId: string;
  height: number;
  contentPadding: number;
  labelWidth: number;
  trailingWidth: number;
  queryDisplayWidth: number;
  nativePaneChrome: boolean;
  onPreview: (selection: ThemeSelection | null) => void;
  onCommit: (selection: ThemeSelection) => void;
}

export interface ThemePickerHandle {
  move: (delta: number) => boolean;
  commit: () => boolean;
  cancelPreview: () => void;
}

function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(index, Math.max(0, length - 1)));
}

export const ThemePicker = memo(forwardRef<ThemePickerHandle, ThemePickerProps>(function ThemePicker({
  filter,
  mode = "theme",
  committedThemeId,
  committedStyleId,
  height,
  contentPadding,
  labelWidth,
  trailingWidth,
  queryDisplayWidth,
  nativePaneChrome,
  onPreview,
  onCommit,
}: ThemePickerProps, ref) {
  const palette = useCommandBarPalette(nativePaneChrome);
  // The picker previews the theme it is about to apply, so its own marker has
  // to come from the live glyph table rather than a literal.
  const glyphs = useGlyphs();
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPreviewRef = useRef<ThemeOption | null>(null);
  const committedRef = useRef({ themeId: committedThemeId, styleId: committedStyleId });
  const onPreviewRef = useRef(onPreview);
  const onCommitRef = useRef(onCommit);
  const normalizedFilter = filter.trim().toLowerCase();
  const themes = useMemo(() => matchThemeOptions(normalizedFilter, mode), [mode, normalizedFilter]);
  const [selectedIndex, setSelectedIndex] = useState(() => (
    Math.max(0, themes.findIndex((theme) => isCurrentOption(theme, committedThemeId, committedStyleId)))
  ));
  const themesRef = useRef(themes);
  const selectedIndexRef = useRef(selectedIndex);
  const items = useMemo<ListViewItem[]>(() => themes.map((theme) => {
    const current = isCurrentOption(theme, committedThemeId, committedStyleId);
    return {
      id: theme.id,
      label: theme.name,
      detail: current ? "current" : "",
      category: mode === "colors" ? "Colors" : "Themes",
      kind: "theme",
      right: current ? "current" : "",
      current,
    };
  }), [committedStyleId, committedThemeId, mode, themes]);

  themesRef.current = themes;
  selectedIndexRef.current = selectedIndex;
  committedRef.current = { themeId: committedThemeId, styleId: committedStyleId };
  onPreviewRef.current = onPreview;
  onCommitRef.current = onCommit;

  const cancelPreview = useCallback(() => {
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    pendingPreviewRef.current = null;
  }, []);

  const requestPreview = useCallback((option: ThemeOption) => {
    pendingPreviewRef.current = option;
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
    }
    previewTimerRef.current = setTimeout(() => {
      previewTimerRef.current = null;
      const next = pendingPreviewRef.current;
      pendingPreviewRef.current = null;
      if (!next) return;
      const { themeId, styleId } = committedRef.current;
      onPreviewRef.current(isCurrentOption(next, themeId, styleId) ? null : selectionOf(next));
    }, THEME_PREVIEW_DEBOUNCE_MS);
  }, []);

  const move = useCallback((delta: number): boolean => {
    const options = themesRef.current;
    if (options.length === 0 || delta === 0) return false;
    const nextIndex = clampIndex(selectedIndexRef.current + delta, options.length);
    if (nextIndex === selectedIndexRef.current) return false;
    selectedIndexRef.current = nextIndex;
    setSelectedIndex(nextIndex);
    requestPreview(options[nextIndex]!);
    return true;
  }, [requestPreview]);

  const commit = useCallback((): boolean => {
    const selected = themesRef.current[selectedIndexRef.current];
    if (!selected) return false;
    cancelPreview();
    onCommitRef.current(selectionOf(selected));
    return true;
  }, [cancelPreview]);

  useImperativeHandle(ref, () => ({
    move,
    commit,
    cancelPreview,
  }), [cancelPreview, commit, move]);

  useEffect(() => {
    const preferredIndex = themes.findIndex((theme) => isCurrentOption(theme, committedThemeId, committedStyleId));
    const nextIndex = preferredIndex >= 0 ? preferredIndex : 0;
    selectedIndexRef.current = nextIndex;
    setSelectedIndex(nextIndex);
  }, [committedStyleId, committedThemeId, themes]);

  useEffect(() => cancelPreview, [cancelPreview]);

  const handleScroll = useCallback((event: ThemePickerScrollEvent) => {
    event.stopPropagation();
    event.preventDefault();
    const delta = Math.max(1, Math.round(event.scroll?.delta ?? 1));
    const direction = event.scroll?.direction;
    if (direction === "down" || direction === "right") {
      move(delta);
    } else if (direction === "up" || direction === "left") {
      move(-delta);
    }
  }, [move]);

  const handleSelect = useCallback((index: number) => {
    const selected = themesRef.current[index];
    if (!selected) return;
    selectedIndexRef.current = index;
    setSelectedIndex(index);
    requestPreview(selected);
  }, [requestPreview]);

  const handleActivate = useCallback((item: ListViewItem, index: number) => {
    const selected = themesRef.current[index] ?? themesRef.current.find((theme) => theme.id === item.id);
    if (!selected) return;
    selectedIndexRef.current = index;
    setSelectedIndex(index);
    cancelPreview();
    onCommitRef.current(selectionOf(selected));
  }, [cancelPreview]);

  const showStyleColumn = mode === "theme" && SHOW_STYLE_COLUMN;
  const nameWidth = Math.max(1, labelWidth - GLYPH_GUTTER_WIDTH);
  const styleWidth = showStyleColumn ? Math.min(STYLE_COLUMN_WIDTH, Math.max(0, nameWidth - 6)) : 0;
  const schemeWidth = Math.max(1, nameWidth - styleWidth);
  const renderRow = useCallback((item: ListViewItem, state: ListRowState) => {
    const option = themesRef.current.find((theme) => theme.id === item.id);
    const trailing = item.current ? "current" : "";
    return (
      <Box
        flexDirection="row"
        height={1}
        paddingX={contentPadding}
        width="100%"
        data-command-bar-row-selected={nativePaneChrome && state.selected ? "true" : undefined}
        style={nativePaneChrome ? { borderRadius: "var(--gloom-radius-control, 6px)" } : undefined}
      >
        <Box width={GLYPH_GUTTER_WIDTH}>
          <Text fg={state.selected ? palette.selectedText : palette.subtle}>
            {option?.dark ? glyphs.moon : ""}
          </Text>
        </Box>
        {showStyleColumn && (
          <Box width={styleWidth}>
            <Text
              fg={state.selected ? palette.selectedText : palette.subtle}
              attributes={item.current ? TextAttributes.BOLD : undefined}
            >
              {truncateText(option?.styleName ?? "", styleWidth)}
            </Text>
          </Box>
        )}
        <Box width={schemeWidth}>
          <Text
            fg={state.selected ? palette.selectedText : palette.text}
            attributes={item.current ? TextAttributes.BOLD : undefined}
          >
            {truncateText(option?.schemeName ?? item.label, schemeWidth)}
          </Text>
        </Box>
        <Box width={trailingWidth}>
          <Text fg={state.selected ? palette.selectedText : palette.subtle}>
            {truncateText(trailing, trailingWidth)}
          </Text>
        </Box>
      </Box>
    );
  }, [
    contentPadding,
    glyphs,
    nativePaneChrome,
    palette,
    schemeWidth,
    showStyleColumn,
    styleWidth,
    trailingWidth,
  ]);

  return (
    <ListView
      items={items}
      selectedIndex={selectedIndex}
      height={height}
      scrollable
      rowGap={0}
      rowHeight={1}
      surface="plain"
      bgColor={nativePaneChrome ? palette.panelBg : palette.bg}
      selectedBgColor={palette.selectedBg}
      hoverBgColor={palette.hoverBg}
      emptyMessage={truncateText(t(mode === "colors" ? "No colors match" : "No themes match"), queryDisplayWidth)}
      showSelectedDescription={false}
      onSelect={handleSelect}
      onActivate={handleActivate}
      onMouseScroll={!nativePaneChrome ? handleScroll : undefined}
      renderRow={renderRow}
      remoteLabel={mode === "colors" ? "Color picker" : "Theme picker"}
      remoteScope="command-bar"
      remoteItemKind="theme"
      remoteItemCategory={mode === "colors" ? "Colors" : "Themes"}
      remoteMetadata={{
        surface: mode === "colors" ? "color-picker" : "theme-picker",
        filter: normalizedFilter,
      }}
    />
  );
}));

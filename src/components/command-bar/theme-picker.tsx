import { t } from "../../i18n";
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
import { Box, Text } from "../../ui";
import { TextAttributes } from "../../ui";
import { ListView, type ListViewItem } from "../ui";
import type { ListRowState } from "../ui/list-view";
import { getThemeIds, isDarkTheme, themes as themeRegistry } from "../../theme/themes";
import { truncateText } from "./view-model";

const THEME_PREVIEW_DEBOUNCE_MS = 120;
/**
 * Marks the dark half of the list. The registry's own order groups themes by
 * family, which only helps if you already know which family you want; sorted by
 * name you can find one by reading, and the glyph carries the grouping the
 * order used to.
 */
const DARK_THEME_GLYPH = "☾";
/** The glyph plus the space that keeps names on one left edge, dark or light. */
const GLYPH_GUTTER_WIDTH = 2;

export interface ThemeOption {
  id: string;
  name: string;
  dark: boolean;
}

const THEME_OPTIONS: ThemeOption[] = getThemeIds()
  .map((id) => ({ id, name: themeRegistry[id]!.name, dark: isDarkTheme(id) }))
  .sort((a, b) => a.name.localeCompare(b.name));

/**
 * Shared with the panel layout, which sizes the sheet to whatever this returns
 * so the picker never opens taller than the themes it can show.
 */
export function matchThemeOptions(filter: string): ThemeOption[] {
  const normalized = filter.trim().toLowerCase();
  if (!normalized) return THEME_OPTIONS;
  return THEME_OPTIONS.filter((theme) => (
    theme.name.toLowerCase().includes(normalized)
    || theme.id.toLowerCase().includes(normalized)
  ));
}

interface ThemePickerScrollEvent {
  stopPropagation: () => void;
  preventDefault: () => void;
  scroll?: { direction?: string; delta?: number };
}

interface ThemePickerProps {
  filter: string;
  committedThemeId: string;
  height: number;
  contentPadding: number;
  labelWidth: number;
  trailingWidth: number;
  queryDisplayWidth: number;
  nativePaneChrome: boolean;
  paletteBg: string;
  paletteHoverBg: string;
  paletteSelectedBg: string;
  paletteSelectedText: string;
  paletteSubtleText: string;
  paletteText: string;
  panelBg: string;
  onPreview: (themeId: string | null) => void;
  onCommit: (themeId: string) => void;
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
  committedThemeId,
  height,
  contentPadding,
  labelWidth,
  trailingWidth,
  queryDisplayWidth,
  nativePaneChrome,
  paletteBg,
  paletteHoverBg,
  paletteSelectedBg,
  paletteSelectedText,
  paletteSubtleText,
  paletteText,
  panelBg,
  onPreview,
  onCommit,
}: ThemePickerProps, ref) {
  const previewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingPreviewIdRef = useRef<string | null>(null);
  const committedThemeIdRef = useRef(committedThemeId);
  const onPreviewRef = useRef(onPreview);
  const onCommitRef = useRef(onCommit);
  const normalizedFilter = filter.trim().toLowerCase();
  const themes = useMemo(() => matchThemeOptions(normalizedFilter), [normalizedFilter]);
  const [selectedIndex, setSelectedIndex] = useState(() => (
    Math.max(0, themes.findIndex((theme) => theme.id === committedThemeId))
  ));
  const themesRef = useRef(themes);
  const selectedIndexRef = useRef(selectedIndex);
  const items = useMemo<ListViewItem[]>(() => themes.map((theme) => {
    const current = theme.id === committedThemeId;
    return {
      id: theme.id,
      label: theme.name,
      detail: current ? "current" : "",
      category: "Themes",
      kind: "theme",
      right: current ? "current" : "",
      current,
    };
  }), [committedThemeId, themes]);

  themesRef.current = themes;
  selectedIndexRef.current = selectedIndex;
  committedThemeIdRef.current = committedThemeId;
  onPreviewRef.current = onPreview;
  onCommitRef.current = onCommit;

  const cancelPreview = useCallback(() => {
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
      previewTimerRef.current = null;
    }
    pendingPreviewIdRef.current = null;
  }, []);

  const requestPreview = useCallback((themeId: string) => {
    pendingPreviewIdRef.current = themeId;
    if (previewTimerRef.current) {
      clearTimeout(previewTimerRef.current);
    }
    previewTimerRef.current = setTimeout(() => {
      previewTimerRef.current = null;
      const nextThemeId = pendingPreviewIdRef.current;
      pendingPreviewIdRef.current = null;
      if (!nextThemeId) return;
      onPreviewRef.current(nextThemeId === committedThemeIdRef.current ? null : nextThemeId);
    }, THEME_PREVIEW_DEBOUNCE_MS);
  }, []);

  const move = useCallback((delta: number): boolean => {
    const options = themesRef.current;
    if (options.length === 0 || delta === 0) return false;
    const nextIndex = clampIndex(selectedIndexRef.current + delta, options.length);
    if (nextIndex === selectedIndexRef.current) return false;
    selectedIndexRef.current = nextIndex;
    setSelectedIndex(nextIndex);
    requestPreview(options[nextIndex]!.id);
    return true;
  }, [requestPreview]);

  const commit = useCallback((): boolean => {
    const selected = themesRef.current[selectedIndexRef.current];
    if (!selected) return false;
    cancelPreview();
    onCommitRef.current(selected.id);
    return true;
  }, [cancelPreview]);

  useImperativeHandle(ref, () => ({
    move,
    commit,
    cancelPreview,
  }), [cancelPreview, commit, move]);

  useEffect(() => {
    const preferredIndex = themes.findIndex((theme) => theme.id === committedThemeId);
    const nextIndex = preferredIndex >= 0 ? preferredIndex : 0;
    selectedIndexRef.current = nextIndex;
    setSelectedIndex(nextIndex);
  }, [committedThemeId, themes]);

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
    requestPreview(selected.id);
  }, [requestPreview]);

  const handleActivate = useCallback((item: ListViewItem, index: number) => {
    const selected = themesRef.current[index] ?? themesRef.current.find((theme) => theme.id === item.id);
    if (!selected) return;
    selectedIndexRef.current = index;
    setSelectedIndex(index);
    cancelPreview();
    onCommitRef.current(selected.id);
  }, [cancelPreview]);

  const nameWidth = Math.max(1, labelWidth - GLYPH_GUTTER_WIDTH);
  const renderRow = useCallback((item: ListViewItem, state: ListRowState) => {
    const label = truncateText(item.label, nameWidth);
    const trailing = item.current ? "current" : "";
    return (
      <Box
        flexDirection="row"
        height={1}
        paddingX={contentPadding}
        width="100%"
        data-command-bar-row-selected={nativePaneChrome && state.selected ? "true" : undefined}
        style={nativePaneChrome ? { borderRadius: 6 } : undefined}
      >
        <Box width={GLYPH_GUTTER_WIDTH}>
          <Text fg={state.selected ? paletteSelectedText : paletteSubtleText}>
            {isDarkTheme(item.id) ? DARK_THEME_GLYPH : ""}
          </Text>
        </Box>
        <Box width={nameWidth}>
          <Text
            fg={state.selected ? paletteSelectedText : paletteText}
            attributes={item.current ? TextAttributes.BOLD : undefined}
          >
            {label}
          </Text>
        </Box>
        <Box width={trailingWidth}>
          <Text fg={state.selected ? paletteSelectedText : paletteSubtleText}>
            {truncateText(trailing, trailingWidth)}
          </Text>
        </Box>
      </Box>
    );
  }, [
    contentPadding,
    nameWidth,
    nativePaneChrome,
    paletteSelectedText,
    paletteSubtleText,
    paletteText,
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
      bgColor={nativePaneChrome ? panelBg : paletteBg}
      selectedBgColor={paletteSelectedBg}
      hoverBgColor={paletteHoverBg}
      emptyMessage={truncateText(t("No themes match"), queryDisplayWidth)}
      showSelectedDescription={false}
      onSelect={handleSelect}
      onActivate={handleActivate}
      onMouseScroll={!nativePaneChrome ? handleScroll : undefined}
      renderRow={renderRow}
      remoteLabel="Theme picker"
      remoteScope="command-bar"
      remoteItemKind="theme"
      remoteItemCategory="Themes"
      remoteMetadata={{
        surface: "theme-picker",
        filter: normalizedFilter,
      }}
    />
  );
}));

import { createContext, useContext, type ComponentType, type ReactNode, type Ref } from "react";
import type { ContextMenuItem } from "../types/context-menu";
import type { AppNotificationRequest } from "../types/plugin";
import { getShortcutDisplayMode } from "../utils/shortcut-labels";
import { formatAdvertisedChord, useKeybindings } from "../app/keybindings";
import type { AsciiFontName } from "./ascii-font";

export const TextAttributes = {
  NONE: 0,
  BOLD: 1 << 0,
  DIM: 1 << 1,
  ITALIC: 1 << 2,
  UNDERLINE: 1 << 3,
  BLINK: 1 << 4,
  INVERSE: 1 << 5,
  HIDDEN: 1 << 6,
  STRIKETHROUGH: 1 << 7,
} as const;

type TextAttributeFlags = number;

export type RGBA = string;

export const RGBA = {
  fromHex(hex: string): RGBA {
    return hex;
  },
};

export interface StyledTextChunk {
  __isChunk?: true;
  text: string;
  fg?: unknown;
  bg?: unknown;
  attributes?: number;
}

export class StyledText {
  readonly chunks: StyledTextChunk[];

  constructor(chunks: StyledTextChunk[]) {
    this.chunks = chunks;
  }
}

export interface PixelResolution {
  width: number;
  height: number;
}

export interface BitmapSurface {
  width: number;
  height: number;
  pixels: Uint8Array | Uint8ClampedArray;
}

export interface ChartCrosshairOverlay {
  pixelX: number;
  /** Level line and focus dot; null when only the column is known, as with a keyboard cursor. */
  pixelY: number | null;
  color: string;
  /** Per-series dots on the cursor column, in bitmap pixels. */
  markers?: readonly { pixelY: number; color: string }[];
}

/**
 * Overlay shapes in plot ratios, drawn without touching the plot raster. The
 * desktop composites them as vectors; the terminal paints them into the bitmap.
 */
export interface ChartVectorShape {
  id: string;
  points: readonly { x: number; y: number }[];
  color: string;
  /** Closes the shape into a filled box, for range and area selections. */
  box?: boolean;
  fillOpacity?: number;
  strokeWidth?: number;
  handles?: boolean;
}

interface TextEditBuffer {
  getText(): string;
  setText?(text: string): void;
}

export interface Highlight {
  start: number;
  end: number;
  styleId: number;
  priority?: number | null;
  hlRef?: number | null;
}

export interface SyntaxStyleLike {
  registerStyle(name: string, style: {
    fg?: unknown;
    bg?: unknown;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    dim?: boolean;
  }): number;
}

export interface BoxRenderable {
  x?: number;
  y?: number;
  width?: number | string;
  height?: number;
  absoluteX?: number;
  absoluteY?: number;
  absoluteBounds?: { x: number; y: number; width: number; height: number };
  getBoundingClientRect?: () => { x: number; y: number; width: number; height: number };
  [key: string]: unknown;
}

interface ScrollBarRenderable {
  visible: boolean;
  on?(event: "change", handler: () => void): void;
  off?(event: "change", handler: () => void): void;
}

export interface ScrollBoxRenderable {
  width?: number;
  scrollTop: number;
  scrollLeft?: number;
  scrollHeight: number;
  scrollWidth?: number;
  scrollTopPx?: number;
  scrollLeftPx?: number;
  scrollHeightPx?: number;
  scrollWidthPx?: number;
  viewport?: { width: number; height: number };
  viewportPx?: { width: number; height: number };
  visible?: boolean;
  parent?: unknown;
  getBoundingClientRect?: () => { x: number; y: number; width: number; height: number };
  horizontalScrollBar?: ScrollBarRenderable;
  verticalScrollBar?: ScrollBarRenderable;
  scrollTo(target: number | { x?: number; y?: number }, y?: number): void;
  scrollToPixels?(target: number | { x?: number; y?: number }, y?: number): void;
}

export interface InputRenderable {
  editBuffer: TextEditBuffer;
  cursorOffset?: number;
  setCursorOffset?(offset: number): void;
  focus?(): void;
  blur?(): void;
}

export interface TextareaRenderable extends InputRenderable {
  virtualLineCount: number;
  visualCursor: {
    visualRow: number;
    visualCol: number;
    logicalRow: number;
    logicalCol: number;
    offset: number;
  };
  setText(text: string): void;
  hasSelection(): boolean;
  syntaxStyle?: SyntaxStyleLike | null;
  onContentChange?: (() => void) | undefined;
  addHighlight?(lineIdx: number, highlight: Highlight): void;
  clearLineHighlights?(lineIdx: number): void;
}

export interface NativeCursorState {
  x: number;
  y: number;
  visible: boolean;
}

export type NativePostProcessFn = (buffer: unknown, deltaTime: number) => void;

/** One styled run of a rendered terminal row; colours are 0-255 RGBA. */
export interface NativeFrameSpan {
  text: string;
  fg: readonly [number, number, number, number];
  bg: readonly [number, number, number, number];
  attributes: number;
}

/** The last frame the terminal renderer drew, as styled rows. */
export interface NativeFrameCapture {
  cols: number;
  rows: number;
  lines: NativeFrameSpan[][];
}

export interface NativeRendererHost {
  terminalWidth: number;
  terminalHeight: number;
  resolution: PixelResolution | null;
  capabilities?: unknown;
  isDestroyed?: boolean;
  currentFocusedRenderable?: unknown;
  currentFocusedEditor?: unknown;
  keyInput?: {
    on(event: string, handler: (...args: any[]) => void): void;
    off(event: string, handler: (...args: any[]) => void): void;
    processPaste?(data: Uint8Array): void;
  };
  on(event: string, handler: (...args: any[]) => void): void;
  off(event: string, handler: (...args: any[]) => void): void;
  requestRender(): void;
  registerLifecyclePass(renderable: unknown): void;
  unregisterLifecyclePass(renderable: unknown): void;
  getSelection?(): { getSelectedText(): string } | null;
  getCursorState?(): NativeCursorState;
  setCursorPosition?(x: number, y: number, visible?: boolean): void;
  addPostProcessFn?(processFn: NativePostProcessFn): void;
  removePostProcessFn?(processFn: NativePostProcessFn): void;
  /** Terminal renderers only. Kitty graphics are drawn out of band and come back as blank cells. */
  captureFrame?(): NativeFrameCapture | null;
  copyToClipboardOSC52?(text: string): boolean;
  write?(data: string | Uint8Array): boolean;
  captureMouseRenderable?(renderable: unknown): void;
}

interface BoxProps {
  children?: ReactNode;
  [key: string]: unknown;
}

export interface TextProps {
  children?: ReactNode;
  content?: ReactNode | StyledText | { chunks?: StyledTextChunk[] };
  fg?: string;
  bg?: string;
  bold?: boolean;
  underline?: boolean;
  inverse?: boolean;
  dim?: boolean;
  italic?: boolean;
  strikethrough?: boolean;
  attributes?: TextAttributeFlags;
  [key: string]: unknown;
}

interface ScrollBoxProps extends BoxProps {}
interface InputProps extends BoxProps {}
interface TextareaProps extends BoxProps {}
export interface ChartSurfaceProps extends BoxProps {
  bitmap?: BitmapSurface | null;
  /** Desktop stacks every layer; the terminal renders only the first. */
  bitmaps?: readonly BitmapSurface[] | null;
  crosshair?: ChartCrosshairOverlay | null;
  vectors?: readonly ChartVectorShape[] | null;
  nativeBitmapsEnabled?: boolean;
}
/** GPU surface plot. Geometry arrives prebuilt; the host owns camera interaction between commits. */
export interface Surface3DHostProps {
  width: number;
  height: number;
  scene: import("../components/chart/surface3d/model").Surface3DScene;
  camera: import("../components/chart/surface3d/model").Surface3DCamera;
  colors: import("../components/chart/surface3d/software").Surface3DColors;
  /** Fraction of the width kept for the colour bar. */
  reserveRight: number;
  /** Called once the camera settles after a drag, inertia, zoom or reset. */
  onCameraChange: (camera: import("../components/chart/surface3d/model").Surface3DCamera) => void;
  onSelect: (cell: import("../components/chart/surface3d/model").Surface3DCell) => void;
  ariaLabel?: string;
  /** Rendered when the GPU context is unavailable. */
  fallback?: ReactNode;
}
export interface ImageSurfaceProps extends BoxProps {
  src?: string;
  alt?: string;
  objectFit?: "contain" | "cover";
}
export interface MediaSurfaceProps extends BoxProps {
  src?: string;
  title?: string;
  poster?: string;
  autoPlay?: boolean;
  muted?: boolean;
  mediaHandleRef?: Ref<MediaSurfaceHandle>;
  onPlaybackStateChange?: (state: "idle" | "loading" | "playing" | "paused" | "error") => void;
  onMutedChange?: (muted: boolean) => void;
  onError?: (message: string) => void;
}
export interface MediaSurfaceHandle {
  play(): Promise<void>;
  pause(): void;
  toggle(): Promise<void>;
  toggleMuted(): boolean;
}
interface SpinnerMarkProps extends BoxProps {
  name?: string;
  color?: string;
}
export interface AsciiTextProps extends BoxProps {
  text: string;
  font?: AsciiFontName;
  /**
   * Multiplier on the glyph cell. When set, DOM hosts paint the block glyphs
   * themselves at that size instead of relying on a font that has them, so
   * the art looks the same on every platform. Terminals ignore it.
   */
  scale?: number;
  color?: string;
  fg?: string;
  bg?: string;
  backgroundColor?: string;
  selectable?: boolean;
}

interface HostTabItem {
  label: string;
  value: string;
  disabled?: boolean;
  reorderable?: boolean;
  onClose?: (value: string) => void;
  onDoubleClick?: (value: string) => void;
  onContextMenu?: (value: string, event: any) => void;
}

interface HostTabsPalette {
  activeFg: string;
  inactiveFg: string;
  disabledFg: string;
  hoverFg: string;
  activeUnderline: string;
  inactiveUnderline: string;
  hoverUnderline: string;
  hoverBg: string;
  activeBg: string;
  activePillFg: string;
  closeFg: string;
  addFg: string;
}

export interface HostTabsProps {
  tabs: HostTabItem[];
  activeValue: string | null;
  onSelect: (value: string) => void;
  compact?: boolean;
  dense?: boolean;
  variant?: "underline" | "pill" | "bare" | "header";
  closeMode?: "active" | "always";
  addLabel?: string;
  onAdd?: () => void;
  onReorder?: (fromValue: string, toValue: string) => void;
  focused?: boolean;
  palette: HostTabsPalette;
}

export interface HostCheckboxProps {
  label: string;
  displayLabel?: string;
  checked: boolean;
  onChange?: (checked: boolean) => void;
  disabled?: boolean;
  active?: boolean;
  description?: string;
  width?: number | string;
  variant?: "default" | "desktop";
}

interface HostQueryBarOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  selected: boolean;
  /** Shortcut key for the option. */
  hint?: string;
}

export interface HostQueryBarItem {
  id: string;
  kind: "select" | "multi" | "toggle" | "text";
  label: string;
  /** Current value as shown on the control, e.g. "All" or "News, Filings". */
  valueLabel: string;
  /** Differs from its default, so the list on screen is narrower than it could be. */
  narrowing: boolean;
  /** Short exclusive choice drawn as inline segments instead of a menu. */
  inline?: boolean;
  /** Text filters: the live input, rendered by the kit, and its field state. */
  node?: ReactNode;
  active?: boolean;
  onActivate?(): void;
  /** Text filters: the input width in cells, not counting the label. */
  width?: number;
  checked?: boolean;
  options: HostQueryBarOption[];
  /** Select: choose the value. Multi: toggle the value. */
  onSelect(value: string): void;
  onToggle(): void;
  /** Back to the default value. */
  onReset(): void;
}

export interface HostQueryBarProps {
  search?: {
    /** The live input, rendered by the kit so it keeps keyboard capture and Esc handling. */
    node: ReactNode;
    filled: boolean;
    active: boolean;
    onActivate(): void;
    onClear(): void;
  };
  items: HostQueryBarItem[];
  view?: {
    value: string;
    options: { value: string; label: string; hint?: string; disabled?: boolean }[];
    onChange(value: string): void;
  };
  onClearAll?: () => void;
  /** Muted context at the right edge, e.g. the selected row's date. */
  meta?: string;
  /** Opens one item's menu, e.g. from a pane shortcut. The token changes per request. */
  openRequest?: { id: string; token: number } | null;
}

export interface HostPopoverProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  trigger: ReactNode;
  children: ReactNode;
  anchorPoint?: { x: number; y: number } | null;
  placement?: "bottom-start" | "bottom-end";
  minWidth?: number | string;
  maxWidth?: number | string;
  label?: string;
  /** `menu` is the tight padding a Menu wants; `content` (default) is for free-form content. */
  density?: "content" | "menu";
  /**
   * Move focus into the popover when it opens (default). An autocomplete under
   * an input passes false so typing continues in the input.
   */
  focusOnOpen?: boolean;
}

export interface HostMenuItem {
  id: string;
  label: string;
  kind?: "item" | "divider" | "heading";
  description?: string;
  /** Right-aligned secondary text, e.g. a shortcut. */
  hint?: string;
  disabled?: boolean;
  /** The current value of a single-select menu. */
  selected?: boolean;
  /** The checkbox state in a multi-select menu. */
  checked?: boolean;
}

export interface HostMenuProps {
  items: HostMenuItem[];
  onSelect(id: string): void;
  /** `single` marks the selected item with a check; `multi` gives each item a checkbox. */
  selection?: "none" | "single" | "multi";
  /** Muted heading above the items. */
  title?: string;
  label?: string;
  /** Esc, or a choice in a menu that closes on select. */
  onClose?(): void;
  /**
   * Controlled highlight, for a menu driven by another control (an
   * autocomplete input). With it, the menu leaves the keyboard to that control.
   */
  highlightedId?: string | null;
  onHighlight?(id: string): void;
}

export interface UiHost {
  kind?: "opentui" | "desktop-web";
  capabilities?: {
    nativePaneChrome?: boolean;
    titleBarOverlay?: boolean;
    /** Native drag regions and traffic-light/window-control spacing. */
    nativeWindowChrome?: boolean;
    /** Enables public snapshot sharing controls for this host. */
    publicSharing?: boolean;
    precisePointer?: boolean;
    fractionalViewport?: boolean;
    cellWidthPx?: number;
    cellHeightPx?: number;
    pixelRatio?: number;
    canvasCharts?: boolean;
    nativeCharts?: boolean;
    nativeContextMenu?: boolean;
    windowControls?: "windows";
  };
  Box: ComponentType<BoxProps>;
  Text: ComponentType<TextProps>;
  Span: ComponentType<TextProps>;
  Strong: ComponentType<TextProps>;
  Underline: ComponentType<TextProps>;
  ScrollBox: ComponentType<ScrollBoxProps>;
  Input: ComponentType<InputProps>;
  Textarea: ComponentType<TextareaProps>;
  ChartSurface: ComponentType<ChartSurfaceProps>;
  /** Optional GPU 3D surface; hosts without it use the software raster. */
  Surface3D?: ComponentType<Surface3DHostProps>;
  ImageSurface: ComponentType<ImageSurfaceProps>;
  MediaSurface: ComponentType<MediaSurfaceProps>;
  SpinnerMark: ComponentType<SpinnerMarkProps>;
  AsciiText: ComponentType<AsciiTextProps>;
  Button?: ComponentType<any>;
  TextField?: ComponentType<any>;
  MessageComposer?: ComponentType<any>;
  ListView?: ComponentType<any>;
  SegmentedControl?: ComponentType<any>;
  DialogFrame?: ComponentType<any>;
  PageStackView?: ComponentType<any>;
  Tabs?: ComponentType<HostTabsProps>;
  Checkbox?: ComponentType<HostCheckboxProps>;
  Popover?: ComponentType<HostPopoverProps>;
  Menu?: ComponentType<HostMenuProps>;
  /** Props are `IconProps` / `IconButtonProps` from components/ui/icon. */
  Icon?: ComponentType<any>;
  IconButton?: ComponentType<any>;
  /** Props are `SelectFieldProps` from components/ui/select-field. */
  SelectField?: ComponentType<any>;
  QueryBar?: ComponentType<HostQueryBarProps>;
  DataTable?: ComponentType<any>;
  createSyntaxStyle?(): SyntaxStyleLike;
  colorFromHex?(hex: string): unknown;
}

export interface SaveTextFileRequest {
  name: string;
  text: string;
  mimeType: string;
}

export interface RendererHost {
  requestExit(): void;
  startWindowDrag?(): Promise<void> | void;
  controlWindow?(action: "minimize" | "toggle-maximize" | "close"): Promise<void> | void;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  copyPngImage?(pngBase64: string): Promise<void>;
  readText(): Promise<string>;
  saveTextFile?(request: SaveTextFileRequest): Promise<string>;
  supportsNativeDesktopNotifications?: boolean;
  notify(notification: AppNotificationRequest): void;
  showContextMenu?(items: ContextMenuItem[]): Promise<boolean>;
  playTerminalMedia?(url: string, title?: string, options?: { muted?: boolean }): Promise<void>;
  /** Stop terminal playback started by `playTerminalMedia`. */
  stopTerminalMedia?(): void;
}

interface UiHostContextValue {
  ui: UiHost;
  renderer: RendererHost;
  nativeRenderer: NativeRendererHost;
}

const noopNativeRenderer: NativeRendererHost = {
  terminalWidth: 0,
  terminalHeight: 0,
  resolution: null,
  on() {},
  off() {},
  requestRender() {},
  registerLifecyclePass() {},
  unregisterLifecyclePass() {},
};

const UiHostContext = createContext<UiHostContextValue | null>(null);

export function UiHostProvider({
  ui,
  renderer,
  nativeRenderer = noopNativeRenderer,
  children,
}: {
  ui: UiHost;
  renderer: RendererHost;
  nativeRenderer?: NativeRendererHost;
  children: ReactNode;
}) {
  return (
    <UiHostContext value={{ ui, renderer, nativeRenderer }}>
      {children}
    </UiHostContext>
  );
}

export function useUiHost(): UiHost {
  const context = useContext(UiHostContext);
  if (!context) {
    throw new Error("useUiHost must be used inside UiHostProvider");
  }
  return context.ui;
}

export function useUiCapabilities(): NonNullable<UiHost["capabilities"]> {
  return useUiHost().capabilities ?? {};
}

/**
 * The binding this host advertises for the command bar, for any copy that has
 * to name it. Read from the keybinding table and the host rather than
 * hardcoded, so a hint never quotes a key the header does not.
 */
export function useCommandBarShortcut(): string {
  return useActionShortcut("command-bar");
}

/**
 * The key this host advertises for a keybinding action (`pane-menu`,
 * `pane-close`, `plugin:<id>`), for tooltips and menus. Empty when unbound.
 */
export function useActionShortcut(actionId: string): string {
  const keybindings = useKeybindings();
  // Display only, so a surface rendered outside the host (a toast in a test)
  // still gets a label rather than an error.
  const kind = useContext(UiHostContext)?.ui.kind;
  return formatAdvertisedChord(keybindings, actionId, getShortcutDisplayMode(kind));
}

export function useRendererHost(): RendererHost {
  const context = useContext(UiHostContext);
  if (!context) {
    throw new Error("useRendererHost must be used inside UiHostProvider");
  }
  return context.renderer;
}

export function useNativeRenderer(): NativeRendererHost {
  const context = useContext(UiHostContext);
  if (!context) {
    throw new Error("useNativeRenderer must be used inside UiHostProvider");
  }
  if (!context.nativeRenderer) {
    throw new Error("Native renderer APIs are not available in this host");
  }
  return context.nativeRenderer;
}

export function useSyntaxStyleFactory(): {
  createSyntaxStyle(): SyntaxStyleLike | null;
  colorFromHex(hex: string): unknown;
} {
  const ui = useUiHost();
  return {
    createSyntaxStyle: () => ui.createSyntaxStyle?.() ?? null,
    colorFromHex: (hex) => ui.colorFromHex?.(hex) ?? hex,
  };
}

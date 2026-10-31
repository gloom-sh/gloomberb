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
  /** Per-series dots on the cursor column, in bitmap pixels; hollow for a value carried from an earlier observation. */
  markers?: readonly { pixelY: number; color: string; hollow?: boolean }[];
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
  /** Closes the points into a filled polygon, such as a flow ribbon, with no outline. */
  fill?: boolean;
  fillOpacity?: number;
  strokeWidth?: number;
  handles?: boolean;
  /** Paints the fill or line left to right through these colours instead of `color`. */
  gradient?: readonly string[];
  /** Opacity of the whole shape, so others can recede behind a highlighted one. */
  opacity?: number;
  /** Text set just above the shape's first point, such as a retracement level's ratio and price. */
  label?: string;
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

/** Where a drag has a box this frame, in cells. */
export interface LiveBoxFrame {
  /** Offset from where the box is laid out, carried on the box's own layer. */
  dx?: number;
  dy?: number;
  /** Position in place of the laid-out one (left and top in its parent): laid out again, with no layer of its own. */
  x?: number;
  y?: number;
  /** Size in place of the laid-out one: the box and what stretches inside it lay out again, nothing renders. */
  width?: number;
  height?: number;
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
  /**
   * Desktop only: draws the box at `frame` by restyling its own element, with
   * no render, until it is called with null. The offset rides the compositor,
   * so it costs no layout or repaint; a size lays out the box's own subtree.
   */
  setLiveFrame?: (frame: LiveBoxFrame | null) => void;
  /**
   * Desktop only: calls `listener` with the box's size in cells each time the
   * browser lays it out at a new one (a ResizeObserver, after layout and
   * before paint). A box that is not displayed (a hidden tab) reports
   * nothing; the first size once it shows again comes with `revealed`.
   * Returns the unsubscribe.
   */
  observeSize?: (listener: (size: { width: number; height: number }, change: { revealed: boolean }) => void) => () => void;
  /**
   * Desktop only, for a surface root (a chart, a heat map): fills the box the
   * surface sits in where its cells leave a fraction of a cell, refits when
   * that box changes size at rest, and takes part in every resize (see
   * `followsFrame`). Returns the untrack.
   */
  trackSurface?: () => () => void;
  /** Desktop only: fits a tracked surface to its box again, after it renders at new cells. */
  refitSurface?: () => void;
  /**
   * Desktop only, during a resize: the axes on which CSS keeps a tracked
   * surface on the frame's size by itself, to the pixel.
   */
  followsFrame?: () => { x: boolean; y: boolean };
  [key: string]: unknown;
}

interface ScrollBarRenderable {
  visible: boolean;
  /** Terminal only: whether a click on the bar moves the keyboard focus to it. */
  focusable?: boolean;
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
  /** In the terminal, `y` is the viewport's top row on screen, as laid out last. */
  viewport?: { y?: number; width: number; height: number };
  viewportPx?: { width: number; height: number };
  visible?: boolean;
  parent?: unknown;
  getBoundingClientRect?: () => { x: number; y: number; width: number; height: number };
  horizontalScrollBar?: ScrollBarRenderable;
  verticalScrollBar?: ScrollBarRenderable;
  scrollTo(target: number | { x?: number; y?: number }, y?: number): void;
  scrollToPixels?(target: number | { x?: number; y?: number }, y?: number): void;
  /** A windowed list mounts and measures the target before finishing the scroll. */
  scrollToItem?(key: string, options?: { align?: "auto" | "start" | "center" | "end"; offset?: number }): boolean;
  scrollToEnd?(): void;
  /** Terminal only: the scrolled content, whose descendants carry their screen rows as laid out last. */
  content?: { findDescendantById?(id: string): { y: number; height: number } | undefined };
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

/**
 * One styled run of a rendered terminal row; colours are 0-255 RGBA.
 * @public
 */
export interface NativeFrameSpan {
  text: string;
  fg: readonly [number, number, number, number];
  bg: readonly [number, number, number, number];
  attributes: number;
}

/** One cell of a captured frame, in the colours it shows (inverse and dim applied). */
interface NativeFrameCell {
  /** Empty for the second cell of a wide character. */
  char: string;
  fg: string;
  bg: string;
  bold: boolean;
}

/** A picture of part of the screen, as `capturePaneImage` draws it. */
export interface NativePaneImage {
  png: Uint8Array;
  width: number;
  height: number;
  /** The same picture as RGBA pixels, for a preview drawn in cells. */
  pixels: Uint8ClampedArray;
  /**
   * The cells it was drawn from, row by row, for a preview where they fit.
   * Absent when kitty images were drawn in: the cells under them are blank.
   */
  cells?: { cols: number; rows: number; cells: NativeFrameCell[] };
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
  /**
   * @deprecated Plugins handle keys with `useShortcut` from `gloomberb/react`.
   * The desktop and web renderers only emulate this terminal key stream, and
   * that emulation will be removed; the field stays for the terminal host.
   */
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
  /**
   * Terminal renderers only: a PNG of a rectangle of the frame shown now, in
   * cells, its characters drawn in a bundled font and its kitty images put back.
   */
  capturePaneImage?(rect: { x: number; y: number; width: number; height: number }): Promise<NativePaneImage>;
  copyToClipboardOSC52?(text: string): boolean;
  write?(data: string | Uint8Array): boolean;
  captureMouseRenderable?(renderable: unknown): void;
  /**
   * Terminal renderers only: whether kitty graphics can be drawn, `null` until
   * the terminal answers. A host without it never draws kitty graphics.
   */
  getKittySupport?(): boolean | null;
  /** Terminal renderers only: asks the terminal about kitty graphics once and keeps the answer. */
  ensureKittySupport?(): Promise<boolean>;
  /** Terminal renderers only: keeps kitty images clear of the panes, menus and dialogs drawn over them. */
  nativeSurfaceManager?: Pick<
    import("../components/chart/native/surface/manager").NativeSurfaceManager,
    "setWindowState" | "upsertLocalOccluder" | "removeLocalOccluder" | "visibleImages"
  >;
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
  /**
   * Draw `children` until the image has loaded, not only without a `src` or
   * once it fails, so a box that waits on a picture shows its stand-in rather
   * than an empty one. The terminal always does.
   */
  fallbackWhileLoading?: boolean;
  /**
   * A colour behind the picture once it has loaded (a logo made for a light
   * page), never behind `children`. The terminal draws none.
   */
  imageBackground?: string;
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
export type AudioPlaybackState = "idle" | "loading" | "playing" | "paused" | "ended" | "error";
/** What a pane does to its audio player: the keys and lines that drive it. */
export interface AudioPlayerHandle {
  play(): Promise<void>;
  pause(): void;
  toggle(): Promise<void>;
  /** Moves to `seconds`; `play` also starts it from there. */
  seek(seconds: number, options?: { play?: boolean }): void;
  seekBy(deltaSeconds: number): void;
  currentTime(): number;
}
/**
 * A transport bar over one audio source (play, the elapsed and total time, a
 * seek track, the speed), drawn by hosts that can play media. The pane owns
 * the source and the speed and hears where playback is.
 */
export interface HostAudioPlayerProps {
  src: string;
  /** Says which recording `src` is: a new address for the same one keeps the position and whether it plays. */
  sourceKey: string;
  /** Accessible name of the player. */
  label: string;
  /** Length known before the media loads, in seconds. */
  durationSeconds?: number | null;
  rates: readonly number[];
  rate: number;
  onRateChange(rate: number): void;
  handleRef?: Ref<AudioPlayerHandle | null>;
  /** Called as playback moves, a few times a second, and on every seek. */
  onTimeUpdate?(seconds: number): void;
  onStateChange?(state: AudioPlaybackState): void;
  onError?(message: string): void;
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
  /** Artwork before the label, such as a logo; decoration only. */
  leading?: ReactNode;
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
  /** A press that moves, on a tab that is not reordered. */
  onDrag?: () => void;
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
  /**
   * Terminal only: drop the column kept for the `>` focus marker, so the box
   * lines up with the fields above it in a dialog that never moves focus there.
   */
  flush?: boolean;
}

interface HostQueryBarOption {
  value: string;
  label: string;
  group?: string;
  description?: string;
  disabled?: boolean;
  selected: boolean;
  /** Shortcut key for the option. */
  hint?: string;
  /** Tints the option's label, e.g. a status in its tone. */
  color?: string;
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
  /** Drawn before the search and filters, e.g. the ticker the list is about. */
  leading?: ReactNode;
  /** Opens one item's menu, e.g. from a pane shortcut. The token changes per request. */
  openRequest?: { id: string; token: number } | null;
}

export interface HostPopoverProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  trigger: ReactNode;
  children: ReactNode;
  anchorPoint?: { x: number; y: number } | null;
  /**
   * Opens beside this element instead of the trigger, such as a name the
   * pointer is on: below it with the left edges aligned, above it when there
   * is no room below, and kept inside the boundary. A Box ref is one. Read
   * each time the popover places itself, so it follows the element when the
   * page scrolls.
   */
  anchor?: BoxRenderable | null;
  /** `pane` also keeps the popover inside the pane it opens from. Default `viewport`. */
  boundary?: "viewport" | "pane";
  /** The pointer came onto the popover, e.g. to keep a hover card open while it is used. */
  onPointerEnter?: () => void;
  /** The pointer left the popover. */
  onPointerLeave?: () => void;
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
  /** Tints the label, e.g. a status in its tone; the words carry the meaning. */
  color?: string;
  /** Artwork before the label, such as a logo; decoration only. */
  leading?: ReactNode;
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
  /** Hosts that play audio draw it; the terminal has none and draws nothing. */
  AudioPlayer?: ComponentType<HostAudioPlayerProps>;
  SpinnerMark: ComponentType<SpinnerMarkProps>;
  AsciiText: ComponentType<AsciiTextProps>;
  Button?: ComponentType<any>;
  TextField?: ComponentType<any>;
  MessageComposer?: ComponentType<any>;
  ListView?: ComponentType<any>;
  SegmentedControl?: ComponentType<any>;
  DialogFrame?: ComponentType<any>;
  /** Props are `DialogActionsProps` from components/ui/dialog-actions. */
  DialogActions?: ComponentType<any>;
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
  /** Props are WindowedListProps from components/ui/windowed-list. */
  WindowedList?: ComponentType<any>;
  createSyntaxStyle?(): SyntaxStyleLike;
  colorFromHex?(hex: string): unknown;
}

/** @public */
export interface SaveTextFileRequest {
  name: string;
  text: string;
  mimeType: string;
}

export interface RendererHost {
  requestExit(): void;
  /**
   * From a press on a title bar. `press.detail` counts the clicks: where the
   * system's title bars maximize on a double-click, the second press does that
   * instead of moving the window.
   */
  startWindowDrag?(press?: { detail?: number }): Promise<void> | void;
  controlWindow?(action: "minimize" | "toggle-maximize" | "close"): Promise<void> | void;
  /**
   * Opens a link in the person's browser. Resolves false when no browser could
   * be shown from here (a terminal over SSH, or no opener installed), so the
   * caller can show the link instead; void when the host cannot tell.
   */
  openExternal(url: string): Promise<boolean | void>;
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

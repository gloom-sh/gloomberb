import type { AppConfig, LayoutConfig } from "./config";
import type { WizardStep } from "./plugin-shared";

export interface CommandShortcutArgContext {
  activeTicker: string | null;
}

interface CommandShortcutArgDef {
  placeholder?: string;
  kind?: "text" | "ticker" | "ticker-list";
  parse?: (
    arg: string,
    context: CommandShortcutArgContext,
  ) => Record<string, string>;
}

export interface CommandResultDef {
  id: string;
  label: string;
  detail?: string;
  category?: string;
  /** Short tag drawn left of the label, as on a search provider's row. Six characters at most. */
  badge?: string;
  /** Drawn muted after the label, e.g. a person's full name after their @username. */
  name?: string;
  right?: string;
  keywords?: string[];
  current?: boolean;
  disabled?: boolean;
  execute: () => void | Promise<void>;
}

export interface CommandBarResultLineSegment {
  text: string;
  emphasis?: "match" | "muted";
}

export interface CommandBarResultLine {
  segments: CommandBarResultLineSegment[];
}

export interface CommandBarResultDef {
  id: string;
  label: string;
  detail?: string;
  /** Rendered under the label. Each entry is one additional row. */
  lines?: CommandBarResultLine[];
  category?: string;
  /** Short tag drawn left of the label, e.g. a document type. Six characters at most. */
  badge?: string;
  /** Drawn muted after the label, e.g. a person's full name after their @username. */
  name?: string;
  right?: string;
  keywords?: string[];
  disabled?: boolean;
  execute: () => void | Promise<void>;
}

export interface CommandBarSearchContext {
  activeTicker: string | null;
  activeCollectionId: string | null;
}

export interface CommandBarSearchProvider {
  id: string;
  /** Section heading for these rows, e.g. "Documents". */
  category: string;
  /** Sort position of the section. Higher sinks. Navigation sections are negative; use a positive value to sit below them. */
  priority?: number;
  /** Skip the provider below this length. Default 3. */
  minQueryLength?: number;
  /** Default 300. Ignored by `match`. */
  debounceMs?: number;
  /**
   * How long `provide` may take once it starts, in ms. Default 8000. Past it
   * the bar aborts `signal`, drops a late answer and stops showing Searching.
   * Ignored by `match`.
   */
  timeoutMs?: number;
  /**
   * Codes (`CHAT`) after which the provider is still asked, typed alone or
   * with text after them, with the whole query. Every other provider stays
   * quiet once a code claims the text.
   */
  shortcuts?: readonly string[];
  provide(
    query: string,
    context: CommandBarSearchContext,
    signal: AbortSignal,
  ): Promise<CommandBarResultDef[]>;
  /**
   * Rows from what the app already holds in memory. When set, the bar calls
   * this instead of `provide`, as it renders and on every keystroke, so it
   * must be cheap: no request, no waiting. Its rows are ranked with the bar's
   * own matches as they are typed and sit under Suggested in the empty bar.
   * Keep `provide` answering the same rows for older versions of the app.
   */
  match?(query: string, context: CommandBarSearchContext): CommandBarResultDef[];
}

export interface CommandDef {
  id: string;
  label: string;
  keywords: string[];
  shortcut?: string;
  shortcutArg?: CommandShortcutArgDef;
  buildResults?: (arg: string) => CommandResultDef[];
  execute: (values?: Record<string, string>) => void | Promise<void>;
  category: "navigation" | "data" | "portfolio" | "config";
  description?: string;
  wizard?: WizardStep[];
  confirm?: CommandConfirmDef | ((context: CommandConfirmContext) => CommandConfirmDef | null);
  /** @deprecated Ignored: a wizard always opens as one form with every step at once. */
  wizardLayout?: "steps" | "form";
  hidden?: () => boolean;
}

interface CommandConfirmContext {
  config: AppConfig;
  layout: LayoutConfig;
  activeTicker: string | null;
  activeCollectionId: string | null;
}

interface CommandConfirmDef {
  title: string;
  body: string[];
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
}

export interface KeyboardShortcut {
  id: string;
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  description: string;
  execute: () => void;
}

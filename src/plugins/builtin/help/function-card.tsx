/**
 * The help card for one function, opened by `HELP <fn>` in the command bar
 * and F1 on a focused pane: what it answers, how to type it, the keys that
 * matter in its pane, how fresh its data is on each plan, its Bloomberg
 * equivalent and its docs entry. Enter or the link opens the docs; Esc, the
 * close button or a click outside closes it.
 *
 * `useFunctionHelpHost` is mounted with the app's global shortcuts for the
 * life of the window and owns the dialog; `requestFunctionHelp` lets the
 * command bar and F1 open it.
 */
import { useEffect, useRef, type ReactNode } from "react";
import { usePlanAccess } from "../../../api-client/plan-access";
import { functionDocsUrl, type FunctionFreshness, type FunctionHelpKey } from "../../../cli/pane-functions/function-help";
import { requestFeedbackDialog } from "../../../components/feedback-dialog";
import { ExternalLink } from "../../../components/ui/external-link";
import { DialogFrame } from "../../../components/ui/frame";
import { ShortcutHint } from "../../../components/ui/shortcut-hint";
import { t } from "../../../i18n";
import { useViewport } from "../../../react/input";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, TextAttributes, useRendererHost } from "../../../ui";
import { useDialog, useDialogKeyboard, type AlertContext } from "../../../ui/dialog";
import type { HelpFunction } from "./function-index";

export type FunctionHelpRequest =
  | { kind: "function"; fn: HelpFunction }
  /** `HELP HELP`: the feedback dialog, which is how people reach us. */
  | { kind: "support" };

type FunctionHelpListener = (request: FunctionHelpRequest) => void;

const listeners = new Set<FunctionHelpListener>();

/** Opens the card (or support) over whatever is on screen. False when no window hosts it. */
export function requestFunctionHelp(request: FunctionHelpRequest): boolean {
  if (listeners.size === 0) return false;
  for (const listener of listeners) listener(request);
  return true;
}

/** Widest the card reads well; the terminal narrows it to the window. */
const CARD_WIDTH = 64;
/** Border plus padding the terminal dialog host draws around the content. */
const TERMINAL_DIALOG_CHROME = 6;
const LABEL_WIDTH = 11;
/** Below this many rows the longest card (three summary lines, an alias, two plans) no longer fits with its spacing. */
const COMPACT_BELOW_ROWS = 20;

function usageLines(fn: HelpFunction): readonly string[] {
  if (fn.help) return fn.help.usage;
  if (!fn.argPlaceholder) return [fn.code];
  const argument = `<${fn.argPlaceholder}>`;
  return fn.argOptional ? [fn.code, `${fn.code} ${argument}`] : [`${fn.code} ${argument}`];
}

function CardRow({ label, children }: { label: string; children: ReactNode }) {
  const colors = useThemeColors();
  return (
    <Box flexDirection="row">
      <Box width={LABEL_WIDTH} flexShrink={0}>
        <Text fg={colors.textDim}>{t(label)}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} flexShrink={1}>
        {children}
      </Box>
    </Box>
  );
}

function KeysRow({ keys }: { keys: readonly FunctionHelpKey[] }) {
  return (
    <Box flexDirection="row" flexWrap="wrap" gap={2}>
      {keys.map((hint) => <ShortcutHint key={`${hint.key}${hint.label}`} hotkey={hint.key} label={hint.label} />)}
    </Box>
  );
}

function FreshnessRows({ data, pro }: { data: FunctionFreshness; pro: boolean }) {
  const colors = useThemeColors();
  if (data.free === data.pro) {
    return <Text fg={colors.text} wrapText>{`${t(data.free)} · ${t("every plan")}`}</Text>;
  }
  const plans = [
    { plan: "Free", value: data.free, current: !pro },
    { plan: "Pro", value: data.pro, current: pro },
  ];
  return (
    <>
      {plans.map(({ plan, value, current }) => (
        <Box key={plan} flexDirection="row">
          <Box width={5} flexShrink={0}>
            <Text fg={current ? colors.textBright : colors.textDim} attributes={current ? TextAttributes.BOLD : 0}>{t(plan)}</Text>
          </Box>
          <Box flexShrink={1}>
            <Text fg={current ? colors.text : colors.textDim} wrapText>
              {current ? `${t(value)} · ${t("your plan")}` : t(value)}
            </Text>
          </Box>
        </Box>
      ))}
    </>
  );
}

function FunctionHelpCard({ fn, dismiss, dialogId, width, compact = false }: AlertContext & {
  fn: HelpFunction;
  width: number;
  /** A short terminal: no blank row between the summary and the rows. */
  compact?: boolean;
}) {
  const colors = useThemeColors();
  const rendererHost = useRendererHost();
  const access = usePlanAccess();
  const docsUrl = functionDocsUrl(fn.help?.docs ?? fn.code);
  const openDocs = (url: string = docsUrl) => {
    void rendererHost.openExternal(url);
    dismiss();
  };

  useDialogKeyboard((event) => {
    if (event.ctrl || event.alt || event.meta || event.super) return;
    const name = event.name ?? event.key;
    if (name !== "enter" && name !== "return") return;
    event.preventDefault();
    event.stopPropagation();
    openDocs();
  }, { scope: dialogId });

  const help = fn.help;
  return (
    <DialogFrame title={`${fn.code} · ${t(fn.name)}`} onClose={dismiss}>
      <Box flexDirection="column" width={width} gap={compact ? 0 : 1}>
        <Text fg={colors.text} wrapText width={width}>{t(help?.summary ?? fn.description)}</Text>
        <Box flexDirection="column">
          <CardRow label="Usage">
            {usageLines(fn).map((line) => <Text key={line} fg={colors.textBright}>{line}</Text>)}
            {fn.aliases.length > 0 && <Text fg={colors.textDim}>{`${t("also")} ${fn.aliases.join(", ")}`}</Text>}
          </CardRow>
          {help && help.keys.length > 0 && (
            <CardRow label="Keys">
              <KeysRow keys={help.keys} />
            </CardRow>
          )}
          {help?.data && (
            <CardRow label="Data">
              <FreshnessRows data={help.data} pro={access.hasProAccess} />
            </CardRow>
          )}
          {help && help.bloomberg.length > 0 && (
            <CardRow label="Bloomberg">
              <Text fg={colors.text}>{help.bloomberg.join(", ")}</Text>
            </CardRow>
          )}
          <CardRow label="Docs">
            <ExternalLink url={docsUrl} label={docsUrl.replace(/^https:\/\//, "")} onOpen={openDocs} />
          </CardRow>
        </Box>
      </Box>
    </DialogFrame>
  );
}

/**
 * Opens what `requestFunctionHelp` asks for. `closeCommandBar` runs first so
 * a card asked for from the bar replaces it rather than sitting under it.
 */
export function useFunctionHelpHost({ closeCommandBar }: { closeCommandBar: () => void }): void {
  const dialog = useDialog();
  const viewport = useViewport();
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const closeCommandBarRef = useRef(closeCommandBar);
  closeCommandBarRef.current = closeCommandBar;
  const openRef = useRef(false);

  useEffect(() => {
    const open = (request: FunctionHelpRequest) => {
      closeCommandBarRef.current();
      if (request.kind === "support") {
        requestFeedbackDialog();
        return;
      }
      if (openRef.current) return;
      openRef.current = true;
      const width = Math.max(30, Math.min(CARD_WIDTH, viewportRef.current.width - TERMINAL_DIALOG_CHROME - 4));
      const compact = viewportRef.current.height < COMPACT_BELOW_ROWS;
      void dialog.alert({
        closeOnClickOutside: true,
        // The terminal host defaults to 60 columns; the desktop sizes to the content.
        style: { width: width + TERMINAL_DIALOG_CHROME, ...(compact ? { paddingY: 0 } : {}) },
        content: (context: AlertContext) => <FunctionHelpCard {...context} fn={request.fn} width={width} compact={compact} />,
      }).catch(() => {}).finally(() => {
        openRef.current = false;
      });
    };
    listeners.add(open);
    return () => {
      listeners.delete(open);
    };
  }, [dialog]);
}

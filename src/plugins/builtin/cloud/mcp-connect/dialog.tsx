/**
 * "Connect an AI assistant": pick an MCP client, copy the one command or
 * config it needs. Signing in from the client needs no key; a key is the
 * fallback, created here through the account API and shown once.
 *
 * The command bar runs outside the React tree, so `requestMcpConnectDialog`
 * hands the request to `McpConnectDialogHost`, which the shell mounts for the
 * life of the app, like the sign-in dialogs. Surfaces that already hold the
 * dialog API (the account pane) call `openMcpConnectDialog` directly.
 *
 * The created key lives in this dialog's state only: it is never logged,
 * stored or synced, and it is gone once the dialog closes.
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { apiClient } from "../../../../api-client";
import { usePlanAccess } from "../../../../api-client/plan-access";
import { Button } from "../../../../components/ui/button";
import { Divider } from "../../../../components/ui/display";
import { ExternalLinkText } from "../../../../components/ui/external-link";
import { DialogFrame } from "../../../../components/ui/frame";
import { SegmentedControl } from "../../../../components/ui/toggle";
import { t, tf } from "../../../../i18n";
import { useAppLanguage } from "../../../../i18n/react";
import { useViewport } from "../../../../react/input";
import { useThemeColors } from "../../../../theme/theme-context";
import { Box, Text, TextAttributes, useRendererHost, useUiCapabilities } from "../../../../ui";
import { useDialog, useDialogKeyboard, type DialogApi, type PromptContext } from "../../../../ui/dialog";
import { isPlainKey } from "../../../../utils/keyboard";
import { useCloudUpgradeAction } from "../../shared/cloud-upgrade";
import { requestAuthDialog } from "../auth-dialog";
import {
  currentMcpEndpointUrl,
  MCP_CLIENTS,
  MCP_DOCS_URL,
  mcpClientSetup,
  mcpKeyFailure,
  type McpClientId,
  type McpKeyFailure,
} from "./model";
import { useMcpConnectSections } from "./sections";

/** Wide enough for a key and its closing quote on one snippet row. */
const MAX_CONTENT_WIDTH = 78;
const MIN_CONTENT_WIDTH = 32;
/** Border plus padding the terminal dialog host draws around the content. */
const TERMINAL_DIALOG_CHROME = 6;
/** The access a key made here gets: the server's default, as in Cloud settings. */
const KEY_SCOPE = "read";

/** Content width for a viewport: as wide as a command line reads well, never wider than the screen. */
function mcpConnectContentWidth(viewportWidth: number | undefined): number {
  const available = (viewportWidth ?? MAX_CONTENT_WIDTH + 10) - 10;
  return Math.max(MIN_CONTENT_WIDTH, Math.min(MAX_CONTENT_WIDTH, Math.floor(available)));
}

type KeyState =
  | { phase: "idle" }
  | { phase: "creating" }
  | { phase: "created"; token: string; name: string }
  | { phase: "failed"; failure: McpKeyFailure };

type Status = { tone: "positive" | "warning" | "negative" | "muted"; text: string } | null;

function useCloudSignedIn(): boolean {
  return useSyncExternalStore(
    (onChange) => apiClient.subscribeCurrentUser(onChange),
    () => apiClient.isSignedIn(),
    () => apiClient.isSignedIn(),
  );
}

function statusColor(tone: NonNullable<Status>["tone"], colors: ReturnType<typeof useThemeColors>): string {
  if (tone === "muted") return colors.textDim;
  return colors[tone];
}

/**
 * The snippet, one row per line. A line with the key in it runs past the
 * block, and breaking it at its spaces strands a word per row, so it wraps at
 * the edge, as a shell prints it; every other line wraps at its spaces.
 */
function SnippetBlock({ text, secret, width }: { text: string; secret: string | null; width: number }) {
  const colors = useThemeColors();
  const { nativePaneChrome } = useUiCapabilities();
  return (
    <Box
      flexDirection="column"
      width={width}
      paddingX={1}
      backgroundColor={nativePaneChrome ? colors.bg : colors.panel}
      style={nativePaneChrome ? { padding: "8px 10px", borderRadius: 4 } : undefined}
      data-gloom-role="mcp-connect-snippet"
    >
      {text.split("\n").map((line, index) => {
        const atEdge = !!secret && line.includes(secret);
        return (
          <Text
            key={index}
            fg={colors.textBright}
            wrapText
            wrapMode={atEdge ? "char" : "word"}
            style={nativePaneChrome && atEdge ? { wordBreak: "break-all" } : undefined}
          >
            {line || " "}
          </Text>
        );
      })}
    </Box>
  );
}

function McpConnectDialog({
  dialogId,
  dismiss,
  width: openedWidth,
}: PromptContext<void> & { width: number }) {
  useAppLanguage();
  // Follows a window or terminal resized while the dialog is open. The
  // terminal's box keeps the width it opened with, so the content never
  // grows past it there; the desktop sizes the box to the content.
  const viewport = useViewport();
  const { nativePaneChrome } = useUiCapabilities();
  const fit = mcpConnectContentWidth(viewport.width);
  const width = nativePaneChrome ? fit : Math.min(openedWidth, fit);
  const colors = useThemeColors();
  const renderer = useRendererHost();
  const access = usePlanAccess();
  const signedIn = useCloudSignedIn();
  const openUpgrade = useCloudUpgradeAction("mcp-connect");
  const sections = useMcpConnectSections();
  const endpoint = useMemo(() => currentMcpEndpointUrl(), []);
  const [client, setClient] = useState<McpClientId>("claude-code");
  const [key, setKey] = useState<KeyState>({ phase: "idle" });
  const [copyStatus, setCopyStatus] = useState<Status>(null);
  const [keyStatus, setKeyStatus] = useState<Status>(null);
  const creatingRef = useRef(false);
  const liveRef = useRef(true);
  useEffect(() => () => {
    liveRef.current = false;
  }, []);
  // A sign-in or an upgrade made from this dialog changes the session; a
  // failure from before it no longer says anything.
  useEffect(() => apiClient.subscribeCurrentUser(() => {
    setKey((current) => (current.phase === "failed" ? { phase: "idle" } : current));
  }), []);

  const token = key.phase === "created" ? key.token : null;
  const clientDef = MCP_CLIENTS.find((entry) => entry.id === client) ?? MCP_CLIENTS[0]!;
  const setup = mcpClientSetup(client, endpoint, token);

  const selectClient = useCallback((next: string) => {
    if (!MCP_CLIENTS.some((entry) => entry.id === next)) return;
    setClient(next as McpClientId);
    setCopyStatus(null);
  }, []);

  const copy = useCallback(async (text: string, done: string, report: (status: Status) => void) => {
    try {
      await renderer.copyText(text);
      report({ tone: "positive", text: done });
    } catch {
      report({ tone: "warning", text: t("Copy failed. Select the text above.") });
    }
  }, [renderer]);

  const copySetup = useCallback(() => copy(setup.text, t("Copied."), setCopyStatus), [copy, setup.text]);

  const createKey = useCallback(async () => {
    if (creatingRef.current || token) return;
    creatingRef.current = true;
    setKey({ phase: "creating" });
    setKeyStatus(null);
    try {
      const created = await apiClient.createMcpKey({ name: clientDef.keyName, scope: KEY_SCOPE });
      if (!liveRef.current) return;
      setKey({ phase: "created", token: created.token, name: created.apiKey.name || clientDef.keyName });
      setCopyStatus(null);
    } catch (error) {
      if (liveRef.current) setKey({ phase: "failed", failure: mcpKeyFailure(error) });
    } finally {
      creatingRef.current = false;
    }
  }, [clientDef.keyName, token]);

  const signIn = useCallback(() => {
    // Stacks over this dialog; the key row follows the session once it lands.
    if (!requestAuthDialog({ mode: "login" })) {
      setKeyStatus({ tone: "warning", text: t("Sign-in is not available right now.") });
    }
  }, []);

  const failure = key.phase === "failed" ? key.failure : null;
  // `hint` is the footer's word for the same action.
  const keyAction = ((): { label: string; hint: string; run: () => void; disabled?: boolean } => {
    if (token) return { label: t("Copy key"), hint: t("copy key"), run: () => { void copy(token, t("Key copied."), setKeyStatus); } };
    if (!signedIn || failure?.kind === "signin") return { label: t("Sign in to Gloom Cloud"), hint: t("sign in"), run: signIn };
    if (!access.hasProAccess || failure?.kind === "pro") {
      return { label: t("Upgrade to Pro"), hint: t("upgrade"), run: () => { void openUpgrade(); } };
    }
    if (key.phase === "creating") return { label: t("Creating..."), hint: t("create a key"), run: () => {}, disabled: true };
    return { label: t("Create a key"), hint: t("create a key"), run: () => { void createKey(); } };
  })();

  // What the key row says beside its button: the plan the key needs, or why
  // the last attempt failed. Signed out, the button says it all.
  const keyNote: Status = (() => {
    if (token || failure?.kind === "signin") return null;
    if (failure?.kind === "offline") return { tone: "muted", text: t(failure.message) };
    if (failure?.kind === "refused") return { tone: "warning", text: t(failure.message) };
    if (signedIn && (!access.hasProAccess || failure?.kind === "pro")) {
      return { tone: "muted", text: t("The MCP server is part of Gloom Pro.") };
    }
    return null;
  })();

  useDialogKeyboard((event) => {
    if (isPlainKey(event, "c", "enter", "return")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      void copySetup();
      return;
    }
    if (isPlainKey(event, "k")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      if (!keyAction.disabled) keyAction.run();
      return;
    }
    if (isPlainKey(event, "d")) {
      event.preventDefault?.();
      event.stopPropagation?.();
      void renderer.openExternal(MCP_DOCS_URL).catch(() => {});
      return;
    }
    if (event.name === "escape") {
      event.stopPropagation?.();
      dismiss();
    }
  }, { scope: dialogId });

  const footer = tf("c copy · ←/→ client · k {action} · d docs · Esc close", { action: keyAction.hint });
  const narrow = width < 46;

  return (
    <DialogFrame
      title={t("Connect an AI assistant")}
      subtitle={t("Gloom's research tools in Claude Code, Codex, Cursor or any MCP client.")}
      // Too narrow for the key line, which is a keyboard's business anyway (a phone).
      footer={narrow ? undefined : footer}
      onClose={dismiss}
    >
      <Box flexDirection="column" width={width} gap={1}>
        {/* A row, so the desktop control is as wide as its options rather than the dialog. */}
        <Box flexDirection="row">
          <SegmentedControl
            options={MCP_CLIENTS.map((entry) => ({ label: t(entry.label), value: entry.id }))}
            value={client}
            onChange={selectClient}
            focused
            shortcutScope={dialogId}
            wrap={narrow}
          />
        </Box>

        <Box flexDirection="column">
          <Text fg={colors.textDim} wrapText>{t(setup.hint)}</Text>
          <Box height={1} />
          <SnippetBlock text={setup.text} secret={token} width={width} />
          <Box height={1} />
          <Box flexDirection="row" gap={2} alignItems="center">
            <Button label={t("Copy")} shortcut="c" variant="primary" onPress={() => { void copySetup(); }} />
            {copyStatus ? <Text fg={statusColor(copyStatus.tone, colors)}>{copyStatus.text}</Text> : null}
          </Box>
        </Box>

        <Box flexDirection="column" data-gloom-role="mcp-connect-key">
          {/* The terminal separates the two paths with a blank row; the desktop draws a rule. */}
          {nativePaneChrome ? <Divider width={width} /> : null}
          {key.phase === "created" ? (
            <Text fg={colors.warning} attributes={TextAttributes.BOLD} wrapText>
              {tf("Key for {name} created. It is filled in above and is shown only once.", { name: key.name })}
            </Text>
          ) : (
            <Text fg={colors.textDim}>{t("Use a key instead")}</Text>
          )}
          <Box flexDirection="row" gap={2} alignItems="center" flexWrap="wrap">
            <Button
              label={keyAction.label}
              shortcut="k"
              disabled={keyAction.disabled}
              onPress={keyAction.run}
            />
            {keyStatus ?? keyNote ? (
              <Text fg={statusColor((keyStatus ?? keyNote)!.tone, colors)} wrapText>{(keyStatus ?? keyNote)!.text}</Text>
            ) : null}
          </Box>
        </Box>

        {sections.map((section) => (
          <Box key={section.id} flexDirection="column">
            {nativePaneChrome ? <Divider width={width} /> : null}
            <section.Component width={width} dialogId={dialogId} />
          </Box>
        ))}

        <Box flexDirection="row" gap={1}>
          <Text fg={colors.textDim}>{t("Tools and access levels:")}</Text>
          <ExternalLinkText url={MCP_DOCS_URL} label="gloom.sh/docs/mcp" />
        </Box>
      </Box>
    </DialogFrame>
  );
}

/** Opens the dialog and settles once it closes. */
export function openMcpConnectDialog(dialog: DialogApi, options: { viewportWidth?: number } = {}): Promise<void> {
  const width = mcpConnectContentWidth(options.viewportWidth);
  return dialog
    .prompt<void>({
      // A click beside it must not throw away a key that is shown once.
      closeOnClickOutside: false,
      // The terminal host defaults to 60 columns; the desktop sizes to the content.
      style: { width: width + TERMINAL_DIALOG_CHROME },
      content: (context) => <McpConnectDialog {...context} width={width} />,
    })
    .then(() => {}, () => {});
}

const dialogRequestListeners = new Set<() => void>();

/** Returns false when no dialog host is mounted, so callers can fall back. */
export function requestMcpConnectDialog(): boolean {
  if (dialogRequestListeners.size === 0) return false;
  for (const listener of dialogRequestListeners) listener();
  return true;
}

export function McpConnectDialogHost() {
  const dialog = useDialog();
  const viewport = useViewport();
  const viewportWidthRef = useRef(viewport.width);
  viewportWidthRef.current = viewport.width;
  const openRef = useRef(false);

  useEffect(() => {
    const listener = () => {
      if (openRef.current) return;
      openRef.current = true;
      void openMcpConnectDialog(dialog, { viewportWidth: viewportWidthRef.current }).finally(() => {
        openRef.current = false;
      });
    };
    dialogRequestListeners.add(listener);
    return () => {
      dialogRequestListeners.delete(listener);
    };
  }, [dialog]);

  return null;
}

import { useEffect } from "react";
import { Box, useUiHost } from "../ui";
import { ConfirmDialog } from "../components/ui/confirm-dialog";
import { KeyValueRow } from "../components/ui/display";
import { useViewport } from "../react/input";
import type { DialogApi, PromptContext } from "../ui/dialog";
import type { RemoteChangePrompt } from "./types";

const WIDTH = 52;
const MIN_WIDTH = 24;
/** The terminal dialog's border and padding around its content. */
const TERMINAL_FRAME_COLUMNS = 8;
const LABEL_WIDTH = 11;
/** The change asks on its own, maybe mid-keystroke: Enter or `y` typed just before it opened do not approve it. */
const KEY_GRACE_MS = 600;

export function RemoteChangeDialog({
  resolve,
  dismiss,
  dialogId,
  prompt,
  signal,
  keyGraceMs = KEY_GRACE_MS,
}: PromptContext<boolean> & { prompt: RemoteChangePrompt; signal?: AbortSignal; keyGraceMs?: number }) {
  const viewport = useViewport();
  const terminal = useUiHost().kind === "opentui";
  // A narrow terminal gets a narrower dialog rather than a clipped one.
  const width = terminal ? Math.max(MIN_WIDTH, Math.min(WIDTH, viewport.width - TERMINAL_FRAME_COLUMNS)) : WIDTH;

  useEffect(() => {
    if (!signal) return;
    const decline = () => resolve(false);
    if (signal.aborted) {
      decline();
      return;
    }
    signal.addEventListener("abort", decline, { once: true });
    return () => signal.removeEventListener("abort", decline);
  }, [resolve, signal]);

  return (
    <ConfirmDialog
      resolve={resolve}
      dismiss={dismiss}
      dialogId={dialogId}
      title={prompt.title}
      body={(
        <Box flexDirection="column" width={width}>
          {prompt.lines.map((line) => (
            <KeyValueRow
              key={line.label}
              label={line.label}
              value={line.value}
              width={width}
              labelWidth={LABEL_WIDTH}
            />
          ))}
        </Box>
      )}
      confirmLabel={prompt.confirmLabel}
      confirmVariant={prompt.destructive ? "danger" : "primary"}
      width={width}
      keyGraceMs={keyGraceMs}
    />
  );
}

/**
 * Asks the person to approve one change a remote caller asked for. Resolves
 * true only on Add or Remove; Cancel, Esc, a closed dialog or an aborted
 * `signal` resolve false.
 */
export async function confirmRemoteChange(
  dialog: DialogApi,
  prompt: RemoteChangePrompt,
  signal?: AbortSignal,
): Promise<boolean> {
  if (signal?.aborted) return false;
  const answer = await dialog.prompt<boolean>({
    closeOnClickOutside: false,
    closeOnEscape: true,
    content: (context) => <RemoteChangeDialog {...context} prompt={prompt} signal={signal} />,
  }).catch(() => false);
  return answer === true;
}

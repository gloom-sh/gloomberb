import type { ReactNode } from "react";
import { useMemo } from "react";
import {
  DialogProvider as OpenTuiDialogProvider,
  type AlertContext as OpenTuiAlertContext,
  type AlertOptions as OpenTuiAlertOptions,
  type PromptContext as OpenTuiPromptContext,
  type PromptOptions as OpenTuiPromptOptions,
  useDialog as useOpenTuiDialog,
  useDialogState as useOpenTuiDialogState,
} from "@opentui-ui/dialog/react";
import { DialogHostProvider, type DialogApi } from "../../ui/dialog";

function renderDialogContent(content: unknown, context: Record<string, unknown>): ReactNode {
  return typeof content === "function"
    ? (content as (context: Record<string, unknown>) => ReactNode)(context)
    : content as ReactNode;
}

function normalizeDialogId(value: unknown): string | undefined {
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function OpenTuiDialogContentBridge({
  dialog,
  dialogId,
  children,
}: {
  dialog: DialogApi;
  dialogId: string | undefined;
  children: ReactNode;
}) {
  const isTopmost = useOpenTuiDialogState(
    (state) => normalizeDialogId(state.topDialog?.id) === dialogId,
  );
  return (
    <DialogHostProvider
      dialog={dialog}
      isOpen={true}
      dialogId={dialogId}
      keyboardEnabled={isTopmost}
    >
      {children}
    </DialogHostProvider>
  );
}

function OpenTuiDialogBridge({ children }: { children: ReactNode }) {
  const openTuiDialog = useOpenTuiDialog();
  const isOpen = useOpenTuiDialogState((state) => state.isOpen);
  const dialog = useMemo<DialogApi>(() => {
    const wrapAlertOptions = (options: Record<string, unknown>): OpenTuiAlertOptions => ({
      ...options,
      content: (context: OpenTuiAlertContext) => {
        const dialogId = normalizeDialogId(context.dialogId);
        return (
          <OpenTuiDialogContentBridge dialog={dialog} dialogId={dialogId}>
            {renderDialogContent(options.content, { ...context, dialogId })}
          </OpenTuiDialogContentBridge>
        );
      },
    });

    const wrapPromptOptions = <T,>(options: Record<string, unknown>): OpenTuiPromptOptions<T> => ({
      ...options,
      content: (context: OpenTuiPromptContext<T>) => {
        const dialogId = normalizeDialogId(context.dialogId);
        return (
          <OpenTuiDialogContentBridge dialog={dialog} dialogId={dialogId}>
            {renderDialogContent(options.content, { ...context, dialogId })}
          </OpenTuiDialogContentBridge>
        );
      },
    });

    return {
      alert: (options) => openTuiDialog.alert(wrapAlertOptions(options)),
      prompt: <T,>(options: Record<string, unknown>) => openTuiDialog.prompt<T>(wrapPromptOptions<T>(options)),
    };
  }, [openTuiDialog]);

  return (
    <DialogHostProvider dialog={dialog} isOpen={isOpen}>
      {children}
    </DialogHostProvider>
  );
}

export function OpenTuiDialogHostProvider({
  children,
  ...props
}: {
  children: ReactNode;
  [key: string]: unknown;
}) {
  return (
    <OpenTuiDialogProvider {...props}>
      <OpenTuiDialogBridge>
        {children}
      </OpenTuiDialogBridge>
    </OpenTuiDialogProvider>
  );
}

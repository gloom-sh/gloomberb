import { useMemo } from "react";
import { usePaneFooter, type PaneHint } from "../../../components";
import { t } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";

/**
 * Email, plan, and visibility are fixed account metadata already rendered in the
 * tabs, so the footer carries only what changes: the save action and the last
 * save or error message.
 */
export function useAccountManagementFooter({
  busy,
  hasSession,
  message,
  saveProfile,
}: {
  busy: "profile" | "password" | "alerts" | "billing" | "delete" | null;
  hasSession: boolean;
  message: { tone: "info" | "success" | "error"; text: string } | null;
  saveProfile: () => Promise<void>;
}) {
  const language = useAppLanguage();
  const footerHints = useMemo<PaneHint[]>(() => [
    { id: "save", key: "Ctrl+S", label: t("save"), onPress: () => { void saveProfile(); }, disabled: !!busy || !hasSession },
  ], [busy, hasSession, language, saveProfile]);

  usePaneFooter("account-management", () => ({
    info: [
      ...(busy ? [{ id: "busy", parts: [{ text: t("saving"), tone: "muted" as const }] }] : []),
      ...(message ? [{ id: "status", parts: [{ text: message.text, tone: message.tone === "error" ? "negative" as const : message.tone === "success" ? "positive" as const : "muted" as const }] }] : []),
    ],
    hints: footerHints,
  }), [busy, footerHints, language, message]);
}

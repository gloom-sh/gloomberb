import { useMemo } from "react";
import { usePaneFooter, type PaneHint } from "../../../components";
import type { AccountProfile } from "../../../api-client";
import { formatPlan, type AccountDraft } from "./model";
import { t } from "../../../i18n";
import { useAppLanguage } from "../../../i18n/react";

export function useAccountManagementFooter({
  busy,
  draft,
  hasSession,
  message,
  profile,
  saveProfile,
}: {
  busy: "profile" | "password" | "alerts" | "billing" | "delete" | null;
  draft: AccountDraft;
  hasSession: boolean;
  message: { tone: "info" | "success" | "error"; text: string } | null;
  profile: AccountProfile | null;
  saveProfile: () => Promise<void>;
}) {
  const language = useAppLanguage();
  const footerHints = useMemo<PaneHint[]>(() => [
    { id: "save", key: "Ctrl+S", label: t("save"), onPress: () => { void saveProfile(); }, disabled: !!busy || !hasSession },
  ], [busy, hasSession, language, saveProfile]);

  usePaneFooter("account-management", () => ({
    info: [
      ...(message ? [{ id: "status", parts: [{ text: message.text, tone: message.tone === "error" ? "negative" as const : message.tone === "success" ? "positive" as const : "muted" as const }] }] : []),
      ...(profile ? [
        { id: "account", parts: [{ text: profile.email, tone: "muted" as const }] },
        { id: "plan", parts: [{ text: formatPlan(profile.plan), tone: profile.plan === "pro" ? "positive" as const : "muted" as const }] },
        { id: "visibility", parts: [{ text: draft.profilePublic ? t("public") : t("private"), tone: "muted" as const }] },
      ] : []),
    ],
    hints: footerHints,
  }), [draft.profilePublic, footerHints, language, message, profile]);
}

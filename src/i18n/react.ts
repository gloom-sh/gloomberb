import { useSyncExternalStore } from "react";
import { getLanguage, getTranslationRevision, subscribeLanguage } from ".";

export function useAppLanguage() {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}

/** Re-renders when the language or any plugin-registered entry changes. */
export function useTranslationRevision() {
  return useSyncExternalStore(subscribeLanguage, getTranslationRevision, getTranslationRevision);
}

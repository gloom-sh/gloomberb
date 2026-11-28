import { useSyncExternalStore } from "react";
import { getLanguage, getTranslationRevision, subscribeLanguage } from ".";

export function useAppLanguage() {
  useTranslationRevision();
  return getLanguage();
}

const staticRevision = () => 0;

export function useTranslationRevision(enabled = true) {
  const getSnapshot = enabled ? getTranslationRevision : staticRevision;
  return useSyncExternalStore(subscribeLanguage, getSnapshot, getSnapshot);
}

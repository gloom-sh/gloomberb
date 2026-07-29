import { useSyncExternalStore } from "react";
import { getLanguage, subscribeLanguage } from ".";

export function useAppLanguage() {
  return useSyncExternalStore(subscribeLanguage, getLanguage, getLanguage);
}

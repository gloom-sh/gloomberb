import { useEffect } from "react";
import { applyLanguageFromConfig } from "../i18n";
import { useAppSelector } from "../state/app/context";

export function AppLanguageConfigObserver() {
  const language = useAppSelector((state) => state.config.language);

  useEffect(() => {
    applyLanguageFromConfig({ language });
  }, [language]);

  return null;
}

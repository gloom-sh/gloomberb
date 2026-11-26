import { useEffect } from "react";
import { applyLanguageFromConfig, setDisabledTranslationPlugins } from "../i18n";
import { useAppSelector } from "../state/app/context";

export function AppLanguageConfigObserver() {
  const language = useAppSelector((state) => state.config.language);
  const disabledPlugins = useAppSelector((state) => state.config.disabledPlugins);

  useEffect(() => {
    applyLanguageFromConfig({ language });
  }, [language]);

  useEffect(() => {
    setDisabledTranslationPlugins(disabledPlugins);
  }, [disabledPlugins]);

  return null;
}

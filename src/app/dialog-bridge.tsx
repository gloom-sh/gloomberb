import { useCallback, useContext, type ReactNode } from "react";
import { RemoteUiRegistryProvider, useRemoteUiRegistry } from "../remote/semantic-tree";
import { AppContext, getEffectiveThemeId, useAppSelector } from "../state/app/context";
import { ThemeProvider } from "../theme/theme-context";
import { useRegisterDialogBridge } from "../ui/dialog-bridge";
import { KeybindingsProvider, useKeybindings } from "./keybindings";

function DialogTheme({ children }: { children: ReactNode }) {
  const themeId = useAppSelector(getEffectiveThemeId);
  return <ThemeProvider themeId={themeId}>{children}</ThemeProvider>;
}

/**
 * Gives every dialog what the app gives its panes: the store, the theme, the
 * keybindings and the remote registry, so a form in a dialog reads state and
 * registers nodes like one in the app. Renders nothing.
 */
export function AppDialogBridge() {
  const store = useContext(AppContext);
  const registry = useRemoteUiRegistry();
  const keybindings = useKeybindings();
  const bridge = useCallback((content: ReactNode) => {
    const withKeybindings = <KeybindingsProvider value={keybindings}>{content}</KeybindingsProvider>;
    const withRegistry = registry
      ? <RemoteUiRegistryProvider registry={registry}>{withKeybindings}</RemoteUiRegistryProvider>
      : withKeybindings;
    return store
      ? <AppContext value={store}><DialogTheme>{withRegistry}</DialogTheme></AppContext>
      : withRegistry;
  }, [keybindings, registry, store]);
  useRegisterDialogBridge(bridge);
  return null;
}

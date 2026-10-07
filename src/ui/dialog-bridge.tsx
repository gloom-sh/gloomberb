import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";

/**
 * The dialog hosts wrap the app, so every dialog renders outside it and cannot
 * reach the app's store, remote registry or keybindings. The app registers a
 * bridge that puts those providers back, and each host wraps every layer's
 * content with it. Private to the hosts, like dialog-stack.
 */
export type DialogContentBridge = (content: ReactNode) => ReactNode;

type RegisterDialogBridge = (bridge: DialogContentBridge) => () => void;

const DialogBridgeRegistrationContext = createContext<RegisterDialogBridge | null>(null);

/** For a host: the bridge registered last, and the function its children register through. */
export function useDialogBridgeSlot(): { bridge: DialogContentBridge | null; register: RegisterDialogBridge } {
  const [bridges, setBridges] = useState<readonly DialogContentBridge[]>([]);
  const register = useCallback<RegisterDialogBridge>((bridge) => {
    setBridges((current) => [...current, bridge]);
    return () => setBridges((current) => current.filter((entry) => entry !== bridge));
  }, []);
  return { bridge: bridges.at(-1) ?? null, register };
}

export function DialogBridgeRegistrationProvider({
  register,
  children,
}: {
  register: RegisterDialogBridge;
  children: ReactNode;
}) {
  return <DialogBridgeRegistrationContext value={register}>{children}</DialogBridgeRegistrationContext>;
}

export function bridgeDialogContent(bridge: DialogContentBridge | null, content: ReactNode): ReactNode {
  return bridge ? bridge(content) : content;
}

/** Registers `bridge` with the nearest dialog host for as long as the caller is mounted. */
export function useRegisterDialogBridge(bridge: DialogContentBridge): void {
  const register = useContext(DialogBridgeRegistrationContext);
  useLayoutEffect(() => register?.(bridge), [bridge, register]);
}

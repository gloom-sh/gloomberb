type DesktopTitleBarStyle = "default" | "hidden" | "hiddenInset";
type DesktopWindowRenderer = "native" | "cef";
type DesktopWindowStyleMask = {
  Borderless?: boolean;
  Closable?: boolean;
  Miniaturizable?: boolean;
  Titled?: boolean;
  FullSizeContentView?: boolean;
};

export function desktopTitleBarStyle(): DesktopTitleBarStyle {
  if (process.platform === "darwin") return "hiddenInset";
  if (process.platform === "win32") return "hidden";
  return "hidden";
}

export function desktopWindowRenderer(): DesktopWindowRenderer {
  if (process.platform === "win32") {
    const hostArchitecture = process.env.PROCESSOR_ARCHITEW6432 ?? process.env.PROCESSOR_ARCHITECTURE;
    return hostArchitecture?.toLowerCase() === "arm64" ? "native" : "cef";
  }
  return "native";
}

export function desktopWindowStyleMask(): DesktopWindowStyleMask {
  if (process.platform !== "win32") return {};
  return {
    Borderless: true,
    Closable: false,
    Miniaturizable: false,
    Titled: false,
    FullSizeContentView: true,
  };
}

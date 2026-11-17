export function isBrowserAppActive(): boolean {
  return !document.hidden && document.hasFocus();
}

export function subscribeBrowserAppActivity(listener: (active: boolean) => void): () => void {
  const update = () => listener(isBrowserAppActive());
  window.addEventListener("focus", update);
  window.addEventListener("blur", update);
  document.addEventListener("visibilitychange", update);
  update();
  return () => {
    window.removeEventListener("focus", update);
    window.removeEventListener("blur", update);
    document.removeEventListener("visibilitychange", update);
  };
}

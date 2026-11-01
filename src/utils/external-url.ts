/**
 * Scheme validation for links handed to the operating system.
 *
 * Opening a link natively means spawning `open` / `xdg-open` / `rundll32` with
 * a string that usually came from an external feed: RSS items, prediction
 * markets, news, filings, Substack. `file://` and the other local schemes
 * launch local content, so only http(s) goes through.
 *
 * Returns the normalised URL so callers spawn the parsed form rather than the
 * raw input.
 */
export function safeExternalUrl(value: string): string | null {
  if (!value.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    // Intentional ignore: Malformed URLs are rejected by this validator.
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString();
}

/**
 * The command that hands an http(s) link to the system's own opener, with the
 * link as the last argument, or null for any other link. Windows opens it
 * through `url.dll` rather than `cmd /c start`: `&`, `|`, `^` and `%` are part
 * of a link, and a command line would read them as its own.
 */
export function systemOpenCommand(rawUrl: string, platform: NodeJS.Platform): string[] | null {
  const url = safeExternalUrl(rawUrl);
  if (!url) return null;
  if (platform === "darwin") return ["open", url];
  if (platform === "win32") return ["rundll32.exe", "url.dll,FileProtocolHandler", url];
  return ["xdg-open", url];
}

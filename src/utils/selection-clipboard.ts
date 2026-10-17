import { logFailure } from "./log-failure";
import { type NativeRendererHost as CliRenderer } from "../ui";
import { type KeyEventLike as KeyEvent } from "../react/input";

function isDarwinWithBunSpawnSync(): boolean {
  return typeof process !== "undefined"
    && process.platform === "darwin"
    && typeof Bun !== "undefined"
    && typeof Bun.spawnSync === "function";
}

function readTextFromSystemClipboard(): string | null {
  if (!isDarwinWithBunSpawnSync()) {
    return null;
  }

  try {
    const result = Bun.spawnSync(["pbpaste"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    if (!result.success) {
      return null;
    }
    return result.stdout.toString().replace(/\r\n/g, "\n");
  } catch (error) {
    logFailure("utils-selection-clipboard", "Could not read system clipboard")(error);
    return null;
  }
}

function copyTextToSystemClipboard(text: string): boolean {
  if (text.length === 0 || !isDarwinWithBunSpawnSync()) {
    return false;
  }

  try {
    const result = Bun.spawnSync(["pbcopy"], {
      stdin: new Blob([text]),
      stdout: "ignore",
      stderr: "ignore",
    });
    return result.success;
  } catch (error) {
    logFailure("utils-selection-clipboard", "Could not write system clipboard")(error);
    return false;
  }
}

function copySelectionText(
  renderer: Pick<CliRenderer, "copyToClipboardOSC52">,
  text: string,
): boolean {
  if (text.length === 0) {
    return false;
  }

  return renderer.copyToClipboardOSC52?.(text) === true || copyTextToSystemClipboard(text);
}

export function copyActiveSelection(
  renderer: Pick<CliRenderer, "getSelection" | "copyToClipboardOSC52">,
): boolean {
  const text = renderer.getSelection?.()?.getSelectedText() ?? "";
  return copySelectionText(renderer, text);
}

export function isCopyShortcut(
  event: Pick<KeyEvent, "name" | "super" | "meta" | "ctrl" | "shift">,
): boolean {
  const keyName = event.name?.toLowerCase() ?? "";
  return keyName === "c" && (
    event.super === true
    || event.meta === true
    || (event.ctrl === true && event.shift === true)
  );
}

export function isPasteShortcut(
  event: Pick<KeyEvent, "name" | "super" | "meta" | "ctrl" | "shift">,
): boolean {
  const keyName = event.name?.toLowerCase() ?? "";
  return keyName === "v" && (
    event.super === true
    || event.meta === true
    || (event.ctrl === true && event.shift === true)
  );
}

export function pasteSystemClipboard(
  renderer: Pick<CliRenderer, "keyInput">,
): boolean {
  const text = readTextFromSystemClipboard();
  if (!text || !renderer.keyInput?.processPaste) {
    return false;
  }
  renderer.keyInput.processPaste(new TextEncoder().encode(text));
  return true;
}

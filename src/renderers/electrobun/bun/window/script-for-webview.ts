/**
 * `js`, made to run only in the page of the webview it was sent to.
 *
 * Off the app's thread a script reaches its webview by the webview's native
 * pointer, taken when it was sent. A webview opened after that one closed
 * can reuse the pointer, and the script would run there: its RPC answers
 * could settle the other page's requests. The page knows its own webview id
 * (Electrobun's preload sets it), and ids are never reused, so anywhere else
 * the script does nothing. The scripts are Electrobun's message calls; a
 * block around them changes nothing where they run.
 */
export function scriptForWebview(webviewId: number, js: string): string {
  if (!Number.isSafeInteger(webviewId)) throw new Error(`Not a webview id: ${webviewId}`);
  return `if (window.__electrobunWebviewId === ${webviewId}) {\n${js}\n}`;
}

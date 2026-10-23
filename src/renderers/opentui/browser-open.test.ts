import { expect, test } from "bun:test";
import { browserOpenCommands } from "./browser-open";

const url = "https://gloom.sh/checkout/abc";
const ssh = { SSH_CONNECTION: "10.0.0.2 51000 10.0.0.1 22", SSH_TTY: "/dev/pts/0" };

test("a terminal on the person's own machine uses the system opener", () => {
  expect(browserOpenCommands(url, {}, "darwin")).toEqual([["open", url]]);
  expect(browserOpenCommands(url, { DISPLAY: ":0" }, "linux")).toEqual([["xdg-open", url]]);
  expect(browserOpenCommands(url, {}, "win32")).toEqual([["cmd", "/c", "start", "", url]]);
});

test("over SSH nothing is opened on the far machine, unless a display or $BROWSER forwards it", () => {
  // open and xdg-open report success there while the person sees nothing.
  expect(browserOpenCommands(url, ssh, "linux")).toEqual([]);
  expect(browserOpenCommands(url, ssh, "darwin")).toEqual([]);
  expect(browserOpenCommands(url, { SSH_CLIENT: "10.0.0.2 51000 22" }, "win32")).toEqual([]);
  // X forwarding draws the browser on the person's screen.
  expect(browserOpenCommands(url, { ...ssh, DISPLAY: "localhost:10.0" }, "linux")).toEqual([["xdg-open", url]]);
  // VS Code and Codespaces point $BROWSER at a helper that opens it locally.
  const helper = "/home/me/.vscode-server/bin/abc/helpers/browser.sh";
  expect(browserOpenCommands(url, { ...ssh, BROWSER: helper }, "linux")).toEqual([["xdg-open", url]]);
  expect(browserOpenCommands(url, { ...ssh, BROWSER: helper }, "darwin")).toEqual([[helper, url]]);
  expect(browserOpenCommands(url, { ...ssh, BROWSER: "firefox --new-tab %s:lynx" }, "darwin")).toEqual([["firefox", "--new-tab", url]]);
});

test("WSL opens the link with Windows", () => {
  expect(browserOpenCommands(url, { WSL_DISTRO_NAME: "Ubuntu" }, "linux")).toEqual([
    ["wslview", url],
    ["rundll32.exe", "url.dll,FileProtocolHandler", url],
  ]);
});

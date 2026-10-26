/**
 * Opening a link in a browser the person can see, from a terminal. The
 * terminal often runs somewhere else: over SSH, a browser started on that
 * machine shows on its screen or nowhere, and `open` or `xdg-open` still
 * report success. Those cases get no command at all, so the caller knows
 * nothing opened and can show the link instead.
 */

type Env = Readonly<Record<string, string | undefined>>;

function present(value: string | undefined): boolean {
  return !!value?.trim();
}

/**
 * The command `$BROWSER` names, with the link in it. Editors with a remote
 * terminal (VS Code over SSH, Codespaces) point it at a helper that opens the
 * link on the person's own machine. A `:` separated list takes its first entry.
 */
function envBrowserCommand(browser: string, url: string): string[] | null {
  const entry = browser.split(":")[0]?.trim();
  if (!entry) return null;
  const parts = entry.split(/\s+/);
  return parts.some((part) => part.includes("%s"))
    ? parts.map((part) => part.replaceAll("%s", url))
    : [...parts, url];
}

/**
 * The commands to try in order, each with the link as its last argument.
 * Empty when this terminal cannot show a browser to the person using it.
 */
export function browserOpenCommands(url: string, env: Env, platform: NodeJS.Platform): string[][] {
  const remote = present(env.SSH_CONNECTION) || present(env.SSH_CLIENT) || present(env.SSH_TTY);
  const forwarded = present(env.BROWSER) ? envBrowserCommand(env.BROWSER!, url) : null;

  if (platform === "darwin") {
    if (!remote) return [["open", url]];
    return forwarded ? [forwarded] : [];
  }
  if (platform === "win32") {
    if (!remote) return [["cmd", "/c", "start", "", url]];
    return forwarded ? [forwarded] : [];
  }

  // Linux and the other unixes. WSL has no Linux browser, but Windows can
  // open the link: `wslview` when wslu is installed, else Windows' own handler.
  if (present(env.WSL_DISTRO_NAME) || present(env.WSL_INTEROP)) {
    return [
      ...(forwarded ? [forwarded] : []),
      ["wslview", url],
      ["rundll32.exe", "url.dll,FileProtocolHandler", url],
    ];
  }
  const display = present(env.DISPLAY) || present(env.WAYLAND_DISPLAY);
  // xdg-open reads $BROWSER itself, so a forwarding helper still applies.
  if (remote && !display && !forwarded) return [];
  return [["xdg-open", url]];
}

/** How long an opener may run before it counts as having opened the browser. */
const OPENER_SETTLE_MS = 5_000;

/**
 * Runs one opener. Exit 0 opened the link; a missing command or another exit
 * code did not. An opener still running after a few seconds is a browser
 * started in the foreground of the command, which has opened the link.
 */
export async function runBrowserOpener(command: string[]): Promise<boolean> {
  try {
    const proc = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settled = new Promise<"running">((resolve) => {
      timer = setTimeout(() => resolve("running"), OPENER_SETTLE_MS);
      timer.unref?.();
    });
    const result = await Promise.race([proc.exited, settled]);
    clearTimeout(timer);
    if (result === "running") {
      proc.unref();
      return true;
    }
    return result === 0;
  } catch {
    // The command is not installed (xdg-open is missing on minimal Linux).
    return false;
  }
}

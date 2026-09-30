
const TERMINAL_MOUSE_RESET_SEQUENCE = "\x1B[?1016l\x1B[?1006l\x1B[?1005l\x1B[?1015l\x1B[?1003l\x1B[?1002l\x1B[?1000l";

interface TerminalResetStdin {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => void;
}

interface TerminalResetStdout {
  isTTY?: boolean;
  write: (chunk: string) => unknown;
}

export function resetTerminalInputState(
  stdin: TerminalResetStdin = process.stdin,
  stdout: TerminalResetStdout = process.stdout,
): void {
  if (stdout.isTTY) {
    stdout.write(TERMINAL_MOUSE_RESET_SEQUENCE);
  }

  if (stdin.isTTY !== false && typeof stdin.setRawMode === "function") {
    stdin.setRawMode(false);
  }
}

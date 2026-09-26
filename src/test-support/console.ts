import { spyOn } from "bun:test";

export interface CapturedConsole<T> {
  result: T;
  stdout: string;
  stderr: string;
  /** process.exitCode as `fn` left it; the caller's exit code is restored afterwards. */
  exitCode: string | number | undefined;
}

/** Runs `fn` with stdout, console.log and console.error captured and process.exitCode cleared. */
export async function captureConsole<T>(fn: () => Promise<T> | T): Promise<CapturedConsole<T>> {
  const logs: string[] = [];
  const errors: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  const originalExitCode = process.exitCode;

  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    logs.push(String(chunk).replace(/\n$/, ""));
    return true;
  });
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    errors.push(args.map(String).join(" "));
  };
  process.exitCode = undefined;

  try {
    const result = await fn();
    return { result, stdout: logs.join("\n"), stderr: errors.join("\n"), exitCode: process.exitCode };
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.exitCode = originalExitCode ?? 0;
    stdout.mockRestore();
  }
}

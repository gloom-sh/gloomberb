import { describe, expect, test } from "bun:test";
import { safeExternalUrl, systemOpenCommand } from "./external-url";

describe("safeExternalUrl", () => {
  test("accepts the web schemes and returns the normalised URL", () => {
    expect(safeExternalUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(safeExternalUrl("http://example.com")).toBe("http://example.com/");
    expect(safeExternalUrl("  https://example.com/x  ")).toBe("https://example.com/x");
  });

  test("rejects schemes that would let a feed reach the local machine", () => {
    // These reach openUrl straight from RSS, news, and market payloads, and
    // end up as arguments to `open` / `xdg-open` / `cmd /c start`.
    for (const hostile of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "smb://attacker/share",
      "gloomberb://open",
    ]) {
      expect(safeExternalUrl(hostile)).toBeNull();
    }
  });

  test("rejects input that is not a URL at all", () => {
    expect(safeExternalUrl("")).toBeNull();
    expect(safeExternalUrl("   ")).toBeNull();
    expect(safeExternalUrl("not-a-url")).toBeNull();
    expect(safeExternalUrl("//example.com")).toBeNull();
  });
});

describe("systemOpenCommand", () => {
  test("opens a link with the platform's opener, the link as one last argument", () => {
    expect(systemOpenCommand("https://example.com/a?b=1", "darwin")).toEqual(["open", "https://example.com/a?b=1"]);
    expect(systemOpenCommand("https://example.com/a?b=1", "linux")).toEqual(["xdg-open", "https://example.com/a?b=1"]);
    expect(systemOpenCommand("https://example.com/a?b=1", "win32")).toEqual([
      "rundll32.exe",
      "url.dll,FileProtocolHandler",
      "https://example.com/a?b=1",
    ]);
  });

  test("Windows keeps `&`, `|`, `^` and `%` in the link out of a command line", () => {
    const link = "https://x.example/?a&calc|b^c%25d%PATH%";
    const command = systemOpenCommand(link, "win32")!;
    expect(command).toHaveLength(3);
    expect(command[0]).toBe("rundll32.exe");
    expect(command[2]).toBe(safeExternalUrl(link)!);
  });

  test("hands over nothing but http(s) links", () => {
    for (const platform of ["darwin", "linux", "win32"] as const) {
      expect(systemOpenCommand("file:///C:/Windows/System32/calc.exe", platform)).toBeNull();
      expect(systemOpenCommand("calc.exe", platform)).toBeNull();
      expect(systemOpenCommand("--help", platform)).toBeNull();
    }
  });
});

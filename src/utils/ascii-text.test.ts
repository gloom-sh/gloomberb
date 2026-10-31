import { expect, test } from "bun:test";
import { windowsChcpPath } from "./ascii-text";

// Windows runs a bare `chcp.com` from the current folder first, so the code page is read by full path.
test("chcp is run from the Windows system folder, never by bare name", () => {
  expect(windowsChcpPath({ SystemRoot: "C:\\WINDOWS" })).toBe("C:\\WINDOWS\\System32\\chcp.com");
  expect(windowsChcpPath({ SystemRoot: "D:\\Win\\", windir: "C:\\Windows" })).toBe("D:\\Win\\System32\\chcp.com");
  expect(windowsChcpPath({ windir: "E:\\Windows" })).toBe("E:\\Windows\\System32\\chcp.com");
  // A missing or relative system folder falls back to the standard one rather than the current folder.
  for (const env of [{}, { SystemRoot: "." }, { SystemRoot: "Windows" }, { SystemRoot: "\\\\server\\share" }]) {
    expect(windowsChcpPath(env)).toBe("C:\\Windows\\System32\\chcp.com");
  }
});

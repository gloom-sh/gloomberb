import { describe, expect, test } from "bun:test";

import { isHostLinkError, loadProblems } from "./packaged-plugin-load";

const report = (...checks: Array<[id: string, status: string, message: string]>) => JSON.stringify({
  ok: true,
  data: [{ checks: checks.map(([id, status, message]) => ({ id, status, message })) }],
});

describe("loadProblems", () => {
  test("names a failed load check and ignores failures that read the plugin's files alone", () => {
    const stdout = report(
      ["gloom", "fail", "Needs Gloom 9.0.0, this is 0.19.6."],
      ["id", "fail", "\"alerts\" is reserved by a built-in module."],
      ["export", "fail", "Import failed: Export named 'useCallback' not found in module 'react'."],
    );
    expect(loadProblems({ exitCode: 1, stdout, stderr: "" })).toEqual([
      { check: "export", message: "Import failed: Export named 'useCallback' not found in module 'react'." },
    ]);
    expect(loadProblems({ exitCode: 1, stdout: report(["id", "fail", "reserved"]), stderr: "" })).toEqual([]);
  });

  test("reads a report that a log line came before", () => {
    const stdout = `starting\n${report(["host-link", "fail", "Gloom runtime is not linked"])}`;
    expect(loadProblems({ exitCode: 1, stdout, stderr: "" })).toEqual([
      { check: "host-link", message: "Gloom runtime is not linked" },
    ]);
  });

  test("a command that printed no report is a problem with the process", () => {
    const problems = loadProblems({ exitCode: 139, stdout: "", stderr: "segfault at 0x0\n" });
    expect(problems).toHaveLength(1);
    expect(problems[0]!.check).toBe("process");
    expect(problems[0]!.message).toContain("segfault");
    expect(loadProblems({ exitCode: null, stdout: "", stderr: "", timedOut: true })[0]!.check).toBe("process");
  });
});

describe("isHostLinkError", () => {
  test("is the host not serving a module every plugin may import", () => {
    expect(isHostLinkError("Import failed: Export named 'useCallback' not found in module 'react'.")).toBe(true);
    expect(isHostLinkError("Export named 'jsx' not found in module 'react/jsx-runtime'.")).toBe(true);
    expect(isHostLinkError("Import failed: Uses Foo from gloomberb/ui, which Gloom 0.19.6 does not have. Update the plugin.")).toBe(true);
    expect(isHostLinkError("Cannot find package 'gloomberb' from '/plugins/x/index.ts'")).toBe(true);
  });

  test("leaves what a plugin or its dependencies did to a second opinion", () => {
    expect(isHostLinkError("Uses Foo from gloomberb/ui, removed in Gloom 0.18.0. Update the plugin.")).toBe(false);
    expect(isHostLinkError("Export named 'x' not found in module '/plugins/x/node_modules/dep/index.js'.")).toBe(false);
    expect(isHostLinkError("Cannot find package 'react-dom' from '/plugins/x/index.ts'")).toBe(false);
    expect(isHostLinkError("Cannot find package 'youtubei.js' from '/plugins/tv/index.ts'")).toBe(false);
  });
});

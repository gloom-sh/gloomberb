import { afterEach, describe, expect, test } from "bun:test";
import type { CrashReportsPayload } from "../api-client";
import {
  crashReportsEnabled,
  flushCrashReports,
  installCrashReporter,
  reportCrash,
  resetCrashReporterForTests,
  spoolPendingCrashReports,
  stripHomeDir,
  type CrashReporterHost,
  type SpooledCrashReport,
} from "./crash-reports";

function fakeHost(overrides: Partial<CrashReporterHost> = {}) {
  const sent: CrashReportsPayload[] = [];
  const host: CrashReporterHost = {
    surface: "terminal",
    os: "linux 6.1 x64",
    homeDir: "/home/vince",
    isEnabled: () => true,
    getInstallId: () => "0f1e2d3c-4b5a-4968-8776-655443322110",
    send: async (payload) => {
      sent.push(payload);
    },
    ...overrides,
  };
  return { host, sent };
}

function errorAt(message: string, frame: string): Error {
  const error = new Error(message);
  error.stack = `Error: ${message}\n    at ${frame}\n    at run (/home/vince/app.ts:2:2)`;
  return error;
}

afterEach(() => {
  resetCrashReporterForTests();
});

describe("crashReportsEnabled", () => {
  test("on unless the config or the environment says otherwise", () => {
    expect(crashReportsEnabled(null)).toBe(true);
    expect(crashReportsEnabled({ telemetry: {} })).toBe(true);
    expect(crashReportsEnabled({ telemetry: { crashReports: false } })).toBe(false);
    expect(crashReportsEnabled({}, { GLOOMBERB_NO_TELEMETRY: "1" })).toBe(false);
    expect(crashReportsEnabled({}, { DO_NOT_TRACK: "1" })).toBe(false);
    expect(crashReportsEnabled({}, { DO_NOT_TRACK: "0", GLOOMBERB_NO_TELEMETRY: "" })).toBe(true);
  });
});

describe("stripHomeDir", () => {
  test("replaces the home directory in every form a stack can carry it", () => {
    expect(stripHomeDir("at run (/home/vince/.gloomberb/plugins/x/index.ts:1:1)", "/home/vince"))
      .toBe("at run (~/.gloomberb/plugins/x/index.ts:1:1)");
    expect(stripHomeDir("file:///home/vince/app.ts", "/home/vince")).toBe("file://~/app.ts");
    expect(stripHomeDir("C:\\Users\\John Doe\\x.js and file:///C:/Users/John%20Doe/x.js", "C:\\Users\\John Doe"))
      .toBe("~\\x.js and file:///~/x.js");
    expect(stripHomeDir("/home/vince/x", null)).toBe("/home/vince/x");
  });
});

describe("reportCrash", () => {
  test("strips the home directory, clips, and sends the surface and version", async () => {
    const { host, sent } = fakeHost();
    installCrashReporter(host);
    reportCrash(errorAt(`bad ${"x".repeat(3000)} in /home/vince/secret.json`, "boom (/home/vince/a.ts:1:1)"), { kind: "uncaught" });
    await flushCrashReports({ timeoutMs: 500 });

    expect(sent).toHaveLength(1);
    const [payload] = sent;
    expect(payload).toMatchObject({
      installId: "0f1e2d3c-4b5a-4968-8776-655443322110",
      surface: "terminal",
      os: "linux 6.1 x64",
    });
    expect(payload!.appVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(payload!.errors).toHaveLength(1);
    const [error] = payload!.errors;
    expect(error!.kind).toBe("uncaught");
    expect(error!.type).toBe("Error");
    expect(error!.message).toHaveLength(2000);
    expect(error!.message).not.toContain("/home/vince");
    expect(error!.stack).toContain("boom (~/a.ts:1:1)");
    expect(error!.stack).not.toContain("/home/vince");
  });

  test("the same error is sent once per session, a different frame is another error", async () => {
    const { host, sent } = fakeHost();
    installCrashReporter(host);
    reportCrash(errorAt("boom", "a (/x.ts:1:1)"), { kind: "uncaught" });
    reportCrash(errorAt("boom", "a (/x.ts:1:1)"), { kind: "unhandled-rejection" });
    reportCrash(errorAt("boom", "b (/y.ts:1:1)"), { kind: "uncaught" });
    await flushCrashReports({ timeoutMs: 500 });

    expect(sent.flatMap((payload) => payload.errors.map((error) => error.stack?.split("\n")[1]?.trim()))).toEqual([
      "at a (/x.ts:1:1)",
      "at b (/y.ts:1:1)",
    ]);
  });

  test("at most 20 errors per session, 10 per request", async () => {
    const { host, sent } = fakeHost();
    installCrashReporter(host);
    for (let index = 0; index < 30; index += 1) {
      reportCrash(new Error(`error ${index}`), { kind: "uncaught" });
    }
    await flushCrashReports({ timeoutMs: 500 });

    expect(sent.map((payload) => payload.errors.length)).toEqual([10, 10]);
    reportCrash(new Error("one more"), { kind: "uncaught" });
    await flushCrashReports({ timeoutMs: 500 });
    expect(sent).toHaveLength(2);
  });

  test("errors before the host is installed are sent once it is", async () => {
    reportCrash(new Error("early"), { kind: "plugin", plugin: "broken-plugin" });
    const { host, sent } = fakeHost();
    installCrashReporter(host);
    await flushCrashReports({ timeoutMs: 500 });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.errors[0]).toMatchObject({ kind: "plugin", plugin: "broken-plugin", message: "early" });
  });

  test("nothing is queued or sent when the switch is off", async () => {
    const { host, sent } = fakeHost({ isEnabled: () => false });
    reportCrash(new Error("before"), { kind: "uncaught" });
    installCrashReporter(host);
    reportCrash(new Error("after"), { kind: "uncaught" });
    await flushCrashReports({ timeoutMs: 500 });

    expect(sent).toEqual([]);
  });

  test("a failed send neither throws nor blocks later reports", async () => {
    let attempts = 0;
    const { host, sent } = fakeHost({
      send: async (payload) => {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        sent.push(payload);
      },
    });
    installCrashReporter(host);
    reportCrash(new Error("first"), { kind: "uncaught" });
    await flushCrashReports({ timeoutMs: 500 });
    reportCrash(new Error("second"), { kind: "uncaught" });
    await flushCrashReports({ timeoutMs: 500 });

    expect(sent.map((payload) => payload.errors[0]!.message)).toEqual(["second"]);
  });

  test("a spooled batch is cleared once sent, and a leftover one goes out at the next launch", async () => {
    let spooled: SpooledCrashReport[] = [];
    const { host, sent } = fakeHost({
      spool: (report) => { spooled = [report]; },
      clearSpool: () => { spooled = []; },
      takeSpooled: async () => spooled.splice(0),
    });
    installCrashReporter(host);
    reportCrash(errorAt("fatal in /home/vince/x", "die (/home/vince/x.ts:1:1)"), { kind: "uncaught" });
    spoolPendingCrashReports();
    expect(spooled).toHaveLength(1);
    expect(spooled[0]).not.toHaveProperty("installId");
    await flushCrashReports({ timeoutMs: 500 });
    expect(sent).toHaveLength(1);
    expect(spooled).toEqual([]);

    // Next session: the batch survived on disk, so it is sent with the install id and scrubbed.
    resetCrashReporterForTests();
    spooled = [{ surface: "desktop", appVersion: "0.1.0", errors: [{ kind: "uncaught", type: "Error", message: "left in /home/vince" }] }];
    const next = fakeHost({ takeSpooled: async () => spooled.splice(0) });
    installCrashReporter(next.host);
    await flushCrashReports({ timeoutMs: 500 });
    await Bun.sleep(0);
    expect(next.sent).toHaveLength(1);
    expect(next.sent[0]).toMatchObject({ installId: "0f1e2d3c-4b5a-4968-8776-655443322110", appVersion: "0.1.0", surface: "desktop" });
    expect(next.sent[0]!.errors[0]!.message).toBe("left in ~");
  });
});

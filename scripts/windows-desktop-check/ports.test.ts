import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attributeListeners, decodeListeners, portResults } from "./ports";
import type { CheckRun } from "./results";

const launcher = { pid: 40, created: 200n };
const runtime = { pid: 48, created: 300n, parentPid: 40, name: "bun.exe" };
const worker = { pid: 56, created: 400n, parentPid: 48, name: "worker.exe" };
const members = [launcher, runtime, worker];
const membership = { assigned: 4, pids: members.map(({ pid }) => pid) };
const local = { pid: runtime.pid, created: 500n, address: "127.0.0.1", port: 8000 };

test("ignores a stale parent pointing at a recycled PID and a stale bind owned by the prior PID holder", () => {
  const staleChild = { pid: 60, parentPid: launcher.pid, created: 100n };
  const listeners = [local,
    { ...staleChild, address: "0.0.0.0", port: 8001 },
    { pid: launcher.pid, created: 150n, address: "0.0.0.0", port: 8002 },
  ];
  const sockets = attributeListeners(membership, members, listeners, membership);
  const results = portResults(sockets, [], 0);
  expect(results.map(({ status }) => status)).toEqual(["pass", "pass"]);
  expect(results[0]?.data).toEqual({ sockets: [{ address: "127.0.0.1", port: 8000 }] });
});

test("keeps a non-Bun descendant's non-loopback listener and enforces the DevTools range", () => {
  const afterLauncherExit = { ...membership, pids: [runtime.pid, worker.pid] };
  const helper = { pid: worker.pid, created: 501n, address: "::", port: 8001 };
  const evaluate = (listener: typeof helper) => portResults(
    attributeListeners(afterLauncherExit, [runtime, worker], [local, listener], afterLauncherExit), [], 0);
  const open = evaluate(helper);
  expect(open.map(({ status }) => status)).toEqual(["fail", "pass"]);
  expect(open[0]?.detail).toContain("[::]:8001");
  const devtools = evaluate({ ...helper, address: "::1", port: 9232 });
  expect(devtools.map(({ status }) => status)).toEqual(["pass", "fail"]);
  expect(devtools[1]?.detail).toBe("DevTools on [::1]:9232");
});

test("an unowned, incomplete, or churned sample cannot pass either check", () => {
  expect(() => attributeListeners(membership, members, [local], { ...membership, assigned: 5 })).toThrow("membership changed");
  expect(() => attributeListeners(membership, members.slice(1), [local], membership)).toThrow("Missing creation identity");
  expect(() => attributeListeners(membership, members, [{ ...local, pid: 0 }], membership)).toThrow("no owning process ID");
  expect(() => attributeListeners(membership, members, [{ ...local, created: 0n }], membership)).toThrow("no bind time");
  const unrelated = attributeListeners(membership, members, [{ ...local, pid: 64 }], membership);
  expect(portResults(unrelated, [], 0).map(({ status }) => status)).toEqual(["fail", "fail"]);
  const report = portResults("Launch membership changed during the listener sample", [], 0);
  expect(report.map(({ status, detail }) => [status, detail])).toEqual([
    ["fail", "Launch membership changed during the listener sample"],
    ["fail", "Launch membership changed during the listener sample"],
  ]);
});

test("decodes aligned IPv4 and IPv6 rows and rejects a truncated table", () => {
  const ipv4 = Buffer.alloc(168);
  ipv4.set(Buffer.from("0100000000000000020000007f0000011f400000000000000000000030000000f401000000000000", "hex"));
  const ipv6 = Buffer.alloc(200);
  ipv6.set(Buffer.from("010000000000000000000000000000000000000000000001000000001f410000", "hex"));
  ipv6.set(Buffer.from("0200000038000000f501000000000000", "hex"), 56);
  expect(decodeListeners(ipv4, 4)).toEqual([local]);
  expect(decodeListeners(ipv6, 6)).toEqual([{ pid: 56, created: 501n, address: "::1", port: 8001 }]);
  expect(() => decodeListeners(ipv6.subarray(0, -1), 6)).toThrow("Truncated IPv6 listener table");
});

test("the report fails an indeterminate ports sample alongside a passing UI check, even with known failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "desktop-ports-"));
  try {
    const ports = join(dir, "ports");
    const ui = join(dir, "ui");
    await Promise.all([mkdir(ports), mkdir(ui)]);
    const run: CheckRun = { label: "head-x64", version: "1.0.0", started: "2026-01-01T00:00:00Z", scale: 100, screen: "1920x1080", results: [], fatal: null };
    const detail = "Launch membership changed during the listener sample";
    const known = join(dir, "known.json");
    await Promise.all([
      Bun.write(join(ports, "results.json"), JSON.stringify({ ...run, label: `${run.label} as shipped`, results: portResults(detail, [], 0) })),
      Bun.write(join(ui, "results.json"), JSON.stringify({ ...run, results: [{ id: "ui", title: "UI check", status: "pass", detail: "OK", shots: [], ms: 0 }] })),
      Bun.write(known, JSON.stringify({ checks: { "listens-locally": "example", "no-devtools-port": "example" } })),
    ]);
    for (const flags of [[], ["--known", known]]) {
      const report = Bun.spawnSync([process.execPath, join(import.meta.dir, "report.ts"), dir, ...flags], {
        env: { ...process.env, GITHUB_STEP_SUMMARY: "" }, timeout: 5_000,
      });
      expect(report.exitCode).toBe(1);
      expect(report.stdout.toString()).toContain(detail);
      expect(report.stdout.toString()).not.toContain("(known)");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

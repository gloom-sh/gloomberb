import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { checkShippedPrograms, clearDanglingCertificateTable } from "./windows-signing";

let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gloom-windows-signing-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const PE = 0x80;
const CERTIFICATE_ENTRY = PE + 24 + 112 + 4 * 8;

/** The headers of a 64-bit Windows program, with its certificate table entry. */
function program(certificate = { offset: 0, size: 0 }, length = 0x400): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  bytes.set([0x4d, 0x5a]);
  view.setUint32(0x3c, PE, true);
  view.setUint32(PE, 0x00004550, true);
  view.setUint16(PE + 20, 240, true);
  view.setUint16(PE + 24, 0x20b, true);
  view.setUint32(PE + 24 + 108, 16, true);
  view.setUint32(CERTIFICATE_ENTRY, certificate.offset, true);
  view.setUint32(CERTIFICATE_ENTRY + 4, certificate.size, true);
  return bytes;
}

// rcedit leaves Electrobun's bun.exe (v0.20.21) naming a signature that starts
// 226 KiB past its end, and signtool cannot sign that file until the entry is gone.
test("clears a certificate table entry that names bytes past the end of the file, and leaves any other alone", () => {
  const cases = {
    dangling: program({ offset: 0x10000, size: 0x2858 }),
    signed: program({ offset: 0x300, size: 0x100 }),
    unsigned: program(),
    script: new TextEncoder().encode("@echo off\r\n"),
  };
  for (const [name, bytes] of Object.entries(cases)) writeFileSync(join(dir, name), bytes);

  expect(Object.keys(cases).map((name) => [name, clearDanglingCertificateTable(join(dir, name))])).toEqual([
    ["dangling", true],
    ["signed", false],
    ["unsigned", false],
    ["script", false],
  ]);
  const cleared = new Uint8Array(readFileSync(join(dir, "dangling")));
  expect(cleared).toEqual(program());
  for (const name of ["signed", "unsigned", "script"] as const) {
    expect(new Uint8Array(readFileSync(join(dir, name)))).toEqual(cases[name]);
  }
});

test("checks every program a release ships, found by its headers, in the update archives and gzipped binaries too", async () => {
  writeFileSync(join(dir, "GloomSetup.exe"), program());
  writeFileSync(join(dir, "gloomberb-windows-x64.exe.gz"), Bun.gzipSync(program()));
  writeFileSync(join(dir, "stable-win-x64-update.json"), "{}");
  const archive = new Bun.Archive({
    "Gloom/bin/launcher.exe": program(),
    "Gloom/bin/gloom.cmd": "@echo off\r\n",
    // A DOS stub with no Windows program behind it.
    "Gloom/bin/stub.dll": new Uint8Array([0x4d, 0x5a, 0, 0]),
    // Electrobun's uninstaller, which the app copies out and runs: no extension.
    "Gloom/Resources/uninstall": program(),
    "Gloom/Resources/version.json": "{}",
  });
  writeFileSync(join(dir, "stable-win-x64-Gloom.tar.zst"), Bun.zstdCompressSync(await archive.bytes()));
  mkdirSync(join(dir, "windows-gui-verification"));

  const unsignedUninstaller = (path: string) => ({ ok: !path.endsWith("uninstall"), output: "" });
  expect((await checkShippedPrograms(dir, unsignedUninstaller)).map(({ name, ok }) => [name, ok])).toEqual([
    ["GloomSetup.exe", true],
    ["gloomberb-windows-x64.exe.gz", true],
    ["stable-win-x64-Gloom.tar.zst: Gloom/Resources/uninstall", false],
    ["stable-win-x64-Gloom.tar.zst: Gloom/bin/launcher.exe", true],
  ]);
});

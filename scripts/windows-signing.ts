/**
 * Authenticode signing for the Windows release files. Windows 11's Smart App
 * Control blocks an unsigned program, with no way past it for the user, so a
 * release signs every program and library it ships, timestamped, before
 * anything packs, hashes or gzips it:
 *
 *   - scripts/build.ts signs the terminal binary before its smoke tests run it
 *     and before it is gzipped;
 *   - scripts/install-electrobun-tui-shim.ts, Electrobun's postBuild script,
 *     signs the desktop app's programs last, after it edits them and before
 *     Electrobun hashes and packs the bundle into the update archive the
 *     installer and the legacy-name archive are made from;
 *   - scripts/build-windows-installer.ps1 gives Inno Setup this script as its
 *     Sign Tool (`sign <file>`), for the setup and the copy of Inno's engine
 *     the setup runs from the temp folder.
 *
 * `check <folder>` then fails a release job on any program in its files
 * (an installer, a gzipped binary, any program inside an update archive)
 * without a valid, timestamped signature.
 *
 * None of it runs unless the job set signing up (.github/actions/windows-signing),
 * which leaves GLOOM_WINDOWS_SIGNING naming its settings. Every other build,
 * and a release's until the signing environment names a certificate profile,
 * is unsigned, as before.
 */
import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, statSync, writeFileSync, writeSync } from "fs";
import { tmpdir } from "os";
import { join, relative, resolve } from "path";

/** What .github/actions/windows-signing writes, at the path in GLOOM_WINDOWS_SIGNING. */
interface WindowsSigning {
  /** signtool.exe, from the pinned Windows SDK build tools. */
  signtool: string;
  /** The signing service's signtool plugin. */
  dlib: string;
  /** The plugin's settings: the endpoint, the account and the certificate profile. */
  metadata: string;
  /** The app registration the job's OIDC identity is federated with. */
  clientId: string;
  tenantId: string;
}

const TIMESTAMP_URL = "http://timestamp.acs.microsoft.com";
/** Each try asks GitHub for a new OIDC token. */
const SIGN_ATTEMPTS = 3;

/** The signing the job set up, or null when this build signs nothing. */
export function windowsSigning(): WindowsSigning | null {
  const path = process.env.GLOOM_WINDOWS_SIGNING;
  if (!path) return null;
  const settings = JSON.parse(readFileSync(path, "utf8")) as Partial<WindowsSigning>;
  for (const key of ["signtool", "dlib", "metadata", "clientId", "tenantId"] as const) {
    if (typeof settings[key] !== "string" || settings[key] === "") {
      throw new Error(`GLOOM_WINDOWS_SIGNING (${path}) sets no ${key}`);
    }
  }
  if (process.platform !== "win32") throw new Error("Windows files are signed on Windows, where signtool runs");
  return settings as WindowsSigning;
}

// Read far enough for any real program's headers.
const HEADER_BYTES = 0x10000;
const CERTIFICATE_TABLE = 4;

function readHeader(path: string): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const bytes = new Uint8Array(HEADER_BYTES);
    return bytes.subarray(0, readSync(fd, bytes, 0, HEADER_BYTES, 0));
  } finally {
    closeSync(fd);
  }
}

/**
 * Where in the file a program's certificate table entry is (offset, then
 * size: the file position of its signature and its length), or null for a
 * file that is not a Windows program or library. Windows goes by these
 * headers, not by the name: Electrobun's uninstaller has no extension.
 */
function certificateEntryOffset(bytes: Uint8Array): number | null {
  if (bytes.length < 0x40 || bytes[0] !== 0x4d || bytes[1] !== 0x5a) return null; // MZ
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const pe = view.getUint32(0x3c, true);
  if (pe + 24 > bytes.length || view.getUint32(pe, true) !== 0x00004550) return null; // PE\0\0
  const optionalSize = view.getUint16(pe + 20, true);
  const optional = pe + 24;
  if (optional + 2 > bytes.length) return null;
  const magic = view.getUint16(optional, true);
  // The data directories follow the optional header's fixed fields, which PE32+ widens.
  const directories = magic === 0x20b ? optional + 112 : magic === 0x10b ? optional + 96 : null;
  if (directories === null || directories > bytes.length) return null;
  const entry = directories + CERTIFICATE_TABLE * 8;
  const directoryCount = view.getUint32(directories - 4, true);
  if (directoryCount <= CERTIFICATE_TABLE || entry + 8 > optional + optionalSize || entry + 8 > bytes.length) return null;
  return entry;
}

/** A Windows program or library, whatever its name. */
function isPortableExecutable(path: string): boolean {
  return certificateEntryOffset(readHeader(path)) !== null;
}

/** Every Windows program and library under `dir`. */
function portableExecutablesIn(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .filter(isPortableExecutable)
    .sort();
}

/**
 * Clears a certificate table entry that points past the end of the file, and
 * says whether it did. Editing a signed program's resources (rcedit, on
 * Electrobun's bun.exe) drops its signature but leaves the entry, and signtool
 * cannot sign a file whose entry names bytes it does not have.
 */
export function clearDanglingCertificateTable(path: string): boolean {
  const entry = certificateEntryOffset(readHeader(path));
  if (entry === null) return false;
  const fd = openSync(path, "r+");
  try {
    const field = new Uint8Array(8);
    readSync(fd, field, 0, 8, entry);
    const view = new DataView(field.buffer);
    const offset = view.getUint32(0, true);
    const size = view.getUint32(4, true);
    if (size === 0 || (offset !== 0 && offset + size <= fstatSync(fd).size)) return false;
    writeSync(fd, new Uint8Array(8), 0, 8, entry);
    return true;
  } finally {
    closeSync(fd);
  }
}

interface Verification {
  ok: boolean;
  output: string;
}

/** A valid Authenticode signature, under Windows' default policy, with a timestamp (`/tw` fails one without). */
function verifySignature(signing: WindowsSigning, path: string): Verification {
  const result = Bun.spawnSync([signing.signtool, "verify", "/pa", "/tw", "/v", path], { stdout: "pipe", stderr: "pipe" });
  return { ok: result.exitCode === 0, output: `${result.stdout.toString()}${result.stderr.toString()}`.trim() };
}

/**
 * A GitHub OIDC token for the signing service to exchange, in a file only this
 * process reads. A new one for each signtool run: they expire within minutes,
 * and a release job signs long after it starts.
 */
async function federatedTokenFile(): Promise<string> {
  const url = process.env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const token = process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!url || !token) throw new Error("No GitHub OIDC token to sign with: the job needs `id-token: write`");
  const response = await fetch(`${url}&audience=${encodeURIComponent("api://AzureADTokenExchange")}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`GitHub gave no OIDC token (HTTP ${response.status})`);
  const { value } = (await response.json()) as { value?: unknown };
  if (typeof value !== "string" || value === "") throw new Error("GitHub's OIDC token response has no token");
  const dir = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "windows-signing-"));
  const path = join(dir, "token");
  writeFileSync(path, value, { mode: 0o600 });
  return path;
}

/**
 * Signs `paths` with the release certificate, timestamped, then checks each
 * signature (`signtool verify /pa /v`). Throws when any is not signed.
 */
export async function signWindowsFiles(signing: WindowsSigning, paths: readonly string[]): Promise<void> {
  if (paths.length === 0) return;
  for (const path of paths) {
    if (clearDanglingCertificateTable(path)) console.log(`Cleared the stale certificate table of ${path}`);
  }
  for (let attempt = 1; ; attempt += 1) {
    const tokenFile = await federatedTokenFile();
    let exitCode: number | null;
    try {
      exitCode = Bun.spawnSync([
        signing.signtool, "sign", "/v", "/fd", "SHA256", "/tr", TIMESTAMP_URL, "/td", "SHA256",
        "/dlib", signing.dlib, "/dmdf", signing.metadata, ...paths,
      ], {
        stdout: "inherit",
        stderr: "inherit",
        env: {
          ...process.env,
          AZURE_CLIENT_ID: signing.clientId,
          AZURE_TENANT_ID: signing.tenantId,
          AZURE_FEDERATED_TOKEN_FILE: tokenFile,
        },
      }).exitCode;
    } finally {
      rmSync(join(tokenFile, ".."), { recursive: true, force: true });
    }
    if (exitCode === 0) break;
    if (attempt === SIGN_ATTEMPTS) throw new Error(`signtool could not sign ${paths.join(", ")} (exit ${exitCode}, ${attempt} tries)`);
    console.log(`signtool exited with ${exitCode}; trying again (${attempt + 1} of ${SIGN_ATTEMPTS})`);
    await Bun.sleep(attempt * 15_000);
  }
  for (const path of paths) {
    const { ok, output } = verifySignature(signing, path);
    console.log(output);
    if (!ok) throw new Error(`${path} is not validly signed and timestamped after signing`);
  }
}

/**
 * Signs every program and library under `dir` without a valid, timestamped
 * signature: ours, and others' that ship unsigned. One someone else signed
 * keeps that signature. Resolves to the ones it signed.
 */
export async function signUnsignedPrograms(signing: WindowsSigning, dir: string): Promise<string[]> {
  const programs = portableExecutablesIn(dir);
  const unsigned = programs.filter((path) => !verifySignature(signing, path).ok);
  const kept = programs.filter((path) => !unsigned.includes(path));
  console.log(`Signing ${unsigned.length} of the ${programs.length} programs and libraries in ${dir}`);
  for (const path of kept) console.log(`  keeps its own signature: ${relative(dir, path)}`);
  await signWindowsFiles(signing, unsigned);
  return unsigned;
}

/**
 * Every program in the release files in `dir`, where Windows would run it from:
 * a program itself, the binary in a .gz, each program inside a .tar.zst. The
 * packed ones are unpacked under `work`. Each comes with the name it is
 * reported by.
 */
async function shippedPrograms(dir: string, work: string): Promise<Array<{ name: string; path: string }>> {
  const programs: Array<{ name: string; path: string }> = [];
  for (const file of readdirSync(dir).sort()) {
    const path = join(dir, file);
    if (!statSync(path).isFile()) continue;
    if (file.endsWith(".tar.zst")) {
      const unpacked = join(work, file);
      mkdirSync(unpacked, { recursive: true });
      await new Bun.Archive(Bun.zstdDecompressSync(readFileSync(path))).extract(unpacked);
      for (const program of portableExecutablesIn(unpacked)) {
        programs.push({ name: `${file}: ${relative(unpacked, program).replaceAll("\\", "/")}`, path: program });
      }
    } else if (file.endsWith(".gz")) {
      const unpacked = join(work, file.slice(0, -".gz".length));
      writeFileSync(unpacked, Bun.gunzipSync(readFileSync(path)));
      if (isPortableExecutable(unpacked)) programs.push({ name: file, path: unpacked });
    } else if (isPortableExecutable(path)) {
      programs.push({ name: file, path });
    }
  }
  return programs;
}

/** `verify`'s answer for every program in the release files in `dir`, by the name it is reported under. */
export async function checkShippedPrograms(dir: string, verify: (path: string) => Verification): Promise<Array<{ name: string } & Verification>> {
  const work = mkdtempSync(join(process.env.RUNNER_TEMP || tmpdir(), "windows-signatures-"));
  try {
    return (await shippedPrograms(dir, work)).map(({ name, path }) => ({ name, ...verify(path) }));
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [command, ...args] = process.argv.slice(2);
  const signing = windowsSigning();
  if (!signing || (command !== "sign" && command !== "check") || args.length === 0) {
    console.error(signing ? "Usage: bun scripts/windows-signing.ts sign <file>... | check <folder>" : "Windows signing is not set up in this job (GLOOM_WINDOWS_SIGNING).");
    process.exit(2);
  }
  if (command === "sign") {
    // Inno Setup's Sign Tool: the setup, and the copy of its engine the setup runs from the temp folder.
    await signWindowsFiles(signing, args.map((path) => resolve(path)));
  } else {
    const dir = resolve(args[0]!);
    if (!existsSync(dir)) {
      console.error(`No such folder: ${dir}`);
      process.exit(2);
    }
    const checked = await checkShippedPrograms(dir, (path) => verifySignature(signing, path));
    for (const { name, ok, output } of checked) {
      console.log(`::group::${ok ? "Signed" : "NOT SIGNED"}: ${name}`);
      console.log(output);
      console.log("::endgroup::");
    }
    const failed = checked.filter(({ ok }) => !ok).map(({ name }) => name);
    if (checked.length === 0) {
      console.error(`::error title=Windows signing::No Windows programs in ${dir} to check`);
      process.exit(1);
    }
    if (failed.length > 0) {
      console.error(`::error title=Windows signing::${failed.length} of ${checked.length} Windows programs are not validly signed and timestamped: ${failed.join(", ")}`);
      process.exit(1);
    }
    console.log(`All ${checked.length} Windows programs in ${dir} are signed and timestamped.`);
  }
}

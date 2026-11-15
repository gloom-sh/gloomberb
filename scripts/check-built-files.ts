/**
 * Checks that a folder holds only files a build job of this workflow run
 * attested, each under the name it was attested with, before the jobs that
 * publish upload any of it:
 *
 *   GH_TOKEN=... bun scripts/check-built-files.ts <folder>
 *
 * The plugin check in load-registry-plugins.yml runs code from other
 * repositories on runners that can reach the run's artifacts, and a file
 * replaced there stays replaced for every later attempt of the run. So what
 * the artifacts hold proves nothing, and neither would a sum of them taken in
 * a later attempt. The jobs of build-release-assets.yml attest each file they
 * upload, signed with an OIDC identity that names that workflow and the run,
 * which no job outside it can take on. This asks GitHub for those
 * attestations (`gh attestation verify`, bound to this repository and that
 * workflow) and passes a file only when one made in this run, in any attempt,
 * names it with its digest. A held release still publishes after
 * `gh run rerun --failed`; a file from another run or under another name, an
 * unattested one, a link or a folder fails it.
 */
import { createHash } from "crypto";
import { createReadStream, readdirSync } from "fs";
import { join } from "path";

const BUILD_WORKFLOW = ".github/workflows/build-release-assets.yml";

/** One attestation `gh attestation verify --format json` passed, as far as this check reads it. */
export interface VerifiedAttestation {
  verificationResult?: {
    signature?: { certificate?: { runInvocationURI?: unknown } };
    statement?: { subject?: unknown };
  };
}

interface Subject {
  name?: unknown;
  digest?: { sha256?: unknown };
}

/**
 * Whether one of the attestations was made in the run at `runUrl`
 * (`https://github.com/<owner>/<repo>/actions/runs/<id>`), in any attempt,
 * and names `name` with `sha256`. The run comes from the signing certificate,
 * which GitHub's OIDC token fills in, not from anything the job wrote.
 */
export function attestedInRun(verified: readonly VerifiedAttestation[], runUrl: string, name: string, sha256: string): boolean {
  const attempts = `${runUrl}/attempts/`;
  return verified.some(({ verificationResult: result }) => {
    const run = result?.signature?.certificate?.runInvocationURI;
    if (typeof run !== "string" || !run.startsWith(attempts) || !/^\d+$/.test(run.slice(attempts.length))) return false;
    const subjects = result?.statement?.subject;
    return Array.isArray(subjects) && subjects.some((subject: Subject | null) => subject?.name === name && subject.digest?.sha256 === sha256);
  });
}

/** The plain files directly in the folder, and every other entry: a folder or a link, which no build uploads. */
function readBuiltFolder(dir: string): { files: string[]; others: string[] } {
  const files: string[] = [];
  const others: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    (entry.isFile() ? files : others).push(entry.name);
  }
  return { files: files.sort(), others: others.sort() };
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

if (import.meta.main) {
  const dir = process.argv[2];
  const { GITHUB_REPOSITORY: repo, GITHUB_RUN_ID: runId } = process.env;
  if (!dir || !repo || !runId) {
    console.error("Usage: GITHUB_REPOSITORY=<owner>/<repo> GITHUB_RUN_ID=<run> bun scripts/check-built-files.ts <folder>");
    process.exit(2);
  }
  const runUrl = `${process.env.GITHUB_SERVER_URL || "https://github.com"}/${repo}/actions/runs/${runId}`;

  const { files, others } = readBuiltFolder(dir);
  const failed = others.map((name) => `${name}: not a file`);
  if (files.length === 0) failed.push(`${dir}: holds no files`);
  for (const name of files) {
    const path = join(dir, name);
    const sha256 = await sha256File(path);
    const gh = Bun.spawnSync(
      [
        "gh", "attestation", "verify", path,
        "--repo", repo,
        "--signer-workflow", `${repo}/${BUILD_WORKFLOW}`,
        "--deny-self-hosted-runners",
        "--format", "json",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    if (gh.exitCode !== 0) {
      failed.push(`${name}: ${gh.stderr.toString().trim() || `gh attestation verify exited ${gh.exitCode}`}`);
      continue;
    }
    let verified: unknown;
    try {
      verified = JSON.parse(gh.stdout.toString());
    } catch (error) {
      failed.push(`${name}: gh attestation verify printed no JSON: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (!Array.isArray(verified) || !attestedInRun(verified, runUrl, name, sha256)) {
      failed.push(`${name}: no attestation from this run names it with sha256 ${sha256}`);
      continue;
    }
    console.log(`${sha256}  ${name}`);
  }

  if (failed.length > 0) {
    console.error("::error title=Not the files built::Nothing was uploaded: these are not files a build job of this run attested.");
    for (const line of failed) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(`${files.length} files are the ones this run built.`);
}

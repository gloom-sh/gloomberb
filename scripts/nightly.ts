/**
 * The decisions behind .github/workflows/nightly.yml, kept here so they can be
 * tested:
 *
 *   bun run scripts/nightly.ts plan    whether this run builds, and as what version (GITHUB_OUTPUT)
 *   bun run scripts/nightly.ts notes   the prerelease notes: what changed since the last nightly build
 *   bun run scripts/nightly.ts prune   nightly prereleases older than NIGHTLY_PRUNE_DAYS; a dry run without it
 *   bun run scripts/nightly.ts claim-tag   fails unless no tag and no release (draft included) is named NIGHTLY_TAG yet
 *   bun run scripts/nightly.ts drop-draft  after a failed publish, deletes the drafts named NIGHTLY_TAG, nothing else
 *
 * A nightly build is `<base>-nightly.<UTC date>.<run number>.g<sha7>`. The base
 * is the patch after the latest stable release, so every nightly build sorts
 * above the stable release users already have and below the next one; the
 * date and run number order two builds of one day, whatever their shas look
 * like. Nothing here commits, tags or touches a stable release: GitHub reads
 * go through `gh`, `prune` deletes nothing but nightly prereleases, and
 * `drop-draft` nothing but the unpublished draft its own run created. No
 * command deletes a git tag other than `prune`, with the nightly release it
 * belongs to.
 */
import { appendFileSync, readFileSync } from "fs";
import { compareSemver, parseSemver } from "../src/utils/semver";

const NIGHTLY_TAG = /^v\d+\.\d+\.\d+-nightly\.\d{8}\.\d+\.g[0-9a-f]{7}$/;

interface ReleaseListing {
  id: number;
  tag_name: string;
  prerelease: boolean;
  draft: boolean;
  /**
   * When the release went out; null while it is a draft. Not `created_at`,
   * which GitHub sets from the tagged commit's date.
   */
  published_at: string | null;
}

/**
 * The version nightly builds count up from: the next patch after the latest
 * stable release, or package.json when it is already ahead. Without a latest
 * stable release there is no safe base (package.json alone would give the
 * stable version itself, which sorts above its own nightly builds), so it throws.
 */
export function nightlyBaseVersion(packageVersion: string, latestStableTag: string): string {
  const pkg = parseSemver(packageVersion);
  if (!pkg || pkg.prerelease) throw new Error(`package.json version ${packageVersion} is not a release version`);
  const latest = parseSemver(latestStableTag);
  if (!latest || latest.prerelease) throw new Error(`The latest stable release ${JSON.stringify(latestStableTag)} is not a release version`);
  if ((compareSemver(packageVersion, latestStableTag) ?? 0) <= 0) {
    return `${latest.major}.${latest.minor}.${latest.patch + 1}`;
  }
  return `${pkg.major}.${pkg.minor}.${pkg.patch}`;
}

export function nightlyVersion(base: string, builtAt: Date, runNumber: number, sha: string): string {
  if (!Number.isInteger(runNumber) || runNumber < 1) throw new Error(`Run number ${runNumber} is not a positive integer`);
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`${sha} is not a commit sha`);
  const date = builtAt.toISOString().slice(0, 10).replaceAll("-", "");
  return `${base}-nightly.${date}.${runNumber}.g${sha.slice(0, 7)}`;
}

export function isNightlyTag(tag: string): boolean {
  return NIGHTLY_TAG.test(tag);
}

export interface NightlyPlanInput {
  event: string;
  /** The run asked to publish; off builds everything and publishes nothing. */
  publish: boolean;
  /** Build even when main has not moved since the last nightly build. */
  force: boolean;
  onMain: boolean;
  sha: string;
  previousSha: string | null;
  verifyPassed: boolean;
  verifyWindowsPassed: boolean;
}

export interface NightlyPlan {
  build: boolean;
  publish: boolean;
  /** A reason the run should fail rather than skip. */
  error?: string;
  reason: string;
}

export function planNightly(input: NightlyPlanInput): NightlyPlan {
  const short = input.sha.slice(0, 7);
  if (input.publish && !input.onMain) {
    return { build: false, publish: false, error: "Nightly builds publish only from main; run with publish off to try a branch.", reason: "not main" };
  }
  if (!input.force && input.previousSha === input.sha) {
    return { build: false, publish: false, reason: `main has not moved since the last nightly build (${short})` };
  }
  if (input.publish && !(input.verifyPassed && input.verifyWindowsPassed)) {
    const missing = [!input.verifyPassed && "Verify", !input.verifyWindowsPassed && "Verify Windows"].filter(Boolean).join(" and ");
    const reason = `${missing} has not passed on ${short}`;
    // Asked for by hand, say so loudly; the schedule tries again tomorrow.
    return input.event === "workflow_dispatch"
      ? { build: false, publish: false, error: `${reason}; wait for it or fix main.`, reason }
      : { build: false, publish: false, reason };
  }
  return { build: true, publish: input.publish, reason: input.publish ? `publishing ${short}` : `building ${short} without publishing` };
}

/**
 * Nightly prereleases published more than `days` days before `now`, other
 * than `keepTag` and the newest nightly build. Nothing else is ever listed: a
 * stable release, a draft, a prerelease that is not a nightly tag, or a
 * release with no publish date stays.
 */
export function prunableNightlies(releases: ReleaseListing[], now: Date, days: number, keepTag: string | null): string[] {
  const cutoff = now.getTime() - days * 24 * 60 * 60 * 1000;
  const nightlies = releases.filter((release) => release.prerelease && !release.draft && isNightlyTag(release.tag_name));
  const newest = nightlies.map((release) => release.tag_name).sort((left, right) => compareSemver(right, left) ?? 0)[0];
  return nightlies
    .filter((release) => release.tag_name !== keepTag && release.tag_name !== newest)
    // An unparseable or missing date is NaN, which is never below the cutoff.
    .filter((release) => Date.parse(release.published_at ?? "") < cutoff)
    .map((release) => release.tag_name);
}

/**
 * The releases a failed publish leaves behind for `tag`: its drafts, by id.
 * A published release is never listed, and deleting a release by id leaves
 * its tag alone.
 */
export function leftoverDrafts(releases: ReleaseListing[], tag: string): number[] {
  if (!isNightlyTag(tag)) throw new Error(`${tag} is not a nightly tag`);
  return releases.filter((release) => release.draft && release.tag_name === tag).map((release) => release.id);
}

type Gh = (args: string[]) => Promise<string>;

async function gh(args: string[]): Promise<string> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`gh ${args.join(" ")} failed: ${stderr.trim()}`);
  return stdout;
}

/**
 * The latest stable release's tag. A failed read fails the run: guessing the
 * base from package.json could publish `0.16.4-nightly.*`, which sorts below
 * the stable 0.16.4 everyone already has.
 */
export async function readLatestStableTag(repo: string, run: Gh = gh): Promise<string> {
  let tag: string;
  try {
    tag = (await run(["api", `repos/${repo}/releases/latest`, "--jq", ".tag_name"])).trim();
  } catch (error) {
    throw new Error(`Could not read the latest stable release, so there is no version to build: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = parseSemver(tag);
  if (!parsed || parsed.prerelease) throw new Error(`The latest release ${JSON.stringify(tag)} is not a stable version`);
  return tag;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function listReleases(repo: string, pages: number): Promise<ReleaseListing[]> {
  const releases: ReleaseListing[] = [];
  for (let page = 1; page <= pages; page += 1) {
    const batch = JSON.parse(await gh(["api", `repos/${repo}/releases?per_page=100&page=${page}`])) as ReleaseListing[];
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  return releases;
}

async function latestNightly(repo: string): Promise<{ tag: string; sha: string } | null> {
  const nightlies = (await listReleases(repo, 1))
    .filter((release) => release.prerelease && !release.draft && isNightlyTag(release.tag_name))
    .sort((left, right) => compareSemver(right.tag_name, left.tag_name) ?? 0);
  const tag = nightlies[0]?.tag_name;
  if (!tag) return null;
  const sha = (await gh(["api", `repos/${repo}/commits/${tag}`, "--jq", ".sha"])).trim();
  return { tag, sha };
}

async function workflowPassed(repo: string, workflow: string, sha: string): Promise<boolean> {
  const count = await gh([
    "api",
    `repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&event=push&status=success&per_page=1`,
    "--jq",
    ".total_count",
  ]);
  return Number(count.trim()) > 0;
}

function writeOutputs(values: Record<string, string>): void {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${lines.join("\n")}\n`);
  else console.log(lines.join("\n"));
}

function writeSummary(markdown: string): void {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
  console.log(markdown);
}

function fail(message: string): never {
  console.error(`::error::${message}`);
  process.exit(1);
}

async function runPlan(): Promise<void> {
  const repo = requireEnv("GITHUB_REPOSITORY");
  const sha = requireEnv("GITHUB_SHA");
  const runNumber = Number(requireEnv("GITHUB_RUN_NUMBER"));
  const packageVersion = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
  // Fails the plan, so nothing builds or publishes; no outputs are written.
  const latestStable = await readLatestStableTag(repo).catch((error: Error) => fail(error.message));
  const previous = await latestNightly(repo);
  const [verifyPassed, verifyWindowsPassed] = await Promise.all([
    workflowPassed(repo, "verify.yml", sha),
    workflowPassed(repo, "verify-windows.yml", sha),
  ]);
  const plan = planNightly({
    event: requireEnv("GITHUB_EVENT_NAME"),
    publish: process.env.NIGHTLY_PUBLISH === "true",
    force: process.env.NIGHTLY_FORCE === "true",
    onMain: process.env.GITHUB_REF === "refs/heads/main",
    sha,
    previousSha: previous?.sha ?? null,
    verifyPassed,
    verifyWindowsPassed,
  });
  const version = nightlyVersion(nightlyBaseVersion(packageVersion, latestStable), new Date(), runNumber, sha);

  writeOutputs({
    build: String(plan.build),
    publish: String(plan.publish),
    sha,
    version,
    previous_tag: previous?.tag ?? "",
  });
  writeSummary([
    `### Nightly ${plan.build ? version : "skipped"}`,
    "",
    `- ${plan.error ?? plan.reason}`,
    `- Latest stable release: ${latestStable}; last nightly build: ${previous?.tag ?? "none"}`,
    `- Verify on ${sha.slice(0, 7)}: ${verifyPassed ? "passed" : "not passed"}; Verify Windows: ${verifyWindowsPassed ? "passed" : "not passed"}`,
  ].join("\n"));
  if (plan.error) fail(plan.error);
  if (!plan.build) console.log(`::notice::No nightly build: ${plan.reason}`);
}

async function runNotes(): Promise<void> {
  const repo = requireEnv("GITHUB_REPOSITORY");
  const sha = requireEnv("NIGHTLY_SHA");
  const previousTag = process.env.NIGHTLY_PREVIOUS_TAG?.trim();
  const lines = [
    `Nightly build of main at ${sha.slice(0, 7)}, for the nightly release channel. It is not a stable release and can break; stable releases are listed on the [changelog](https://gloom.sh/changelog).`,
  ];
  if (previousTag) {
    const titles = (await gh([
      "api",
      `repos/${repo}/compare/${previousTag}...${sha}`,
      "--jq",
      ".commits[].commit.message | split(\"\\n\")[0]",
    ])).trim().split("\n").filter(Boolean).reverse();
    lines.push("", `Since ${previousTag}:`, "", ...titles.map((title) => `- ${title}`));
  }
  console.log(lines.join("\n"));
}

async function runPrune(): Promise<void> {
  const repo = requireEnv("GITHUB_REPOSITORY");
  const days = Number(process.env.NIGHTLY_PRUNE_DAYS?.trim() || "0");
  const keepTag = process.env.NIGHTLY_KEEP_TAG?.trim() || null;
  const tags = prunableNightlies(await listReleases(repo, 5), new Date(), days > 0 ? days : 14, keepTag);
  if (!(days > 0)) {
    // Deleting releases waits for the repository variable that allows it.
    writeSummary(`Nightly prune is off (set NIGHTLY_PRUNE_DAYS to turn it on). It would delete: ${tags.join(", ") || "nothing"}`);
    return;
  }
  for (const tag of tags) {
    await gh(["release", "delete", tag, "--repo", repo, "--cleanup-tag", "--yes"]);
    console.log(`Deleted nightly prerelease ${tag}`);
  }
  writeSummary(`Pruned ${tags.length} nightly prerelease(s) older than ${days} days.`);
}

function requireNightlyTag(): string {
  const tag = requireEnv("NIGHTLY_TAG");
  if (!isNightlyTag(tag)) fail(`${tag} is not a nightly tag`);
  return tag;
}

/**
 * Before the draft is created: no tag and no release, draft or not, may carry
 * this run's name yet, so whatever `drop-draft` later finds is this run's own.
 */
async function runClaimTag(): Promise<void> {
  const repo = requireEnv("GITHUB_REPOSITORY");
  const tag = requireNightlyTag();
  const proc = Bun.spawn(["gh", "api", `repos/${repo}/git/ref/tags/${tag}`], { stdout: "pipe", stderr: "pipe" });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code === 0) fail(`The tag ${tag} already exists; this run publishes nothing.`);
  if (!stderr.includes("HTTP 404")) fail(`Could not tell whether the tag ${tag} exists: ${stderr.trim()}`);
  const named = (await listReleases(repo, 1)).filter((release) => release.tag_name === tag);
  if (named.length > 0) fail(`A release named ${tag} already exists; this run publishes nothing.`);
  console.log(`${tag} is free`);
}

/**
 * After a failed or cancelled publish: deletes this run's drafts and nothing
 * else. By release id, so the tag stays (a draft has none of its own anyway),
 * and a release already published is never touched.
 */
async function runDropDraft(): Promise<void> {
  const repo = requireEnv("GITHUB_REPOSITORY");
  const tag = requireNightlyTag();
  const ids = leftoverDrafts(await listReleases(repo, 1), tag);
  for (const id of ids) {
    await gh(["api", "--method", "DELETE", `repos/${repo}/releases/${id}`]);
    console.log(`Deleted the draft ${tag} (release ${id})`);
  }
  writeSummary(ids.length > 0 ? `Deleted the unpublished draft ${tag}.` : `No draft named ${tag} to delete.`);
}

const COMMANDS: Record<string, () => Promise<void>> = {
  plan: runPlan,
  notes: runNotes,
  prune: runPrune,
  "claim-tag": runClaimTag,
  "drop-draft": runDropDraft,
};

if (import.meta.main) {
  const run = COMMANDS[process.argv[2] ?? ""];
  if (!run) {
    console.error(`Usage: bun run scripts/nightly.ts ${Object.keys(COMMANDS).join("|")}`);
    process.exit(1);
  }
  await run();
}

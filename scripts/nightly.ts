/**
 * The decisions behind .github/workflows/nightly.yml, kept here so they can be
 * tested:
 *
 *   bun run scripts/nightly.ts plan    whether this run builds, which commit, and as what version (GITHUB_OUTPUT)
 *   bun run scripts/nightly.ts notes   the prerelease notes: what changed since the last nightly build
 *   bun run scripts/nightly.ts prune   nightly prereleases older than NIGHTLY_PRUNE_DAYS; a dry run without it
 *   bun run scripts/nightly.ts claim-tag   fails unless no tag and no release (draft included) is named NIGHTLY_TAG yet
 *   bun run scripts/nightly.ts check-workflows   whether main's .github/workflows still match NIGHTLY_SHA's (GITHUB_OUTPUT)
 *   bun run scripts/nightly.ts drop-draft  after a failed publish, deletes the drafts named NIGHTLY_TAG, nothing else
 *
 * A nightly build is of the newest commit among main's last NIGHTLY_WINDOW on
 * which Verify and Verify Windows both passed: main's head when it is green,
 * otherwise its newest green ancestor, so a run that fires while the head is
 * still being verified (the schedule is often hours late, during the merges)
 * does not skip the day.
 *
 * That commit also has to have the same .github/workflows tree as main's head.
 * GitHub refuses a release (and its tag) for a commit whose workflow files
 * differ from the default branch's when the token has no `workflows`
 * permission, which the publish job does not and must not have. A verified
 * commit whose workflows differ is passed over for an older one that matches,
 * never one at or before the last nightly build's, and the publish job checks
 * once more right before it uploads, because main can move during the build.
 *
 * It is named `<base>-nightly.<UTC date>.<run number>.g<sha7>`, with the commit
 * that was built in the name. The base is the patch after the latest stable
 * release, so every nightly build sorts above the stable release users already
 * have and below the next one; the date and run number order two builds of one
 * day, whatever their shas look like. Nothing here commits, tags or touches a
 * stable release: GitHub reads go through `gh`, `prune` deletes nothing but
 * nightly prereleases, and `drop-draft` nothing but the unpublished draft its
 * own run created. No command deletes a git tag other than `prune`, with the
 * nightly release it belongs to.
 */
import { appendFileSync } from "fs";
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

/** How many of main's newest commits the plan looks through for one both checks passed on. */
const NIGHTLY_WINDOW = 30;

/** The branch nightly builds publish from, which is the default branch GitHub compares a release target's workflows with. */
const MAIN = "main";
const WORKFLOWS_DIR = ".github/workflows";

export interface NightlyPlanInput {
  event: string;
  /** The run asked to publish; off builds everything and publishes nothing. */
  publish: boolean;
  /** Build even when main has not moved since the last nightly build. */
  force: boolean;
  onMain: boolean;
  /** The commit the run started on: main's head when the schedule fired. */
  head: string;
  /** Main's first-parent history from `head` (first) back, newest first, at most NIGHTLY_WINDOW long. */
  history: string[];
  /** The commit the last nightly build was made from. */
  previousSha: string | null;
  /** Commits Verify concluded success on for a push to main. */
  verifyPassed: string[];
  /** Commits Verify Windows concluded success on for main (push, schedule, or manual dispatch). */
  verifyWindowsPassed: string[];
  /** The .github/workflows tree SHA at each commit `verifiedCommits` lists; read only when the run publishes. */
  workflowTrees: Record<string, string>;
  /** The .github/workflows tree SHA at main's head right now, which a release target's has to equal. */
  mainWorkflowTree: string;
}

export interface NightlyPlan {
  build: boolean;
  publish: boolean;
  /** The commit to build and tag: main's head, or its newest ancestor both checks passed on. Empty when there is none. */
  sha: string;
  /** A reason the run should fail rather than skip. */
  error?: string;
  reason: string;
}

interface NightlyPick {
  sha: string;
  /** How many commits it is behind main's head. */
  behind: number;
}

/**
 * The commits in `history` (newest first) that both checks passed on, newest
 * first. The last nightly build's commit stops the list and counts as passed,
 * since it was published: a re-run or a missing record on it must never send
 * the next nightly build back to an older commit.
 */
export function verifiedCommits(history: string[], verifyPassed: string[], verifyWindowsPassed: string[], previousSha: string | null): NightlyPick[] {
  const verify = new Set(verifyPassed);
  const verifyWindows = new Set(verifyWindowsPassed);
  const picks: NightlyPick[] = [];
  for (const [behind, sha] of history.entries()) {
    const isPrevious = sha === previousSha;
    if (isPrevious || (verify.has(sha) && verifyWindows.has(sha))) picks.push({ sha, behind });
    if (isPrevious) break;
  }
  return picks;
}

function shortShas(picks: NightlyPick[]): string {
  const shown = picks.slice(0, 3).map((pick) => pick.sha.slice(0, 7)).join(", ");
  return picks.length > 3 ? `${shown} and ${picks.length - 3} more` : shown;
}

export function planNightly(input: NightlyPlanInput): NightlyPlan {
  const head = input.head.slice(0, 7);
  if (input.publish && !input.onMain) {
    return { build: false, publish: false, sha: "", error: "Nightly builds publish only from main; run with publish off to try a branch.", reason: "not main" };
  }
  if (!input.force && input.previousSha === input.head) {
    return { build: false, publish: false, sha: "", reason: `main has not moved since the last nightly build (${head})` };
  }
  // Not publishing is a try-out of this branch or commit, whatever the checks say.
  if (!input.publish) {
    return { build: true, publish: false, sha: input.head, reason: `building ${head} without publishing` };
  }
  // Asked for by hand, say so loudly; the schedule tries again tomorrow.
  const stop = (reason: string, hint = "wait for it or fix main"): NightlyPlan => input.event === "workflow_dispatch"
    ? { build: false, publish: false, sha: "", error: `${reason}; ${hint}.`, reason }
    : { build: false, publish: false, sha: "", reason };

  const verified = verifiedCommits(input.history, input.verifyPassed, input.verifyWindowsPassed, input.previousSha);
  if (verified.length === 0) {
    return stop(`None of main's last ${input.history.length} commits has passed Verify and Verify Windows (head ${head})`);
  }
  const sameWorkflows = (pick: NightlyPick) => input.workflowTrees[pick.sha] === input.mainWorkflowTree;
  const pick = verified.find(sameWorkflows);
  // Verified commits newer than the pick (all of them without one) that main's workflows have moved on from.
  const passedOver = verified.filter((other) => other.sha !== input.previousSha && !sameWorkflows(other) && (!pick || other.behind < pick.behind));
  const passedOverNote = passedOver.length > 0
    ? `; passed over newer verified ${passedOver.length === 1 ? "commit" : "commits"} ${shortShas(passedOver)}, whose ${WORKFLOWS_DIR} differ from main's`
    : "";
  const noNewCommit = () => stop(`No commit after the last nightly build (${input.previousSha?.slice(0, 7)}) has passed Verify and Verify Windows; head ${head} not verified yet`);
  // GitHub refuses a release of a commit whose workflows differ from main's, so there is nothing to publish until one is verified.
  const workflowsMoved = (since: string) => stop(
    `Main's head changed ${WORKFLOWS_DIR} after ${since}, and GitHub refuses a release of a commit whose workflows differ`,
    "wait for the head to pass Verify and Verify Windows",
  );

  if (!pick) {
    if (passedOver.length > 0) return workflowsMoved(`the newest verified commit (${passedOver[0]!.sha.slice(0, 7)})`);
    // Only the last nightly build's commit is left, and it is not for a plain run.
    if (!input.force) return noNewCommit();
    return workflowsMoved(`the last nightly build's commit (${input.previousSha?.slice(0, 7)})`);
  }
  const short = pick.sha.slice(0, 7);
  if (pick.sha === input.previousSha) {
    if (!input.force) {
      return passedOver.length > 0 ? workflowsMoved(`the newest verified commit (${passedOver[0]!.sha.slice(0, 7)})`) : noNewCommit();
    }
    return { build: true, publish: true, sha: pick.sha, reason: `publishing ${short} again, the commit of the last nightly build${passedOverNote}` };
  }
  return {
    build: true,
    publish: true,
    sha: pick.sha,
    reason: (pick.behind === 0
      ? `publishing ${short}: main's head passed Verify and Verify Windows`
      : `publishing ${short}: head ${head} not verified yet; newest verified is ${short}, ${pick.behind} commit${pick.behind === 1 ? "" : "s"} behind`) + passedOverNote,
  };
}

interface CommitListing {
  sha: string;
  parents: string[];
}

/**
 * Main's first-parent history from `head`, newest first, at most `limit`
 * commits. `commits` is what the commit list answers: it holds a merge's
 * second-parent commits too, which a walk along first parents leaves out. It
 * ends early where `commits` runs out, a shorter window and nothing worse.
 */
export function firstParentHistory(head: string, commits: CommitListing[], limit: number): string[] {
  const firstParent = new Map(commits.map((commit) => [commit.sha, commit.parents[0]]));
  const history = [head];
  while (history.length < limit) {
    const parent = firstParent.get(history[history.length - 1]!);
    if (!parent) break;
    history.push(parent);
  }
  return history;
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

/** The tree SHA of .github/workflows at `rev`, a commit or a branch, read through the API so no checkout is needed. */
async function readWorkflowsTree(repo: string, rev: string, run: Gh): Promise<string> {
  return (await run(["api", `repos/${repo}/git/trees/${rev}:${WORKFLOWS_DIR}`, "--jq", ".sha"])).trim();
}

/** main's tree right now, and the tree at each of `shas`. A failed read fails the run: it must not pass for a difference. */
async function readWorkflowTrees(repo: string, shas: string[], run: Gh = gh): Promise<{ main: string; trees: Record<string, string> }> {
  const [main, ...trees] = await Promise.all([MAIN, ...shas].map((rev) => readWorkflowsTree(repo, rev, run)));
  return { main: main!, trees: Object.fromEntries(shas.map((sha, index) => [sha, trees[index]!])) };
}

export interface WorkflowRecheck {
  /** Whether a release of the commit would not be refused for its workflows. */
  current: boolean;
  reason: string;
}

/**
 * Right before the draft is created: whether main's .github/workflows are still
 * the ones `sha`, the commit that was built, has. Main can move during the build.
 */
export async function recheckWorkflows(repo: string, sha: string, run: Gh = gh): Promise<WorkflowRecheck> {
  const { main, trees } = await readWorkflowTrees(repo, [sha], run);
  const short = sha.slice(0, 7);
  if (trees[sha] === main) return { current: true, reason: `${WORKFLOWS_DIR} at ${short} still match main's head` };
  return {
    current: false,
    reason: `Main's head changed ${WORKFLOWS_DIR} while ${short} was built, and GitHub refuses a release of a commit whose workflows differ; nothing is published, and the next run builds again.`,
  };
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

interface WorkflowRunListing {
  head_sha: string;
  conclusion: string | null;
  event: string;
}

/**
 * The commits `workflow` concluded success on for `main` across `allowedEvents`.
 * Verify keeps `["push"]` (its scheduled run executes only the nightly tsc check),
 * whereas Verify Windows accepts `push`, `schedule`, and `workflow_dispatch` so
 * its daily pre-nightly run verifies main even when recent merges did not touch
 * Windows-specific paths.
 */
export async function passedShas(
  repo: string,
  workflow: string,
  allowedEvents: readonly string[] = ["push"],
  run: Gh = gh,
): Promise<string[]> {
  const eventQuery = allowedEvents.length === 1 ? `&event=${encodeURIComponent(allowedEvents[0]!)}` : "";
  const listing = await run([
    "api",
    `repos/${repo}/actions/workflows/${workflow}/runs?branch=main${eventQuery}&status=success&per_page=100`,
    "--jq",
    "[.workflow_runs[] | {head_sha, conclusion, event}]",
  ]);
  const allowed = new Set(allowedEvents);
  const seen = new Set<string>();
  const shas: string[] = [];
  for (const entry of JSON.parse(listing) as WorkflowRunListing[]) {
    if (entry.conclusion !== "success" || !allowed.has(entry.event)) continue;
    if (seen.has(entry.head_sha)) continue;
    seen.add(entry.head_sha);
    shas.push(entry.head_sha);
  }
  return shas;
}

async function readHistory(repo: string, head: string): Promise<string[]> {
  const listing = await gh([
    "api",
    `repos/${repo}/commits?sha=${head}&per_page=100`,
    "--jq",
    "[.[] | {sha, parents: [.parents[].sha]}]",
  ]);
  return firstParentHistory(head, JSON.parse(listing) as CommitListing[], NIGHTLY_WINDOW);
}

/**
 * The version in package.json at `sha`, the commit that gets built: main's head
 * can already carry a version bump the commit does not.
 */
async function readPackageVersion(repo: string, sha: string): Promise<string> {
  const file = await gh(["api", "-H", "Accept: application/vnd.github.raw+json", `repos/${repo}/contents/package.json?ref=${sha}`]);
  const version = (JSON.parse(file) as { version?: unknown }).version;
  if (typeof version !== "string") throw new Error(`package.json at ${sha.slice(0, 7)} has no version`);
  return version;
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
  const head = requireEnv("GITHUB_SHA");
  const runNumber = Number(requireEnv("GITHUB_RUN_NUMBER"));
  // Fails the plan, so nothing builds or publishes; no outputs are written.
  const latestStable = await readLatestStableTag(repo).catch((error: Error) => fail(error.message));
  const previous = await latestNightly(repo);
  const [history, verifyPassed, verifyWindowsPassed] = await Promise.all([
    readHistory(repo, head),
    passedShas(repo, "verify.yml", ["push"]),
    passedShas(repo, "verify-windows.yml", ["push", "schedule", "workflow_dispatch"]),
  ]);
  const publish = process.env.NIGHTLY_PUBLISH === "true";
  const onMain = process.env.GITHUB_REF === "refs/heads/main";
  // Only a release is refused for its workflows; a try-out build reads nothing.
  const workflows = publish && onMain
    ? await readWorkflowTrees(repo, verifiedCommits(history, verifyPassed, verifyWindowsPassed, previous?.sha ?? null).map((pick) => pick.sha))
    : null;
  const plan = planNightly({
    event: requireEnv("GITHUB_EVENT_NAME"),
    publish,
    force: process.env.NIGHTLY_FORCE === "true",
    onMain,
    head,
    history,
    previousSha: previous?.sha ?? null,
    verifyPassed,
    verifyWindowsPassed,
    workflowTrees: workflows?.trees ?? {},
    mainWorkflowTree: workflows?.main ?? "",
  });
  // The version and everything after it belong to the commit that is built, not to the one the run started on.
  const version = plan.build
    ? nightlyVersion(nightlyBaseVersion(await readPackageVersion(repo, plan.sha), latestStable), new Date(), runNumber, plan.sha)
    : "";

  writeOutputs({
    build: String(plan.build),
    publish: String(plan.publish),
    sha: plan.build ? plan.sha : "",
    version,
    previous_tag: previous?.tag ?? "",
  });
  writeSummary([
    `### Nightly ${plan.build ? version : "skipped"}`,
    "",
    `- ${plan.error ?? plan.reason}`,
    `- Latest stable release: ${latestStable}; last nightly build: ${previous?.tag ?? "none"}`,
    `- Head ${head.slice(0, 7)}: Verify ${verifyPassed.includes(head) ? "passed" : "not passed"}, Verify Windows ${verifyWindowsPassed.includes(head) ? "passed" : "not passed"}; looked through ${history.length} commit${history.length === 1 ? "" : "s"} of history`,
    ...(workflows ? [`- ${WORKFLOWS_DIR} at main's head: ${workflows.main.slice(0, 7)}`] : []),
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
 * Right before the draft: the later steps of the publish job run only when main's
 * workflows still match the built commit's. When they do not, nothing is created,
 * no draft and no tag, and the run stays green.
 */
async function runCheckWorkflows(): Promise<void> {
  const { current, reason } = await recheckWorkflows(requireEnv("GITHUB_REPOSITORY"), requireEnv("NIGHTLY_SHA"));
  writeOutputs({ current: String(current) });
  if (current) {
    console.log(reason);
    return;
  }
  console.log(`::notice::No nightly published. ${reason}`);
  writeSummary(`### Nightly not published\n\n- ${reason}`);
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
  "check-workflows": runCheckWorkflows,
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

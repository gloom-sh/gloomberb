import { VERSION } from "../version";

/**
 * Just enough semver for plugin versions: `1.2.3`, `v1.2.3`, and a
 * prerelease suffix. Anything else is not a version and compares as unknown.
 */

const SEMVER_PATTERN = /^v?(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/;

export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: string | null;
}

export function parseSemver(value: string | null | undefined): ParsedSemver | null {
  if (!value) return null;
  const match = SEMVER_PATTERN.exec(value.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] ? Number(match[3]) : 0,
    prerelease: match[4] ?? null,
  };
}

const NUMERIC_IDENTIFIER = /^\d+$/;

/** Digit strings by value, without the precision limit of `Number` (a date and run can be long). */
function compareDigits(a: string, b: string): number {
  const left = a.replace(/^0+(?=\d)/, "");
  const right = b.replace(/^0+(?=\d)/, "");
  if (left.length !== right.length) return left.length - right.length;
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Semver precedence for two prerelease tags: dot-separated identifiers left to
 * right, digits by value, digits below words, words in ASCII order, and a tag
 * that runs out first is older. `nightly.20261015.9` is older than
 * `nightly.20261015.10`, which a plain string comparison gets backwards.
 */
function comparePrerelease(a: string, b: string): number {
  const left = a.split(".");
  const right = b.split(".");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const l = left[index];
    const r = right[index];
    if (l === undefined) return -1;
    if (r === undefined) return 1;
    if (l === r) continue;
    const leftNumeric = NUMERIC_IDENTIFIER.test(l);
    const rightNumeric = NUMERIC_IDENTIFIER.test(r);
    if (leftNumeric && rightNumeric) {
      const order = compareDigits(l, r);
      if (order !== 0) return order;
      continue;
    }
    if (leftNumeric) return -1;
    if (rightNumeric) return 1;
    return l < r ? -1 : 1;
  }
  // Only spellings differ (`01` against `1`): keep the order total.
  return a === b ? 0 : a < b ? -1 : 1;
}

/** Negative when `a` is older than `b`, positive when newer, `null` when either is not a version. */
export function compareSemver(a: string | null | undefined, b: string | null | undefined): number | null {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left || !right) return null;
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  if (left.patch !== right.patch) return left.patch - right.patch;
  // A release outranks its own prerelease.
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** A version with a prerelease tag, such as a nightly build (`0.17.5-nightly.20261015.42.gabc1234`). */
export function isPrereleaseVersion(value: string | null | undefined): boolean {
  return parseSemver(value)?.prerelease != null;
}

/** `v1.2.3` and `1.2.3` are the same version; keep one spelling for display. */
export function formatVersion(value: string | null | undefined): string | null {
  const parsed = parseSemver(value);
  if (!parsed) return value?.trim() || null;
  const base = `${parsed.major}.${parsed.minor}.${parsed.patch}`;
  return parsed.prerelease ? `${base}-${parsed.prerelease}` : base;
}

/**
 * The Gloomberb a plugin's published code needs, when this build is older;
 * null when it runs here or the registry does not say. The registry states it
 * for the code an install or update would land on, not the checkout already
 * on disk, so it blocks those two actions and nothing else. Without it the
 * update goes through and the plugin then fails to compile against a host
 * that lacks what it imports.
 */
export function requiredGloomberb(minGloomberb: string | null | undefined, current: string = VERSION): string | null {
  const order = compareSemver(current, minGloomberb);
  return order !== null && order < 0 ? formatVersion(minGloomberb) : null;
}

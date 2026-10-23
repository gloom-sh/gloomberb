import packageJson from "../package.json" with { type: "json" };

export const VERSION = packageJson.version;

/**
 * The npm package this copy came from: `@gloom/terminal`, or `gloomberb` for
 * installs from before the rename, which keeps getting the same releases.
 */
export const PACKAGE_NAME = packageJson.name;

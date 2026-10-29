import packageJson from "../package.json" with { type: "json" };

export const VERSION = packageJson.version;

/**
 * The npm package this copy came from: `@gloom-sh/terminal` or `gloomberb`,
 * which every release publishes with the same build.
 */
export const PACKAGE_NAME = packageJson.name;

import packageJson from "../package.json" with { type: "json" };

export const VERSION = packageJson.version;

/**
 * The npm package this copy came from: `gloomberb`, or `@gloom-sh/terminal`
 * once releases are also published under that name.
 */
export const PACKAGE_NAME = packageJson.name;

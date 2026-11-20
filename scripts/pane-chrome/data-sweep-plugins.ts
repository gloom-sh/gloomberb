import { join } from "node:path";
import { ABSORBED_PLUGINS } from "../../src/plugins/absorbed";
import type { RegistryPlugin } from "../../src/plugins/marketplace/model";
import type { SweepCase } from "./data-sweep";

/** A function card on gloom.sh, as the docs snapshot the app ships (`src/docs/snapshot.json`) records it. */
export interface FunctionCard {
  code: string;
  category?: string;
  plugin?: { id: string; name?: string };
}

/**
 * First-party plugins, reviewed for the plugin lane. A plugin with `codes` is
 * installed from its gloom-sh repository and each code is captured with the
 * input listed; one with `skip` is reported with that reason and never
 * installed. Before adding one: read its source, check it reads public data
 * without a Gloom session or a key of its own, and that its package.json
 * declares no sibling plugin (the installer would bring that along).
 */
export interface ReviewedPlugin {
  repo: string;
  codes?: Record<string, string[]>;
  skip?: string;
}

export const REVIEWED_PLUGINS: Record<string, ReviewedPlugin> = {
  hackernews: { repo: "gloom-sh/gloom-hackernews", codes: { HN: [] } },
  "crypto-fear-greed": { repo: "gloom-sh/gloom-fear-greed-crypto", codes: { CFNG: [] } },
  growthepie: { repo: "gloom-sh/gloom-growthepie", codes: { GTP: [] } },
  // The card's own example: a search, read-only like the default board.
  "prediction-markets": { repo: "gloom-sh/gloom-prediction-markets", codes: { PM: ["inflation"] } },
  polls: { repo: "gloom-sh/gloom-polls", codes: { POLL: [] } },
  "byok-ai": { repo: "gloom-sh/gloom-byok-ai", skip: "Generative: AI and AGENT run on the model account you configure, and every prompt spends its tokens" },
  tv: { repo: "gloom-sh/gloom-tv", skip: "Live television video and audio (media), not data a capture can check" },
  substack: { repo: "gloom-sh/gloom-substack", skip: "Your Substack inbox, read with your own Substack sign-in (account data)" },
  ibkr: { repo: "gloom-sh/gloom-ibkr", skip: "Broker account sync: needs your IBKR Flex Web Service token, and has no pane of its own" },
  "ibkr-gateway": { repo: "gloom-sh/gloom-ibkr-gateway", skip: "Trading console with order entry on your real IBKR account, through your own Gateway or TWS" },
  aries: { repo: "gloom-sh/gloom-aries", skip: "Broker accounts and orders: needs your Aries sign-in" },
  public: { repo: "gloom-sh/gloom-public", skip: "Broker position sync: needs your Public API key, and has no pane of its own" },
  robinhood: { repo: "gloom-sh/gloom-robinhood", skip: "Broker position sync: needs your Robinhood sign-in, and has no pane of its own" },
  simplefin: { repo: "gloom-sh/gloom-simplefin", skip: "Investment position sync: needs your SimpleFIN Bridge token, and has no pane of its own" },
};

const FIRST_PARTY_OWNER = "gloom-sh";
const FIRST_PARTY_REPO = /^gloom-sh\/([a-z0-9][a-z0-9-]{0,99})$/;

function owner(repo: string): string {
  return repo.split("/")[0]!.toLowerCase();
}

function reviewedPlugin(id: string, reviewed: Record<string, ReviewedPlugin>): ReviewedPlugin | undefined {
  return Object.hasOwn(reviewed, id) ? reviewed[id] : undefined;
}

/**
 * What the plugin lane hands the app's installer: a github.com/gloom-sh URL
 * for a plugin the lane measures. Anything else is refused, whatever the
 * registry says: the feed is never the source of what gets installed.
 */
export function pluginInstallRef(id: string, reviewed: Record<string, ReviewedPlugin> = REVIEWED_PLUGINS): string {
  const plugin = reviewedPlugin(id, reviewed);
  if (!plugin?.codes) throw new Error(`Refusing to install ${id}: it is not a reviewed plugin-lane plugin`);
  const name = FIRST_PARTY_REPO.exec(plugin.repo)?.[1];
  if (!name) throw new Error(`Refusing to install ${plugin.repo}: the plugin lane installs only from github.com/gloom-sh`);
  return `https://github.com/gloom-sh/${name}`;
}

/** The folder the installer gives a reviewed plugin: its repository's name. */
export function pluginDirectory(id: string, reviewed: Record<string, ReviewedPlugin> = REVIEWED_PLUGINS): string {
  return pluginInstallRef(id, reviewed).slice("https://github.com/gloom-sh/".length);
}

/**
 * Parent variables a plugin-lane child may see. Never a denylist: anything not
 * named here (a Gloom session, a GitHub, cloud or model key, a proxy with a
 * password in it, an SSH agent) stays out. None of these holds a credential.
 */
const PLUGIN_ENV_PASSTHROUGH = ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ", "CHROME_PATH",
  "SYSTEMROOT", "WINDIR", "COMSPEC", "PATHEXT", "PROGRAMFILES", "PROGRAMFILES(X86)"] as const;

/**
 * The whole environment of a plugin-lane child. HOME is a folder in the
 * throwaway profile, so git reads no user config or credential helper, and
 * plugin code finds no real profile under its home.
 */
export function pluginLaneEnv(parent: NodeJS.ProcessEnv, profile: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of PLUGIN_ENV_PASSTHROUGH) {
    const value = parent[name];
    if (typeof value === "string" && value) env[name] = value;
  }
  const home = join(profile, "home");
  const temp = join(profile, "tmp");
  return { ...env, HOME: home, USERPROFILE: home, GLOOMBERB_HOME: profile, TMPDIR: temp, TMP: temp, TEMP: temp,
    GLOOMBERB_NO_TELEMETRY: "1", DO_NOT_TRACK: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_TERMINAL_PROMPT: "0" };
}

/**
 * One case per plugin code, from the registry feed's shortcuts and the
 * function cards; a plugin with no code gets one case under its id. A
 * reviewed plugin is measured or skipped as reviewed; a gloom-sh plugin the
 * list does not have is missing, like a new pane; any other owner's plugin is
 * excluded and never installed. `feed` null is a feed that could not be read.
 */
export function planPlugins(feed: readonly RegistryPlugin[] | null, cards: readonly FunctionCard[],
  reviewed: Record<string, ReviewedPlugin> = REVIEWED_PLUGINS): SweepCase[] {
  const plugins = new Map<string, { repo?: string; codes: Set<string> }>();
  const plugin = (id: string) => {
    const known = plugins.get(id) ?? { codes: new Set<string>() };
    plugins.set(id, known);
    return known;
  };
  for (const listed of feed ?? []) {
    if (!listed || typeof listed.id !== "string" || listed.bundled === true) continue;
    const known = plugin(listed.id);
    if (typeof listed.repo === "string") known.repo = listed.repo;
    for (const shortcut of Array.isArray(listed.contributes?.shortcuts) ? listed.contributes.shortcuts : []) {
      if (typeof shortcut?.code === "string" && shortcut.code.trim()) known.codes.add(shortcut.code.trim().toUpperCase());
    }
  }
  for (const card of cards) if (card.plugin?.id) plugin(card.plugin.id).codes.add(card.code);
  for (const [id, entry] of Object.entries(reviewed)) for (const code of Object.keys(entry.codes ?? {})) plugin(id).codes.add(code);

  const cases: SweepCase[] = feed ? [] : [{ id: "registry/feed", token: "registry", lane: "plugin", args: [], status: "missing",
    reason: "The plugin registry feed could not be read, so new plugins cannot be found for review" }];
  for (const [id, { repo, codes }] of [...plugins].sort(([left], [right]) => left.localeCompare(right))) {
    const each = (status: NonNullable<SweepCase["status"]>, reason: string): SweepCase[] => (codes.size ? [...codes].sort() : [id])
      .map((code) => ({ id: `${code}/plugin`, token: code, lane: `plugin:${id}`, args: [], plugin: id, status, reason }));
    const absorbed = ABSORBED_PLUGINS.find((candidate) => candidate.id === id);
    const entry = reviewedPlugin(id, reviewed);
    if (absorbed) cases.push(...each("skipped", `${absorbed.name} is built into Gloom now; the main lane measures the built-in`));
    else if (entry && repo && repo.toLowerCase() !== entry.repo.toLowerCase()) {
      cases.push(...each("missing", `The registry lists ${id} from ${repo}, not the reviewed ${entry.repo}; needs review`));
    } else if (entry?.skip) cases.push(...each("skipped", entry.skip));
    else if (entry?.codes) {
      const inputs = entry.codes;
      for (const code of [...codes].sort()) {
        cases.push(Object.hasOwn(inputs, code)
          ? { id: `${code}/plugin`, token: code, lane: `plugin:${id}`, args: inputs[code]!, plugin: id }
          : { id: `${code}/plugin`, token: code, lane: `plugin:${id}`, args: [], plugin: id, status: "missing", reason: "New plugin code needs input review" });
      }
    } else if (!repo) {
      cases.push(...each("missing", feed ? "A function card names a plugin the registry feed does not list; its owner needs review"
        : "The registry feed is unread, so this plugin's owner is unknown"));
    } else if (owner(repo) !== FIRST_PARTY_OWNER) {
      cases.push(...each("excluded", `Third-party plugin (${repo}): its code never runs in this sweep`));
    } else {
      cases.push(...each("missing", `First-party plugin (${repo}) is not on the reviewed plugin-lane list; needs read-only and input review`));
    }
  }
  return cases;
}

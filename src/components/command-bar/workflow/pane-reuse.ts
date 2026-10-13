import type { PaneBinding, PaneInstanceConfig } from "../../../types/config";
import type { PaneDef, PaneTemplateDef, PaneTemplateInstanceConfig } from "../../../types/plugin";
import { scopedBrokerContractIdentityKey } from "../../../utils/instrument-identity";

/**
 * Which open pane a pane template focuses instead of adding another one.
 *
 * Opening a function that is already open focuses its window. What counts as
 * "the same function" is, in order:
 *
 * 1. The pane that holds the spec's stable `instanceId`, unless that pane has
 *    since been pointed at another ticker.
 * 2. A pane the spec describes exactly (binding, params and settings).
 * 3. A pane of the same type that shows what the spec names: the same ticker
 *    or binding, the same params and every setting the spec sets. A pane
 *    carries more settings than its spec as soon as the user touches one (the
 *    live streaming toggle, a range, a column), and a stable id outlives the
 *    ticker or channel a pane was opened on, so neither can be required to
 *    match. Settings the spec leaves out are tolerated only when they cannot
 *    belong to another function, which the host knows in one of two ways: the
 *    template is the only one that opens its pane type, or the pane type
 *    declares its `identitySettings` and the window carries none of them that
 *    the spec leaves out (ERN's window has no `board`, EVTS's has). Either way
 *    the spec has to name a ticker or take no argument (or an optional one,
 *    typed bare): a blank form that builds something new (VIEW) is not tolerated.
 */

/** Key order in stored settings is not guaranteed, so compare on sorted keys. */
function stableKey(value: unknown): string {
  return JSON.stringify(value, (_key, entry) => (
    entry && typeof entry === "object" && !Array.isArray(entry)
      ? Object.fromEntries(Object.entries(entry as Record<string, unknown>).sort(
        ([left], [right]) => left.localeCompare(right),
      ))
      : entry
  ));
}

/**
 * A ticker pane's id names the ticker it opened on (`options:AAPL`), but a pane linked to a list
 * since then, or unlinked on another ticker, shows something else. Typing `OMON AAPL` must not
 * retarget it: a linked pane would silently stop following, and an unlinked one would be taken over.
 */
function showsOtherTicker(owner: PaneInstanceConfig, spec: PaneTemplateInstanceConfig): boolean {
  return spec.binding?.kind === "fixed" && (
    owner.binding?.kind === "follow"
    || (owner.binding?.kind === "fixed" && owner.binding.symbol !== spec.binding.symbol)
  );
}

/**
 * When the pane holding a ticker template's id shows another ticker, the command opens its own
 * pinned pane under a further stable id (`options:AAPL:pinned`, then `:pinned-2`), so typing it
 * again lands on that pane rather than a new one (OMON keeps rewriting its settings, so the
 * whole-spec match would miss it). A pinned pane that was linked or moved on since is
 * skipped the same way, so the ids never run out into unkeyed duplicates.
 */
export function withFreeTickerInstanceId(
  instances: PaneInstanceConfig[],
  paneId: string,
  spec: PaneTemplateInstanceConfig,
): PaneTemplateInstanceConfig {
  const baseId = spec.instanceId;
  if (!baseId) return spec;
  const byId = new Map(instances.map((instance) => [instance.instanceId, instance]));
  const owner = byId.get(baseId);
  if (owner?.paneId !== paneId || !showsOtherTicker(owner, spec)) return spec;
  let free: string | null = null;
  // One more id than there are panes is always enough to find a free one.
  for (let index = 1; index <= instances.length + 1; index += 1) {
    const instanceId = index === 1 ? `${baseId}:pinned` : `${baseId}:pinned-${index}`;
    const holder = byId.get(instanceId);
    if (!holder) free ??= instanceId;
    else if (holder.paneId === paneId && !showsOtherTicker(holder, spec)) return { ...spec, instanceId };
  }
  return { ...spec, instanceId: free ?? undefined };
}

/** What a binding points at, ignoring how it was written down. */
function bindingIdentity(binding: PaneBinding | undefined): string {
  if (!binding || binding.kind === "none") return "none";
  if (binding.kind === "follow") return `follow:${binding.sourceInstanceId}`;
  const instrument = binding.instrument === undefined ? "unspecified"
    : binding.instrument === null ? "public"
    : scopedBrokerContractIdentityKey(binding.instrument);
  return `fixed:${binding.symbol}:${instrument}`;
}

function isOnlyTemplateForPane(template: PaneTemplateDef, templates: ReadonlyMap<string, PaneTemplateDef>): boolean {
  for (const other of templates.values()) {
    if (other !== template && other.paneId === template.paneId) return false;
  }
  return true;
}

/** Whether the spec says which window it means by more than its pane type. */
function namesATarget(spec: PaneTemplateInstanceConfig): boolean {
  return (!!spec.binding && spec.binding.kind !== "none") || Object.keys(spec.params ?? {}).length > 0;
}

/** What a window may carry beyond the settings a spec names. */
interface OtherSettings {
  /** The pane type's `identitySettings`: a window that has one the spec does not set is another function's. */
  identity: readonly string[] | undefined;
  /** The template is the only one that opens its pane type. */
  onlyTemplate: boolean;
  /** The spec names a ticker or params, or the form takes no argument or an optional one. */
  bareFormOk: boolean;
}

function showsWhatSpecNames(
  instance: PaneInstanceConfig,
  spec: PaneTemplateInstanceConfig,
  other: OtherSettings,
): boolean {
  if (bindingIdentity(instance.binding) !== bindingIdentity(spec.binding)) return false;
  if (stableKey(instance.params ?? {}) !== stableKey(spec.params ?? {})) return false;
  const stored = instance.settings ?? {};
  const named = spec.settings ?? {};
  if (Object.entries(named).some(([key, value]) => stableKey(stored[key]) !== stableKey(value))) return false;
  const unnamed = Object.keys(stored).filter((key) => !(key in named));
  if (unnamed.length === 0) return true;
  const namesSettings = Object.keys(named).length > 0;
  if (other.identity) {
    // Another function's window carries a setting that says so; the rest are the window's own.
    return !unnamed.some((key) => other.identity!.includes(key)) && (namesSettings || other.bareFormOk);
  }
  return namesSettings || (other.onlyTemplate && other.bareFormOk);
}

export function findReusablePaneInstance(
  instances: PaneInstanceConfig[],
  template: PaneTemplateDef,
  templates: ReadonlyMap<string, PaneTemplateDef>,
  spec: PaneTemplateInstanceConfig,
  options: { focusedPaneId?: string | null; paneDef?: Pick<PaneDef, "identitySettings"> } = {},
): PaneInstanceConfig | null {
  const paneId = template.paneId;
  if (spec.instanceId) {
    const owner = instances.find((instance) => instance.instanceId === spec.instanceId);
    if (owner && owner.paneId === paneId && !showsOtherTicker(owner, spec)) return owner;
  }
  const candidates = instances.filter((instance) => instance.paneId === paneId);
  const specKey = stableKey([spec.binding ?? { kind: "none" }, spec.params ?? {}, spec.settings ?? {}]);
  const exact = candidates.find((instance) => (
    stableKey([instance.binding ?? { kind: "none" }, instance.params ?? {}, instance.settings ?? {}]) === specKey
  ));
  if (exact) return exact;

  const other: OtherSettings = {
    identity: options.paneDef?.identitySettings,
    onlyTemplate: isOnlyTemplateForPane(template, templates),
    bareFormOk: namesATarget(spec) || !template.shortcut?.argPlaceholder || template.shortcut.argOptional === true,
  };
  const matches = candidates.filter((instance) => showsWhatSpecNames(instance, spec, other));
  return matches.find((instance) => instance.instanceId === options.focusedPaneId) ?? matches[0] ?? null;
}

/**
 * A stable-id pane outlives the spec that opened it (Chat rewrites its own
 * channelId as the user switches channels inside the pane), so reuse has to put
 * the pane back on the requested spec before focusing it, or the command lands
 * on a pane showing something else. Returns null when nothing has to change.
 */
export function retargetPaneInstance(
  instance: PaneInstanceConfig,
  spec: PaneTemplateInstanceConfig,
): PaneInstanceConfig | null {
  const next: PaneInstanceConfig = {
    ...instance,
    title: spec.title ?? instance.title,
    binding: spec.binding ?? instance.binding,
    params: spec.params ? { ...(instance.params ?? {}), ...spec.params } : instance.params,
    settings: spec.settings ? { ...(instance.settings ?? {}), ...spec.settings } : instance.settings,
  };
  return stableKey(next) === stableKey(instance) ? null : next;
}

import type { PaneFunctionCatalog } from "../../../../cli/pane-functions/catalog";
import { stableStringify } from "../../../../remote/revision";
import {
  REMOTE_OPERATIONS,
  REMOTE_RESOURCES,
  remoteOperationDescriptors,
  remoteOperationToolName,
} from "../../../../remote/schema";
import type { RemoteControlRequest } from "../../../../remote/types";
import type {
  HeadlessPaneDefinition,
  PaneDef,
  PaneTemplateDef,
} from "../../../../types/plugin";
import {
  TOOL_NAME_PATTERN,
  type ClientToolManifest,
  type ClientToolManifestSource,
  type JsonValue,
  type ToolManifestArgument,
  type ToolManifestColumn,
  type ToolManifestOption,
} from "./protocol";

export const HEADLESS_TOOL_TIMEOUT_MS = 30_000;
export const REMOTE_TOOL_TIMEOUT_MS = 10_000;
export const REMOTE_RESOURCE_TOOL_NAME = "app.get_resource";

const TOOL_NAME_REGEX = new RegExp(TOOL_NAME_PATTERN);

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export interface SkippedToolManifest {
  source: ClientToolManifestSource;
  token: string;
  reason: string;
}

export interface ASKGClientManifest {
  tools: ClientToolManifest[];
  manifestHash: string;
  skipped: SkippedToolManifest[];
}

interface ManifestCandidate {
  token: string;
  identity: string;
  manifest: ClientToolManifest;
}

export type RemoteToolBinding =
  | { kind: "operation"; operation: string }
  | { kind: "resource" };

function projectArgument(argument: HeadlessPaneDefinition["argument"]): ToolManifestArgument {
  return { ...argument };
}

function projectOptions(options: HeadlessPaneDefinition["options"]): ToolManifestOption[] {
  return options.map(({
    settingKey: _settingKey,
    pluginState: _pluginState,
    values,
    aliases,
    ...option
  }) => ({
    ...option,
    ...(aliases ? { aliases: [...aliases] } : {}),
    ...(values ? {
      values: values.map((value) => ({
        ...value,
        ...(value.aliases ? { aliases: [...value.aliases] } : {}),
      })),
    } : {}),
  }));
}

function projectColumns(columns: HeadlessPaneDefinition["columns"]): ToolManifestColumn[] | undefined {
  if (!columns) return undefined;
  return columns.map(({ format: _format, ...column }) => ({ ...column }));
}

function headlessManifest(
  token: string,
  title: string,
  description: string,
  definition: HeadlessPaneDefinition,
): ClientToolManifest {
  const columns = projectColumns(definition.columns);
  return {
    name: token.toLowerCase(),
    source: "headless",
    title,
    description,
    writeTier: "read",
    shape: definition.shape,
    argument: projectArgument(definition.argument),
    options: projectOptions(definition.options),
    ...(columns ? { columns } : {}),
    confirm: "never",
    timeoutMs: HEADLESS_TOOL_TIMEOUT_MS,
  };
}

function definitionFor(template: PaneTemplateDef, pane: PaneDef): HeadlessPaneDefinition | undefined {
  return template.headless ?? pane.headless;
}

function headlessCandidates(registry: PaneFunctionCatalog): ManifestCandidate[] {
  const candidates: ManifestCandidate[] = [];
  const templatedPaneIds = new Set<string>();

  const templates = [...registry.paneTemplates.values()]
    .sort((left, right) => compareText(left.id, right.id));
  for (const template of templates) {
    const pane = registry.panes.get(template.paneId);
    if (!pane) continue;
    templatedPaneIds.add(pane.id);
    const definition = definitionFor(template, pane);
    if (!definition) continue;
    const token = template.shortcut?.prefix ?? template.id;
    candidates.push({
      token,
      identity: `template:${template.id}`,
      manifest: headlessManifest(token, template.label, template.description, definition),
    });
  }

  const panes = [...registry.panes.values()]
    .sort((left, right) => compareText(left.id, right.id));
  for (const pane of panes) {
    if (templatedPaneIds.has(pane.id) || !pane.headless) continue;
    candidates.push({
      token: pane.id,
      identity: `pane:${pane.id}`,
      manifest: headlessManifest(
        pane.id,
        pane.name,
        `Read data from the ${pane.name} pane.`,
        pane.headless,
      ),
    });
  }

  return candidates;
}

function remoteCandidates(): ManifestCandidate[] {
  const descriptors = remoteOperationDescriptors();
  const operationsByName = new Map(
    REMOTE_OPERATIONS.map((operation) => [remoteOperationToolName(operation.id), operation]),
  );
  const candidates = descriptors.map((descriptor): ManifestCandidate => ({
    token: descriptor.name,
    identity: `operation:${operationsByName.get(descriptor.name)?.id ?? descriptor.name}`,
    manifest: {
      name: descriptor.name,
      source: "remote-op",
      title: descriptor.title,
      description: descriptor.description,
      writeTier: descriptor.writeTier,
      inputSchema: descriptor.inputSchema,
      confirm: descriptor.writeTier === "user-data" || descriptor.writeTier === "broker"
        ? "always"
        : "never",
      timeoutMs: REMOTE_TOOL_TIMEOUT_MS,
    },
  }));

  candidates.push({
    token: REMOTE_RESOURCE_TOOL_NAME,
    identity: "resource:get",
    manifest: {
      name: REMOTE_RESOURCE_TOOL_NAME,
      source: "remote-op",
      title: "App: Get resource",
      description: `Read a registered in-process app resource. Available resources: ${REMOTE_RESOURCES.map(({ uri }) => uri).join(", ")}.`,
      writeTier: "read",
      inputSchema: {
        type: "object",
        properties: {
          resource: {
            type: "string",
            minLength: 1,
            description: "Registered resource URI, such as app://snapshot or app://pane-state/{paneId}.",
          },
        },
        required: ["resource"],
        additionalProperties: false,
      },
      confirm: "never",
      timeoutMs: REMOTE_TOOL_TIMEOUT_MS,
    },
  });

  return candidates;
}

function compareManifests(left: ClientToolManifest, right: ClientToolManifest): number {
  return compareText(left.name, right.name) || compareText(left.source, right.source);
}

function filterCandidates(candidates: ManifestCandidate[]): {
  tools: ClientToolManifest[];
  skipped: SkippedToolManifest[];
} {
  const skipped: SkippedToolManifest[] = [];
  const valid: ManifestCandidate[] = [];

  for (const candidate of candidates.sort((left, right) => (
    compareText(left.manifest.name, right.manifest.name)
    || compareText(left.identity, right.identity)
  ))) {
    if (!TOOL_NAME_REGEX.test(candidate.manifest.name)) {
      skipped.push({
        source: candidate.manifest.source,
        token: candidate.token,
        reason: `Lowercased token "${candidate.manifest.name}" does not match ${TOOL_NAME_PATTERN}.`,
      });
      continue;
    }
    valid.push(candidate);
  }

  const counts = new Map<string, number>();
  for (const candidate of valid) {
    counts.set(candidate.manifest.name, (counts.get(candidate.manifest.name) ?? 0) + 1);
  }

  const tools: ClientToolManifest[] = [];
  for (const candidate of valid) {
    if ((counts.get(candidate.manifest.name) ?? 0) > 1) {
      skipped.push({
        source: candidate.manifest.source,
        token: candidate.token,
        reason: `Duplicate tool name "${candidate.manifest.name}" from ${candidate.identity}.`,
      });
      continue;
    }
    tools.push(candidate.manifest);
  }

  return {
    tools: tools.sort(compareManifests),
    skipped: skipped.sort((left, right) => (
      compareText(left.token, right.token) || compareText(left.source, right.source)
    )),
  };
}

export function buildASKGToolManifests(registry: PaneFunctionCatalog): {
  tools: ClientToolManifest[];
  skipped: SkippedToolManifest[];
} {
  return filterCandidates([
    ...headlessCandidates(registry),
    ...remoteCandidates(),
  ]);
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function hashASKGToolManifests(tools: readonly ClientToolManifest[]): Promise<string> {
  const sorted = [...tools].sort(compareManifests);
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableStringify(sorted)),
  );
  return `sha256:${bytesToHex(new Uint8Array(digest))}`;
}

export async function buildASKGClientManifest(
  registry: PaneFunctionCatalog,
): Promise<ASKGClientManifest> {
  const { tools, skipped } = buildASKGToolManifests(registry);
  return {
    tools,
    manifestHash: await hashASKGToolManifests(tools),
    skipped,
  };
}

export function resolveRemoteToolBinding(name: string): RemoteToolBinding | null {
  if (name === REMOTE_RESOURCE_TOOL_NAME) return { kind: "resource" };
  const operation = REMOTE_OPERATIONS.find((entry) => remoteOperationToolName(entry.id) === name);
  return operation ? { kind: "operation", operation: operation.id } : null;
}

function resourcePatternMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replace(/\\\{[^}]+\\\}/g, "[^/]+")}$`);
  return regex.test(value);
}

export function remoteRequestForTool(
  binding: RemoteToolBinding,
  args: Record<string, JsonValue>,
): RemoteControlRequest {
  if (binding.kind === "operation") {
    return { type: "call", operation: binding.operation, input: args };
  }
  const resource = args.resource;
  if (typeof resource !== "string" || resource.length === 0) {
    throw new Error(`${REMOTE_RESOURCE_TOOL_NAME} requires a resource URI.`);
  }
  if (!REMOTE_RESOURCES.some(({ uri }) => resourcePatternMatches(uri, resource))) {
    throw new Error(`Unknown remote resource "${resource}".`);
  }
  return { type: "get", resource };
}

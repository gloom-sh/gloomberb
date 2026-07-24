import type {
  DetachedPlacementMemory,
  FloatingPlacementMemory,
  LayoutConfig,
  PaneBinding,
  PaneInstanceConfig,
  PanePlacementMemory,
} from "../../types/config";
import {
  cloneLayout,
  clonePaneSettings,
  createPaneInstanceId,
  normalizePaneLayout,
  normalizePaneId,
} from "../../types/config";

export function isLayoutConfig(value: unknown): value is LayoutConfig {
  return !!value
    && typeof value === "object"
    && Array.isArray((value as LayoutConfig).instances)
    && Array.isArray((value as LayoutConfig).floating)
    && "dockRoot" in (value as Record<string, unknown>);
}

function sanitizePaneBinding(value: unknown, fallback: PaneBinding = { kind: "none" }): PaneBinding {
  if (!value || typeof value !== "object") return fallback;
  if ((value as PaneBinding).kind === "fixed" && typeof (value as Extract<PaneBinding, { kind: "fixed" }>).symbol === "string") {
    return { kind: "fixed", symbol: (value as Extract<PaneBinding, { kind: "fixed" }>).symbol };
  }
  if ((value as PaneBinding).kind === "follow" && typeof (value as Extract<PaneBinding, { kind: "follow" }>).sourceInstanceId === "string") {
    return { kind: "follow", sourceInstanceId: (value as Extract<PaneBinding, { kind: "follow" }>).sourceInstanceId };
  }
  if ((value as PaneBinding).kind === "none") return { kind: "none" };
  return fallback;
}

function sanitizeFloatingPlacementMemory(value: unknown): FloatingPlacementMemory | undefined {
  if (!value || typeof value !== "object") return undefined;
  const x = typeof (value as FloatingPlacementMemory).x === "number" ? Math.max(0, Math.round((value as FloatingPlacementMemory).x)) : null;
  const y = typeof (value as FloatingPlacementMemory).y === "number" ? Math.max(0, Math.round((value as FloatingPlacementMemory).y)) : null;
  const width = typeof (value as FloatingPlacementMemory).width === "number" ? Math.max(1, Math.round((value as FloatingPlacementMemory).width)) : null;
  const height = typeof (value as FloatingPlacementMemory).height === "number" ? Math.max(1, Math.round((value as FloatingPlacementMemory).height)) : null;
  if (x === null || y === null || width === null || height === null) return undefined;
  return {
    x,
    y,
    width,
    height,
    fixedGeometry: (value as FloatingPlacementMemory).fixedGeometry === true ? true : undefined,
  };
}

function sanitizeDetachedPlacementMemory(value: unknown): DetachedPlacementMemory | undefined {
  if (!value || typeof value !== "object") return undefined;
  const x = typeof (value as DetachedPlacementMemory).x === "number" ? Math.max(0, Math.round((value as DetachedPlacementMemory).x)) : null;
  const y = typeof (value as DetachedPlacementMemory).y === "number" ? Math.max(0, Math.round((value as DetachedPlacementMemory).y)) : null;
  const width = typeof (value as DetachedPlacementMemory).width === "number" ? Math.max(1, Math.round((value as DetachedPlacementMemory).width)) : null;
  const height = typeof (value as DetachedPlacementMemory).height === "number" ? Math.max(1, Math.round((value as DetachedPlacementMemory).height)) : null;
  if (x === null || y === null || width === null || height === null) return undefined;
  return { x, y, width, height };
}

function sanitizePlacementMemory(value: unknown): PanePlacementMemory | undefined {
  if (!value || typeof value !== "object") return undefined;

  const docked = (() => {
    const raw = (value as PanePlacementMemory).docked;
    if (!raw || typeof raw !== "object") return undefined;
    const rawPath = (raw as { path?: unknown }).path;
    const path = Array.isArray(rawPath)
      ? rawPath.filter((segment): segment is 0 | 1 => segment === 0 || segment === 1)
      : undefined;
    const anchorInstanceId = typeof (raw as { anchorInstanceId?: unknown }).anchorInstanceId === "string"
      ? (raw as { anchorInstanceId: string }).anchorInstanceId
      : undefined;
    const position = ["left", "right", "above", "below"].includes(String((raw as { position?: unknown }).position))
      ? (raw as { position: "left" | "right" | "above" | "below" }).position
      : undefined;
    if (!path && !anchorInstanceId && !position) return undefined;
    return {
      path,
      anchorInstanceId,
      position,
    };
  })();

  const floating = sanitizeFloatingPlacementMemory((value as PanePlacementMemory).floating);
  const detached = sanitizeDetachedPlacementMemory((value as PanePlacementMemory).detached);
  if (!docked && !floating && !detached) return undefined;
  return { docked, floating, detached };
}

function sanitizePaneSettings(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const sanitizeValue = (entry: unknown): unknown => {
    if (entry == null) return entry;
    if (typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean") {
      return entry;
    }
    if (Array.isArray(entry)) {
      return entry
        .map((child) => sanitizeValue(child))
        .filter((child) => child !== undefined);
    }
    if (typeof entry === "object") {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .map(([key, child]) => [key, sanitizeValue(child)])
          .filter(([, child]) => child !== undefined),
      );
    }
    return undefined;
  };

  const settings = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .map(([key, entry]) => [key, sanitizeValue(entry)])
      .filter(([, entry]) => entry !== undefined),
  );

  return Object.keys(settings).length > 0 ? clonePaneSettings(settings) : undefined;
}

function sanitizePaneInstances(value: unknown, fallback: LayoutConfig): PaneInstanceConfig[] {
  if (!Array.isArray(value)) return cloneLayout(fallback).instances;
  const seen = new Set<string>();
  const instances = value
    .filter((entry): entry is PaneInstanceConfig =>
      !!entry
      && typeof entry === "object"
      && typeof (entry as PaneInstanceConfig).instanceId === "string"
      && typeof (entry as PaneInstanceConfig).paneId === "string",
    )
    .map((entry) => {
      const paneId = normalizePaneId(entry.paneId);
      const instanceId = seen.has(entry.instanceId) ? createPaneInstanceId(paneId) : entry.instanceId;
      seen.add(instanceId);
      return {
        instanceId,
        paneId,
        title: typeof entry.title === "string" ? entry.title : undefined,
        binding: sanitizePaneBinding(entry.binding),
        params: entry.params && typeof entry.params === "object"
          ? Object.fromEntries(
            Object.entries(entry.params).filter((param): param is [string, string] => typeof param[1] === "string"),
          )
          : undefined,
        settings: sanitizePaneSettings(entry.settings),
        placementMemory: sanitizePlacementMemory(entry.placementMemory),
      };
    });
  return instances.length > 0 ? instances : cloneLayout(fallback).instances;
}

function getDefaultFollowSourceInstanceId(instances: PaneInstanceConfig[]): string | null {
  return instances.find((instance) => instance.paneId === "portfolio-list")?.instanceId ?? null;
}

function sanitizeFloatingEntries(value: unknown, validInstanceIds: Set<string>): LayoutConfig["floating"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is LayoutConfig["floating"][number] =>
      !!entry
      && typeof entry === "object"
      && typeof (entry as LayoutConfig["floating"][number]).instanceId === "string"
      && typeof (entry as LayoutConfig["floating"][number]).x === "number"
      && typeof (entry as LayoutConfig["floating"][number]).y === "number"
      && typeof (entry as LayoutConfig["floating"][number]).width === "number"
      && typeof (entry as LayoutConfig["floating"][number]).height === "number",
    )
    .filter((entry) => validInstanceIds.has(entry.instanceId))
    .map((entry) => ({
      ...entry,
      x: Math.max(0, Math.round(entry.x)),
      y: Math.max(0, Math.round(entry.y)),
      width: Math.max(1, Math.round(entry.width)),
      height: Math.max(1, Math.round(entry.height)),
      zIndex: typeof entry.zIndex === "number" ? Math.round(entry.zIndex) : entry.zIndex,
      fixedGeometry: entry.fixedGeometry === true ? true : undefined,
    }));
}

function sanitizeDetachedEntries(value: unknown, validInstanceIds: Set<string>): LayoutConfig["detached"] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is LayoutConfig["detached"][number] =>
      !!entry
      && typeof entry === "object"
      && typeof (entry as LayoutConfig["detached"][number]).instanceId === "string"
      && typeof (entry as LayoutConfig["detached"][number]).x === "number"
      && typeof (entry as LayoutConfig["detached"][number]).y === "number"
      && typeof (entry as LayoutConfig["detached"][number]).width === "number"
      && typeof (entry as LayoutConfig["detached"][number]).height === "number",
    )
    .filter((entry) => validInstanceIds.has(entry.instanceId))
    .map((entry) => ({
      instanceId: entry.instanceId,
      x: Math.max(0, Math.round(entry.x)),
      y: Math.max(0, Math.round(entry.y)),
      width: Math.max(1, Math.round(entry.width)),
      height: Math.max(1, Math.round(entry.height)),
    }));
}

export function sanitizeLayout(value: unknown, fallback: LayoutConfig): LayoutConfig {
  if (!isLayoutConfig(value)) {
    return cloneLayout(fallback);
  }

  if (!Array.isArray((value as LayoutConfig & { instances?: unknown }).instances)) {
    const layout = cloneLayout(fallback);
    return normalizePaneLayout(layout, {
      defaultFollowSourceInstanceId: getDefaultFollowSourceInstanceId(layout.instances),
    });
  }

  const instances = sanitizePaneInstances((value as LayoutConfig & { instances?: unknown }).instances, fallback);
  const validInstanceIds = new Set(instances.map((entry) => entry.instanceId));
  const dockRoot = (value as { dockRoot?: LayoutConfig["dockRoot"] }).dockRoot ?? null;
  const floating = sanitizeFloatingEntries((value as { floating?: unknown }).floating, validInstanceIds);
  const detached = sanitizeDetachedEntries((value as { detached?: unknown }).detached, validInstanceIds);

  const layout: LayoutConfig = {
    dockRoot,
    instances,
    floating,
    detached,
  };

  return normalizePaneLayout(layout, {
    defaultFollowSourceInstanceId: getDefaultFollowSourceInstanceId(layout.instances),
  });
}

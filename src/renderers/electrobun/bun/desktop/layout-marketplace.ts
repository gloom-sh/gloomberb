import { appReducer, createInitialState } from "../../../../core/state/app/state";
import { publishableMarketplaceLayout } from "../../../../layout-marketplace/payload";
import type {
  DesktopLayoutMarketplaceAction,
  DesktopSharedStateSnapshot,
} from "../../../../types/desktop-window";

const MAX_LAYOUT_NAME_LENGTH = 80;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function index(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
}

function name(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized && normalized.length <= MAX_LAYOUT_NAME_LENGTH ? normalized : null;
}

export function parseDesktopLayoutMarketplaceAction(value: unknown): DesktopLayoutMarketplaceAction | null {
  if (!record(value) || typeof value.type !== "string") return null;

  switch (value.type) {
    case "SWITCH_LAYOUT":
    case "DELETE_LAYOUT":
    case "DUPLICATE_LAYOUT": {
      const parsedIndex = index(value.index);
      return parsedIndex === null ? null : { type: value.type, index: parsedIndex };
    }
    case "NEW_LAYOUT": {
      const parsedName = name(value.name);
      return parsedName ? { type: value.type, name: parsedName } : null;
    }
    case "RENAME_LAYOUT": {
      const parsedIndex = index(value.index);
      const parsedName = name(value.name);
      return parsedIndex === null || !parsedName
        ? null
        : { type: value.type, index: parsedIndex, name: parsedName };
    }
    case "INSTALL_LAYOUT_COPY": {
      const parsedName = name(value.name);
      if (!parsedName) return null;
      try {
        return {
          type: value.type,
          name: parsedName,
          layout: publishableMarketplaceLayout(value.layout as never).layout,
        };
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

export function applyDesktopLayoutMarketplaceAction(
  snapshot: DesktopSharedStateSnapshot,
  action: DesktopLayoutMarketplaceAction,
): DesktopSharedStateSnapshot {
  const hydrated = appReducer(createInitialState(snapshot.config), {
    type: "HYDRATE_DESKTOP_SNAPSHOT",
    snapshot,
  });
  const next = appReducer(hydrated, action);
  return {
    ...snapshot,
    config: next.config,
    paneState: next.paneState,
    focusedPaneId: next.focusedPaneId,
    activePanel: next.activePanel,
    layoutChanged: true,
  };
}

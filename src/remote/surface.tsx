import { createContext, useContext, useRef, type ReactNode } from "react";
import { isDialogOpen } from "../ui/dialog-stack";
import {
  RemoteUiRegistryProvider,
  remoteUiNodeSnapshot,
  useRemoteUiNode,
  useRemoteUiRegistry,
  type RemoteUiNodeRegistration,
  type RemoteUiRegistry,
} from "./semantic-tree";
import type { RemoteUiNodeSnapshot } from "./types";

/** What the surface's own title and header say about it, set by the components that draw them. */
interface SurfaceDetails {
  step?: string;
  section?: string;
  title?: string;
  description?: string;
  /** Closes or skips the whole surface, when it offers that. */
  cancel?: () => void;
}

const RemoteSurfaceContext = createContext<{ current: SurfaceDetails } | null>(null);

/** Roles of the controls a person fills in: listed as the surface's fields. */
const FIELD_ROLES = new Set(["form-field", "text-field", "textarea", "select", "checkbox", "list"]);
/** The kit's own editors, left out when the surface names its fields as form-field nodes. */
const EDITOR_ROLES = new Set(["text-field", "textarea"]);
/** The button Enter presses on the surface is the one it sends with. */
const SUBMIT_SHORTCUT = "Enter";

/**
 * Registers its subtree's nodes in the app's registry, and keeps them, so the
 * surface can list its own controls. Every node drawn inside is the open
 * form's (`metadata.scope` "form"), so `ui.invokeMatching` tries them first,
 * as it does a form modal's.
 */
function surfaceRegistry(parent: RemoteUiRegistry, own: Map<string, RemoteUiNodeRegistration>): RemoteUiRegistry {
  return {
    register(id, registration) {
      own.set(id, registration);
      parent.register(id, inForm(registration));
    },
    unregister(id) {
      own.delete(id);
      parent.unregister(id);
    },
    snapshot: () => parent.snapshot(),
    detail: (nodeId) => parent.detail(nodeId),
    invoke: (nodeId, action, input) => parent.invoke(nodeId, action, input),
  };
}

function inForm(registration: RemoteUiNodeRegistration): RemoteUiNodeRegistration {
  return {
    get role() { return registration.role; },
    get paneId() { return registration.paneId; },
    get label() { return registration.label; },
    get disabled() { return registration.disabled; },
    get actions() { return registration.actions; },
    getMetadata: () => {
      const metadata = registration.getMetadata?.() ?? registration.metadata ?? {};
      return { ...metadata, scope: metadata.scope ?? "form" };
    },
    get getDetail() { return registration.getDetail; },
  };
}

function isPassword(metadata: Record<string, unknown>): boolean {
  return metadata.type === "password" || metadata.inputType === "password" || metadata.fieldType === "password";
}

const FIELD_KEYS = ["placeholder", "active", "focused", "required", "error", "options", "items", "selectedIndex", "checked"] as const;

/** A field as the surface lists it; a password says whether it is filled, never what. */
function surfaceField(node: RemoteUiNodeSnapshot) {
  const metadata = node.metadata ?? {};
  const value = metadata.value;
  const kept = Object.fromEntries(FIELD_KEYS.filter((key) => metadata[key] != null).map((key) => [key, metadata[key]]));
  return {
    nodeId: node.id,
    ...(typeof metadata.fieldId === "string" ? { id: metadata.fieldId } : {}),
    role: node.role,
    label: node.label ?? null,
    ...(isPassword(metadata)
      ? { type: "password", filled: typeof value === "string" && value.length > 0 }
      : node.role === "list" || node.role === "checkbox" ? {} : { value: value ?? null }),
    ...kept,
    ...(node.disabled ? { disabled: true } : {}),
    actions: node.actions,
  };
}

function surfaceButton(node: RemoteUiNodeSnapshot) {
  const shortcut = node.metadata?.shortcut;
  return {
    nodeId: node.id,
    label: node.label ?? null,
    ...(node.disabled ? { disabled: true } : {}),
    ...(typeof shortcut === "string" && shortcut ? { shortcut } : {}),
  };
}

/** The controls drawn inside the surface, in the order they registered. */
function surfaceControls(own: Map<string, RemoteUiNodeRegistration>) {
  const nodes = [...own].map(([id, registration]) => remoteUiNodeSnapshot(id, registration));
  // A step that names its fields as form-field nodes drives its editors through them.
  const named = nodes.some((node) => node.role === "form-field");
  const fields = nodes.filter((node) => FIELD_ROLES.has(node.role) && !(named && EDITOR_ROLES.has(node.role)));
  const buttons = nodes.filter((node) => node.role === "button" && node.label);
  const submit = buttons.find((node) => node.metadata?.shortcut === SUBMIT_SHORTCUT);
  return { fields, buttons, submit };
}

/**
 * A full-window card that is not a dialog of the dialog stack, such as the
 * first-run setup: remote control reads it as the open form (`app://form`),
 * with its title, the fields and buttons drawn in it, `submit` for the button
 * Enter presses and `cancel` when it can be skipped. `covered` while a dialog
 * sits over it.
 */
export function RemoteSurface({ kind, children }: { kind: string; children: ReactNode }) {
  const parent = useRemoteUiRegistry();
  const detailsRef = useRef<SurfaceDetails>({});
  const ownRef = useRef<Map<string, RemoteUiNodeRegistration>>(new Map());
  const registryRef = useRef<RemoteUiRegistry | null>(null);
  if (parent && !registryRef.current) registryRef.current = surfaceRegistry(parent, ownRef.current);

  const press = async (node: RemoteUiNodeSnapshot | undefined) => {
    if (!node) throw new Error("This step has no button that sends it; press one of its buttons instead.");
    if (node.disabled) throw new Error(`"${node.label}" is disabled.`);
    await ownRef.current.get(node.id)?.actions?.press?.();
  };

  useRemoteUiNode({
    role: "form",
    get label() { return detailsRef.current.title; },
    get actions() {
      const cancel = detailsRef.current.cancel;
      const { submit } = surfaceControls(ownRef.current);
      return {
        cancel: cancel ? () => cancel() : undefined,
        submit: submit ? () => press(surfaceControls(ownRef.current).submit) : undefined,
      };
    },
    getMetadata: () => {
      const details = detailsRef.current;
      const { fields, buttons, submit } = surfaceControls(ownRef.current);
      return {
        scope: "form",
        kind,
        step: details.step ?? details.section ?? null,
        title: details.title ?? null,
        ...(details.description ? { description: details.description } : {}),
        fields: fields.map(surfaceField),
        buttons: buttons.map(surfaceButton),
        submitLabel: submit?.label ?? null,
        covered: isDialogOpen(),
      };
    },
  } satisfies RemoteUiNodeRegistration);

  const content = <RemoteSurfaceContext value={detailsRef}>{children}</RemoteSurfaceContext>;
  return registryRef.current
    ? <RemoteUiRegistryProvider registry={registryRef.current}>{content}</RemoteUiRegistryProvider>
    : content;
}

/** Names the surface this is drawn in: its step, title and description. */
export function useRemoteSurfaceHeading(heading: Pick<SurfaceDetails, "step" | "title" | "description">): void {
  const surface = useContext(RemoteSurfaceContext);
  if (!surface) return;
  surface.current.step = heading.step;
  surface.current.title = heading.title;
  surface.current.description = heading.description;
}

/** The surface's section (shown as its step when the title names none) and how it is skipped, if it can be. */
export function useRemoteSurfaceHeader(header: Pick<SurfaceDetails, "section" | "cancel">): void {
  const surface = useContext(RemoteSurfaceContext);
  if (!surface) return;
  surface.current.section = header.section;
  surface.current.cancel = header.cancel;
}

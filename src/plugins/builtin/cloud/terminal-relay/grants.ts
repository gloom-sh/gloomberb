import type { PluginPersistence } from "../../../../types/plugin";

/**
 * Which remote assistants may control this terminal. Asked once per
 * assistant (a Gloom Cloud key or a signed-in client): "Always allow" and
 * "Deny" are kept with the profile, "Allow for this session" lasts until the
 * app quits. Revoking in Account Management, revoking the key or
 * disconnecting the client in Cloud settings forgets the decision.
 */
export type AssistantDecision = "always" | "session" | "deny";

export interface AssistantGrant {
  clientId: string;
  name: string;
  decision: AssistantDecision;
  decidedAt: number;
  lastUsedAt: number | null;
}

const GRANTS_STATE_KEY = "terminal-relay:grants";
const DEVICE_STATE_KEY = "terminal-relay:device";
const MAX_GRANTS = 50;

function isGrant(value: unknown): value is AssistantGrant {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.clientId === "string"
    && typeof record.name === "string"
    && (record.decision === "always" || record.decision === "deny")
    && typeof record.decidedAt === "number";
}

function randomDeviceId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class TerminalRelayGrants {
  private persistence: PluginPersistence | null = null;
  private stored = new Map<string, AssistantGrant>();
  private readonly session = new Map<string, AssistantGrant>();
  private readonly listeners = new Set<() => void>();
  private listed: AssistantGrant[] = [];

  attach(persistence: PluginPersistence): void {
    this.persistence = persistence;
    const raw = persistence.getState<unknown>(GRANTS_STATE_KEY);
    this.stored = new Map(
      (Array.isArray(raw) ? raw : [])
        .filter(isGrant)
        .map((grant) => [grant.clientId, { ...grant, lastUsedAt: grant.lastUsedAt ?? null }]),
    );
    this.emit();
  }

  detach(): void {
    this.persistence = null;
    this.stored.clear();
    this.session.clear();
    this.emit();
  }

  get attached(): boolean {
    return this.persistence !== null;
  }

  /** A random id for this profile, created once; nothing about the machine is in it. */
  deviceId(): string | null {
    if (!this.persistence) return null;
    const stored = this.persistence.getState<{ id?: unknown }>(DEVICE_STATE_KEY);
    if (stored && typeof stored.id === "string" && /^[a-f0-9]{32}$/.test(stored.id)) return stored.id;
    const id = randomDeviceId();
    this.persistence.setState(DEVICE_STATE_KEY, { id });
    return id;
  }

  decision(clientId: string): AssistantDecision | null {
    return this.session.get(clientId)?.decision ?? this.stored.get(clientId)?.decision ?? null;
  }

  decide(clientId: string, name: string, decision: AssistantDecision, now = Date.now()): void {
    const grant: AssistantGrant = { clientId, name, decision, decidedAt: now, lastUsedAt: null };
    if (decision === "session") {
      this.session.set(clientId, grant);
      this.stored.delete(clientId);
    } else {
      this.session.delete(clientId);
      this.stored.set(clientId, grant);
    }
    this.persist();
  }

  markUsed(clientId: string, now = Date.now()): void {
    const grant = this.session.get(clientId) ?? this.stored.get(clientId);
    if (!grant) return;
    grant.lastUsedAt = now;
    this.emit();
  }

  /** Forgets an assistant, so its next call asks again. */
  forget(clientId: string): void {
    const had = this.session.delete(clientId) || this.stored.has(clientId);
    this.stored.delete(clientId);
    if (had) this.persist();
  }

  /** The same array until something changes, so React can subscribe to it. */
  list(): AssistantGrant[] {
    return this.listed;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private persist(): void {
    const kept = [...this.stored.values()]
      .sort((left, right) => right.decidedAt - left.decidedAt)
      .slice(0, MAX_GRANTS);
    this.stored = new Map(kept.map((grant) => [grant.clientId, grant]));
    this.persistence?.setState(GRANTS_STATE_KEY, kept);
    this.emit();
  }

  private emit(): void {
    this.listed = [...this.session.values(), ...this.stored.values()]
      .map((grant) => ({ ...grant }))
      .sort((left, right) => (right.lastUsedAt ?? right.decidedAt) - (left.lastUsedAt ?? left.decidedAt));
    for (const listener of this.listeners) listener();
  }
}

export const terminalRelayGrants = new TerminalRelayGrants();

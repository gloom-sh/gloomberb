import type { CloudApiRequest } from "./request";

/**
 * The public roadmap: what is being built, what is planned and what shipped,
 * with the votes Pro members put on the first two. Anyone reads it; a signed-in
 * Pro member votes once per item and can take the vote back.
 */
export const ROADMAP_STATUSES = ["building", "planned", "shipped"] as const;
export type RoadmapStatus = (typeof ROADMAP_STATUSES)[number];

export interface RoadmapItem {
  id: string;
  title: string;
  /** One line on what it is. */
  blurb: string;
  status: RoadmapStatus;
  /** ISO time it shipped; null until then. */
  shippedAt: string | null;
  votes: number;
  /** Whether this account voted for it; false signed out. */
  voted: boolean;
}

export interface RoadmapPayload {
  items: RoadmapItem[];
  /** The service's word on whether this session may vote (a verified Pro account). */
  canVote: boolean;
}

export interface RoadmapVote {
  id: string;
  votes: number;
  voted: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseItem(value: unknown): RoadmapItem | null {
  if (!isRecord(value)) return null;
  const { id, title, blurb, status, shippedAt, votes, voted } = value;
  if (typeof id !== "string" || !id || typeof title !== "string" || !title.trim()) return null;
  if (!(ROADMAP_STATUSES as readonly unknown[]).includes(status)) return null;
  return {
    id,
    title: title.trim(),
    blurb: typeof blurb === "string" ? blurb.trim() : "",
    status: status as RoadmapStatus,
    shippedAt: typeof shippedAt === "string" && Number.isFinite(Date.parse(shippedAt)) ? shippedAt : null,
    votes: typeof votes === "number" && Number.isFinite(votes) ? Math.max(0, Math.round(votes)) : 0,
    voted: voted === true,
  };
}

/** Items it cannot read (an unknown status from a newer service) are left out, not the whole list. */
export function parseRoadmapPayload(value: unknown): RoadmapPayload {
  if (!isRecord(value) || !Array.isArray(value.items)) throw new Error("The roadmap service returned invalid data.");
  return {
    items: value.items.map(parseItem).filter((item): item is RoadmapItem => item !== null),
    canVote: value.canVote === true,
  };
}

function parseVote(value: unknown): RoadmapVote {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.votes !== "number" || typeof value.voted !== "boolean") {
    throw new Error("The roadmap service returned invalid data.");
  }
  return { id: value.id, votes: value.votes, voted: value.voted };
}

export class CloudRoadmapApi {
  constructor(private readonly request: CloudApiRequest) {}

  async getRoadmap(signal?: AbortSignal): Promise<RoadmapPayload> {
    return parseRoadmapPayload(await this.request<unknown>("/roadmap", { signal }));
  }

  /** Votes, or takes the vote back; the answer is the item's count after it. */
  async setRoadmapVote(id: string, voted: boolean): Promise<RoadmapVote> {
    return parseVote(await this.request<unknown>(`/roadmap/${encodeURIComponent(id)}/vote`, {
      method: voted ? "POST" : "DELETE",
    }));
  }
}

import type { RoadmapItem, RoadmapPayload, RoadmapStatus, RoadmapVote } from "../../../api-client/roadmap";
import type { TableSection } from "../../../components";

export const ROADMAP_STATUS_LABELS: Record<RoadmapStatus, string> = {
  building: "Building",
  planned: "Planned",
  shipped: "Shipped",
};

const SECTION_ORDER: readonly RoadmapStatus[] = ["building", "planned", "shipped"];

/** Building, then Planned, then Shipped, each in the order the service sent; an empty group is left out. */
export function roadmapSections(items: readonly RoadmapItem[]): TableSection<RoadmapItem>[] {
  return SECTION_ORDER.map((status) => ({
    label: ROADMAP_STATUS_LABELS[status],
    key: status,
    items: items.filter((item) => item.status === status),
  }));
}

/** Votes are taken on what is not shipped yet; a shipped item's count is final. */
export function isVotable(item: RoadmapItem): boolean {
  return item.status !== "shipped";
}

/**
 * The items with this session's own votes on top: the count and mark a vote
 * changed, held until the next read of the list replaces them.
 */
export function withLocalVotes(
  payload: RoadmapPayload | null,
  local: Readonly<Record<string, RoadmapVote>>,
): RoadmapItem[] {
  if (!payload) return [];
  return payload.items.map((item) => {
    const vote = local[item.id];
    return vote ? { ...item, votes: vote.votes, voted: vote.voted } : item;
  });
}

/** What the row shows while a vote is on its way: the mark flipped and the count moved by one. */
export function optimisticVote(item: RoadmapItem, voted: boolean): RoadmapVote {
  const step = voted === item.voted ? 0 : voted ? 1 : -1;
  return { id: item.id, votes: Math.max(0, item.votes + step), voted };
}

/** The votes cell: the count, with a check before it when this account voted. */
export function votesText(item: RoadmapItem): string {
  return item.voted ? `✓ ${item.votes}` : String(item.votes);
}

/** What one vote that failed is called on its row, and the reason the detail gives. */
export interface VoteFailure {
  status: string;
  reason: string;
}

export function voteFailure(error: unknown, voted: boolean): VoteFailure {
  const status = typeof error === "object" && error && "status" in error ? (error as { status?: unknown }).status : undefined;
  const action = voted ? "The vote" : "Taking the vote back";
  if (status === 401) return { status: "sign in", reason: `${action} did not go through: sign in again to vote.` };
  if (status === 402 || status === 403) return { status: "Pro only", reason: `${action} did not go through: voting is for verified Pro members.` };
  if (status === 404) return { status: "removed", reason: "This item is no longer on the roadmap." };
  if (status === 409) return { status: "closed", reason: "This item shipped, so its votes are final." };
  const message = error instanceof Error && error.message.trim() ? error.message.trim() : "the request failed";
  return { status: "failed", reason: `${action} did not go through: ${message.replace(/\.$/, "")}.` };
}

import { truncateWithEllipsis } from "../../../utils/text-wrap";
export type { QuickNoteEntry } from "./files";

let nextNoteId = 1;

export function generateNoteId(): string {
  return `${Date.now()}-${nextNoteId++}`;
}

export function formatLastEdited(updatedAt: number | undefined): string {
  if (!updatedAt) return "not edited";
  const elapsedSeconds = Math.max(0, Math.floor((Date.now() - updatedAt) / 1000));
  if (!Number.isFinite(elapsedSeconds)) return "not edited";
  if (elapsedSeconds < 60) return "now";

  const elapsedMinutes = Math.floor(elapsedSeconds / 60);
  if (elapsedMinutes < 60) return `${elapsedMinutes}m ago`;

  const elapsedHours = Math.floor(elapsedMinutes / 60);
  if (elapsedHours < 24) return `${elapsedHours}h ago`;

  const elapsedDays = Math.floor(elapsedHours / 24);
  if (elapsedDays === 1) return "yday";
  if (elapsedDays < 7) return `${elapsedDays}d ago`;

  const elapsedWeeks = Math.floor(elapsedDays / 7);
  if (elapsedWeeks < 5) return `${elapsedWeeks}w ago`;

  const elapsedMonths = Math.floor(elapsedDays / 30);
  if (elapsedMonths < 12) return `${elapsedMonths}mo ago`;

  return `${Math.floor(elapsedDays / 365)}y ago`;
}

export function formatDeleteNoteTitle(title: string): string {
  return truncateWithEllipsis(title, 28);
}

import type { ChatAttachment, ChatAttachmentUpload } from "../../../../api-client";
import type { AppNotificationRequest } from "../../../../types/plugin";
import {
  chatImageProblem,
  chatImageTypeOf,
  describeChatImageError,
  isAbortError,
  MAX_CHAT_IMAGES,
  TOO_MANY_CHAT_IMAGES,
} from "../attachments/model";

/** One image in the composer: on its way up, ready to go with the next message, or failed. */
export interface ChatDraftAttachment {
  localId: string;
  name: string;
  type: string;
  size: number;
  /** What the composer shows: a local copy while uploading, the stored image after. */
  previewUrl: string | null;
  status: "uploading" | "ready" | "failed";
  /** The fraction sent, or null while the transport cannot tell. */
  progress: number | null;
  error: string | null;
  uploaded: ChatAttachment | null;
}

export interface DraftAttachmentEntry extends ChatDraftAttachment {
  source: ChatAttachmentUpload;
  abort: AbortController | null;
}

export type ChatAttachmentUploader = (
  channelId: string,
  upload: ChatAttachmentUpload,
  options: { signal: AbortSignal; onProgress: (fraction: number) => void },
) => Promise<ChatAttachment>;

interface DraftAttachmentDeps {
  channelId: string;
  upload: ChatAttachmentUploader;
  emit: () => void;
  notify: (notification: AppNotificationRequest) => void;
  nextLocalId: () => string;
}

/** Progress redraws in steps, not on every chunk an upload reports. */
const PROGRESS_STEP = 0.05;

export function publicDraftAttachment(entry: DraftAttachmentEntry): ChatDraftAttachment {
  return {
    localId: entry.localId,
    name: entry.name,
    type: entry.type,
    size: entry.size,
    previewUrl: entry.previewUrl,
    status: entry.status,
    progress: entry.progress,
    error: entry.error,
    uploaded: entry.uploaded,
  };
}

function sizeOf(data: ChatAttachmentUpload["data"]): number {
  return data instanceof Uint8Array ? data.byteLength : data.size;
}

/**
 * A local preview for a picked or pasted file, as a data: URL because the web
 * app's content policy allows those for images and not blob: links.
 */
function readPreviewUrl(data: ChatAttachmentUpload["data"]): Promise<string | null> {
  const Reader = (globalThis as {
    FileReader?: new () => {
      result: unknown;
      onload: (() => void) | null;
      onerror: (() => void) | null;
      readAsDataURL(blob: Blob): void;
    };
  }).FileReader;
  if (!Reader || data instanceof Uint8Array) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = new Reader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(data);
  });
}

function startUpload(entries: () => DraftAttachmentEntry[], entry: DraftAttachmentEntry, deps: DraftAttachmentDeps): void {
  entry.abort?.abort();
  const abort = new AbortController();
  entry.abort = abort;
  entry.status = "uploading";
  entry.progress = null;
  entry.error = null;
  const current = () => entry.abort === abort && entries().includes(entry);
  void deps.upload(deps.channelId, entry.source, {
    signal: abort.signal,
    onProgress: (fraction) => {
      if (!current()) return;
      const next = Math.max(0, Math.min(1, fraction));
      if (entry.progress !== null && next < 1 && next - entry.progress < PROGRESS_STEP) return;
      entry.progress = next;
      deps.emit();
    },
  }).then((uploaded) => {
    if (!current()) return;
    entry.abort = null;
    entry.uploaded = uploaded;
    entry.status = "ready";
    entry.progress = 1;
    entry.previewUrl ??= uploaded.url;
    deps.emit();
  }).catch((error: unknown) => {
    if (!current() || isAbortError(error)) return;
    entry.abort = null;
    entry.status = "failed";
    entry.error = describeChatImageError(error);
    deps.emit();
  });
}

/**
 * Adds picked, pasted or dropped images to a channel's draft and starts their
 * uploads. Files the server would refuse are reported and left out, as are any
 * past the four a message can carry.
 */
export function addDraftAttachments(
  getEntries: () => DraftAttachmentEntry[],
  setEntries: (entries: DraftAttachmentEntry[]) => void,
  uploads: ChatAttachmentUpload[],
  deps: DraftAttachmentDeps,
): number {
  const problems: string[] = [];
  const accepted: DraftAttachmentEntry[] = [];
  let overLimit = false;
  for (const upload of uploads) {
    const size = sizeOf(upload.data);
    const problem = chatImageProblem({ name: upload.name, type: upload.type, size });
    if (problem) {
      problems.push(problem);
      continue;
    }
    if (getEntries().length + accepted.length >= MAX_CHAT_IMAGES) {
      overLimit = true;
      continue;
    }
    const type = chatImageTypeOf(upload) ?? upload.type;
    accepted.push({
      localId: deps.nextLocalId(),
      name: upload.name || "image",
      type,
      size,
      previewUrl: null,
      status: "uploading",
      progress: null,
      error: null,
      uploaded: null,
      source: { ...upload, type },
      abort: null,
    });
  }
  if (overLimit) problems.push(TOO_MANY_CHAT_IMAGES);
  if (problems.length > 0) deps.notify({ body: [...new Set(problems)].join(" "), type: "error" });
  if (accepted.length === 0) return 0;

  setEntries([...getEntries(), ...accepted]);
  for (const entry of accepted) {
    startUpload(getEntries, entry, deps);
    void readPreviewUrl(entry.source.data).then((previewUrl) => {
      if (!previewUrl || !getEntries().includes(entry)) return;
      entry.previewUrl = previewUrl;
      deps.emit();
    });
  }
  deps.emit();
  return accepted.length;
}

export function retryDraftAttachment(
  getEntries: () => DraftAttachmentEntry[],
  localId: string,
  deps: DraftAttachmentDeps,
): boolean {
  const entry = getEntries().find((candidate) => candidate.localId === localId);
  if (!entry || entry.status !== "failed") return false;
  startUpload(getEntries, entry, deps);
  deps.emit();
  return true;
}

/** Drops images from the draft, stopping their uploads. An upload nobody sends expires on the server. */
export function discardDraftAttachments(entries: DraftAttachmentEntry[]): void {
  for (const entry of entries) {
    entry.abort?.abort();
    entry.abort = null;
  }
}

/**
 * What the next message carries, once every image is up. `blocked` says why
 * it cannot go yet: an upload still running, or one that failed.
 */
export function readyDraftAttachments(entries: DraftAttachmentEntry[]):
  | { blocked: null; attachments: Array<{ uploaded: ChatAttachment; previewUrl: string | null }> }
  | { blocked: "uploading" | "failed"; attachments: [] } {
  if (entries.some((entry) => entry.status === "failed")) return { blocked: "failed", attachments: [] };
  if (entries.some((entry) => entry.status !== "ready" || !entry.uploaded)) return { blocked: "uploading", attachments: [] };
  return {
    blocked: null,
    attachments: entries.map((entry) => ({ uploaded: entry.uploaded!, previewUrl: entry.previewUrl })),
  };
}

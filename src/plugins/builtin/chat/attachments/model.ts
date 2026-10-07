import { ApiRequestError } from "../../../../api-client/errors";
import type { ChatAttachment, ChatMessage } from "../../../../api-client";

/** What the server takes: four images a message, each up to 5 MB, as PNG, JPEG, WebP or GIF. */
export const MAX_CHAT_IMAGES = 4;
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;
export const CHAT_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export type ChatImageType = (typeof CHAT_IMAGE_TYPES)[number];

const EXTENSION_TYPES: Record<string, ChatImageType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

export const TOO_MANY_CHAT_IMAGES = `A message can carry up to ${MAX_CHAT_IMAGES} images.`;
const UNSUPPORTED_CHAT_IMAGE = "Images must be PNG, JPEG, WebP or GIF.";
const CHAT_IMAGE_TOO_LARGE = "Images can be up to 5 MB.";

function extensionOf(name: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(name.trim());
  return match?.[1]?.toLowerCase() ?? "";
}

/** The image type a picked, pasted or dropped file claims, from its MIME type or else its name. */
export function chatImageTypeOf(file: { name?: string; type?: string }): ChatImageType | null {
  const type = (file.type ?? "").toLowerCase().split(";")[0]!.trim();
  if ((CHAT_IMAGE_TYPES as readonly string[]).includes(type)) return type as ChatImageType;
  if (type === "image/jpg") return "image/jpeg";
  // Some pickers and terminals give no type; the name still says what it is.
  if (type && type !== "application/octet-stream") return null;
  return EXTENSION_TYPES[extensionOf(file.name ?? "")] ?? null;
}

/** The type the first bytes show; the server decides by these too, never by the name. */
export function sniffChatImageType(bytes: Uint8Array): ChatImageType | null {
  const at = (index: number) => bytes[index] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  if (
    at(0) === 0x52 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x46
    && at(8) === 0x57 && at(9) === 0x45 && at(10) === 0x42 && at(11) === 0x50
  ) return "image/webp";
  return null;
}

/** Why a file cannot be sent as it is, or null when it can go to the server. */
export function chatImageProblem(file: { name?: string; type?: string; size: number }): string | null {
  if (!chatImageTypeOf(file)) return UNSUPPORTED_CHAT_IMAGE;
  if (file.size > MAX_CHAT_IMAGE_BYTES) return CHAT_IMAGE_TOO_LARGE;
  if (file.size <= 0) return "This image is empty.";
  return null;
}

/** `179 KB`, `1.2 MB`: how the composer and the terminal rows size an image. */
export function formatChatImageSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 KB";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  const megabytes = bytes / (1024 * 1024);
  return `${megabytes >= 10 ? Math.round(megabytes) : megabytes.toFixed(1)} MB`;
}

/** `image 1280x720 179 KB`, the terminal's stand-in for a picture. */
export function chatImageLabel(attachment: Pick<ChatAttachment, "width" | "height" | "size">): string {
  const dimensions = attachment.width > 0 && attachment.height > 0
    ? ` ${attachment.width}x${attachment.height}`
    : "";
  return `image${dimensions} ${formatChatImageSize(attachment.size)}`;
}

/** `[image]` or `[2 images]`, wherever only text fits. */
function chatImageCountLabel(count: number): string {
  return count > 1 ? `[${count} images]` : "[image]";
}

/** A message read as one line: its images as a placeholder in front of the text. */
export function chatTextWithImages(content: string, imageCount = 0): string {
  if (imageCount <= 0) return content;
  const text = content.trim();
  const placeholder = chatImageCountLabel(imageCount);
  return text ? `${placeholder} ${text}` : placeholder;
}

/** The quoted message of a reply, with `[image]` when it carried images. */
export function chatReplyQuoteText(replyTo: NonNullable<ChatMessage["replyTo"]>): string {
  return chatTextWithImages(replyTo.content, replyTo.attachmentCount ?? 0);
}

/**
 * The thumbnail's box: the image scaled down (never up) to fit, aspect kept.
 * Known before the image loads, so the transcript does not jump.
 */
export function fitChatImage(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: maxWidth, height: Math.round(maxHeight * 0.75) };
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

export type ChatImageReviewNote = { tone: "muted" | "warning"; text: string };

/** What the author sees on their own held public message. */
export function chatImageReviewNote(message: Pick<ChatMessage, "attachmentReview">): ChatImageReviewNote | null {
  if (message.attachmentReview === "pending") return { tone: "muted", text: "Checking image..." };
  if (message.attachmentReview === "failed") return { tone: "warning", text: "Could not be checked, only visible to you" };
  return null;
}

const UPLOAD_ERROR_SENTENCES: Record<string, string> = {
  unsupported_image_type: UNSUPPORTED_CHAT_IMAGE,
  image_too_large: CHAT_IMAGE_TOO_LARGE,
  invalid_image: "The image could not be read.",
  image_dimensions_too_large: "This image is too large to send.",
  upload_rate_limited: "You're uploading images too fast. Slow down.",
  upload_daily_limit: "You've reached today's image limit. Try again tomorrow.",
  image_screening_unavailable: "Images can't be posted in public channels right now. Try again later.",
  image_processing_unavailable: "Images can't be processed right now. Try again later.",
  chat_posting_suspended: "Your posting in public channels is paused for now.",
  attachment_unavailable: "An image is no longer available. Upload it again.",
  too_many_attachments: TOO_MANY_CHAT_IMAGES,
};

export function isAbortError(error: unknown): boolean {
  return !!error && typeof error === "object" && (error as { name?: unknown }).name === "AbortError";
}

/**
 * A failed upload or send as one sentence. The server writes its errors for
 * people, so its text wins; the client's own wording covers an answer that
 * carried only a code, or none.
 */
export function describeChatImageError(error: unknown, fallback = "The image could not be uploaded."): string {
  if (error instanceof ApiRequestError) {
    const code = error.code ?? "";
    let message = error.message.trim();
    if (code && message.endsWith(code)) message = message.slice(0, -code.length).trim();
    if (message && message !== code) return message;
    if (UPLOAD_ERROR_SENTENCES[code]) return UPLOAD_ERROR_SENTENCES[code]!;
    if (error.status === 413) return CHAT_IMAGE_TOO_LARGE;
    if (error.status === 429) return UPLOAD_ERROR_SENTENCES.upload_rate_limited!;
    return fallback;
  }
  if (error instanceof TypeError) return `${fallback.replace(/\.$/, "")}. Check your connection and try again.`;
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return fallback;
}

/** A send refused for its images reads like an upload error; anything else keeps its message. */
export function describeChatSendError(error: unknown): string {
  if (error instanceof ApiRequestError && error.code && UPLOAD_ERROR_SENTENCES[error.code]) {
    return describeChatImageError(error);
  }
  return error instanceof Error && error.message ? error.message : "Failed to send message.";
}

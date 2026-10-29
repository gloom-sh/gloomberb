/** How long a message for you shows in the status bar before it folds into the chip. */
const STATUS_PREVIEW_MS = 9_000;

/** A message for you, as the status bar shows it on arrival. */
export interface ChatStatusPreviewItem {
  channelId: string;
  messageId: string;
  senderName: string;
  /** It came in a DM or group chat; otherwise it mentions or replies to you. */
  direct: boolean;
  /** The message on one line. */
  text: string;
  /** When it was sent, in ms. */
  at: number;
}

/** Whether the status bar has room for the item now. */
type PreviewRoom = (item: ChatStatusPreviewItem) => boolean;

/**
 * The message for you that the status bar shows on arrival, in place of the
 * chat toast, for {@link STATUS_PREVIEW_MS}: then it folds into the chip that
 * names who wants you. The newest message wins; nothing stacks. It shows only
 * while a status bar with room for it is mounted ({@link attach}); otherwise
 * the toast goes up as before.
 */
export class ChatStatusPreview {
  private current: ChatStatusPreviewItem | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly rooms = new Set<PreviewRoom>();
  private readonly listeners = new Set<() => void>();
  durationMs = STATUS_PREVIEW_MS;

  /** A status bar that can show the preview when `room` says it fits, until the returned release. */
  attach(room: PreviewRoom): () => void {
    this.rooms.add(room);
    return () => {
      this.rooms.delete(room);
      if (this.rooms.size === 0) this.dismiss();
    };
  }

  /**
   * Takes the message for the status bar when one has room for it, and shows
   * it unless a newer one is showing (that one stays; this one counts in the
   * chip). False when no status bar can: the caller raises its toast instead.
   */
  offer(item: ChatStatusPreviewItem): boolean {
    if (![...this.rooms].some((room) => room(item))) return false;
    if (this.current && this.current.at > item.at) return true;
    this.current = item;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.dismiss(), this.durationMs);
    this.emit();
    return true;
  }

  get = (): ChatStatusPreviewItem | null => this.current;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Folds the message into the chip now: opened, read, or no status bar left to show it. */
  dismiss(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.current) return;
    this.current = null;
    this.emit();
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

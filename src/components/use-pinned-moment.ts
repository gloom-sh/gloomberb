import { usePinnedTabTime, useUnpinTab } from "../state/app/tab-cursor";
import { usePaneFooter } from "./layout/pane/footer";

/**
 * For a list that follows the tab's pinned crosshair (news, the tape): the
 * pinned moment, null while nothing is pinned, and while it is pinned an
 * `[Esc]unpin` footer hint, so the pin can be seen and lifted from a pane with
 * no chart, the way Esc lifts it on one. `enabled: false` while Esc means
 * something else here, such as going back from an open item.
 */
export function usePinnedMoment(registrationId: string, { enabled = true }: { enabled?: boolean } = {}): number | null {
  const pinnedAt = usePinnedTabTime();
  const unpin = useUnpinTab();
  const offered = enabled && pinnedAt !== null;
  usePaneFooter(registrationId, () => offered
    ? { hints: [{ id: "unpin", key: "Esc", label: "unpin", title: "Unpin Crosshair", onPress: unpin }] }
    : null, [offered, unpin]);
  return pinnedAt;
}

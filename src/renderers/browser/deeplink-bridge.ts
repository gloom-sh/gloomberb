import { marketplaceLayoutIdFromSearch } from "../../layout-marketplace/api";
import { paneShareIdFromSearch } from "../../shares/location";
import type { DesktopDeepLinkBridge } from "../../types/desktop-deeplink";
import { researchEntryFromSearch } from "./research-entry";

export function createBrowserDeepLinkBridge(): DesktopDeepLinkBridge {
  // Restoring a saved pane can update the address before App subscribes.
  // Keep the incoming link intact until it has been delivered once.
  const initialSearch = window.location.search;
  return {
    subscribe(listener) {
      let initial = true;
      const emit = () => {
        const search = initial ? initialSearch : window.location.search;
        initial = false;
        const layoutId = marketplaceLayoutIdFromSearch(search);
        if (layoutId) {
          listener({ url: `gloomberb://layout/${layoutId}` });
          return;
        }
        const shareId = paneShareIdFromSearch(search);
        if (shareId) {
          listener({ url: `gloomberb://share/${shareId}` });
          return;
        }
        const entry = researchEntryFromSearch(search);
        if (entry) listener({ url: `gloomberb://ticker/${encodeURIComponent(entry.symbol)}?tab=${entry.tab}` });
      };
      emit();
      window.addEventListener("popstate", emit);
      return () => window.removeEventListener("popstate", emit);
    },
  };
}

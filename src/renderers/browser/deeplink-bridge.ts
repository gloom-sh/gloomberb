import { marketplaceLayoutIdFromSearch } from "../../layout-marketplace/api";
import { paneShareIdFromSearch } from "../../shares/location";
import type { DesktopDeepLinkBridge } from "../../types/desktop-deeplink";
import { researchEntryFromSearch } from "./research-entry";

export function createBrowserDeepLinkBridge(): DesktopDeepLinkBridge {
  return {
    subscribe(listener) {
      const emit = () => {
        const layoutId = marketplaceLayoutIdFromSearch(window.location.search);
        if (layoutId) {
          listener({ url: `gloomberb://layout/${layoutId}` });
          return;
        }
        const shareId = paneShareIdFromSearch(window.location.search);
        if (shareId) {
          listener({ url: `gloomberb://share/${shareId}` });
          return;
        }
        const entry = researchEntryFromSearch(window.location.search);
        if (entry) listener({ url: `gloomberb://ticker/${encodeURIComponent(entry.symbol)}?tab=${entry.tab}` });
      };
      emit();
      window.addEventListener("popstate", emit);
      return () => window.removeEventListener("popstate", emit);
    },
  };
}

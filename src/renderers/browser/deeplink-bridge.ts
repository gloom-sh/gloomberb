import { marketplaceLayoutIdFromSearch } from "../../layout-marketplace/api";
import { paneShareIdFromSearch } from "../../shares/location";
import type { DesktopDeepLinkBridge } from "../../types/desktop-deeplink";

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
        if (shareId) listener({ url: `gloomberb://share/${shareId}` });
      };
      emit();
      window.addEventListener("popstate", emit);
      return () => window.removeEventListener("popstate", emit);
    },
  };
}

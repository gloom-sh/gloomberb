import { paneShareIdFromSearch } from "../../shares/location";
import type { DesktopDeepLinkBridge } from "../../types/desktop-deeplink";

export function createBrowserDeepLinkBridge(): DesktopDeepLinkBridge {
  return {
    subscribe(listener) {
      const emit = () => {
        const id = paneShareIdFromSearch(window.location.search);
        if (id) listener({ url: `gloomberb://share/${id}` });
      };
      emit();
      window.addEventListener("popstate", emit);
      return () => window.removeEventListener("popstate", emit);
    },
  };
}

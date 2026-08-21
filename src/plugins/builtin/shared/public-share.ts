import { useCallback } from "react";
import { useRendererHost } from "../../../ui";
import { createShare, publicShareUrl } from "../../../shares/api";
import type { SharePayload } from "../../../shares/payload";
import { usePluginAppActions } from "../../runtime";

export function usePublicShare(): (payload: SharePayload) => Promise<void> {
  const renderer = useRendererHost();
  const { notify } = usePluginAppActions();

  return useCallback(async (payload: SharePayload) => {
    try {
      const { id } = await createShare(payload);
      await renderer.copyText(publicShareUrl(id));
      notify({ body: "Share link copied to clipboard", type: "success" });
    } catch (error) {
      notify({
        body: error instanceof Error ? error.message : "Could not create share.",
        type: "error",
      });
    }
  }, [notify, renderer]);
}

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePaneStateValue } from "../../../state/app/context";
import { usePluginConfigState } from "../../runtime";
import { COMMON_ASSUMPTIONS_STATE_KEY } from "./constants";
import { normalizeKellyCommonAssumptions } from "./model";
import {
  DEFAULT_KELLY_COMMON_ASSUMPTIONS,
  type KellyCommonAssumptions,
  type KellySizerDraft,
} from "./types";

export function useKellyCommonAssumptions(rawActiveDraft: KellySizerDraft): {
  commonAssumptions: KellyCommonAssumptions;
  updateCommon: (patch: Partial<KellyCommonAssumptions>) => void;
} {
  const commonFallback = useMemo(
    () => normalizeKellyCommonAssumptions(rawActiveDraft, DEFAULT_KELLY_COMMON_ASSUMPTIONS),
    [rawActiveDraft],
  );
  const [storedCommonAssumptions, setStoredCommonAssumptions] = usePluginConfigState<KellyCommonAssumptions>(
    COMMON_ASSUMPTIONS_STATE_KEY,
    commonFallback,
  );
  const [paneCommonAssumptions, setPaneCommonAssumptions] = usePaneStateValue<KellyCommonAssumptions | null>(
    COMMON_ASSUMPTIONS_STATE_KEY,
    null,
  );
  const seededCommonAssumptions = useMemo(
    () => normalizeKellyCommonAssumptions(storedCommonAssumptions, commonFallback),
    [commonFallback, storedCommonAssumptions],
  );
  const [localCommonAssumptions, setLocalCommonAssumptions] = useState<KellyCommonAssumptions | null>(null);

  useEffect(() => {
    if (paneCommonAssumptions === null) {
      setPaneCommonAssumptions(seededCommonAssumptions);
    }
  }, [paneCommonAssumptions, seededCommonAssumptions, setPaneCommonAssumptions]);

  useEffect(() => {
    if (localCommonAssumptions !== null) return;
    setLocalCommonAssumptions(normalizeKellyCommonAssumptions(
      paneCommonAssumptions ?? seededCommonAssumptions,
      seededCommonAssumptions,
    ));
  }, [localCommonAssumptions, paneCommonAssumptions, seededCommonAssumptions]);

  const commonAssumptions = useMemo(
    () => normalizeKellyCommonAssumptions(
      localCommonAssumptions ?? paneCommonAssumptions ?? seededCommonAssumptions,
      seededCommonAssumptions,
    ),
    [localCommonAssumptions, paneCommonAssumptions, seededCommonAssumptions],
  );

  const updateCommon = useCallback((patch: Partial<KellyCommonAssumptions>) => {
    const next = normalizeKellyCommonAssumptions({
      ...commonAssumptions,
      ...patch,
    }, commonAssumptions);
    setLocalCommonAssumptions(next);
    setPaneCommonAssumptions(next);
    setStoredCommonAssumptions(next);
  }, [commonAssumptions, setPaneCommonAssumptions, setStoredCommonAssumptions]);

  return { commonAssumptions, updateCommon };
}

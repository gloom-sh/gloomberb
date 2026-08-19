import { useCallback, useEffect, useRef, useState, type Dispatch } from "react";
import type { DataProvider } from "../../../../types/data-provider";
import type { TickerRecord } from "../../../../types/ticker";
import type { AppAction } from "../../../../core/state/app/types";
import type { AiProvider } from "../providers";
import { getAiProvider, getAiProviderUnavailableReason } from "../providers";
import {
  checkAiProviderStatus,
  isAiRunCancelled,
  runAiPrompt,
  type AiRunController,
} from "../runner";
import {
  buildScreenerPrompt,
  deriveScreenerTitle,
  getScreenerPromptSignature,
  parseScreenerResponse,
} from "./contract";
import type { AiScreenerTab, RunState } from "./model";
import { validateScreenerResults } from "./results";

interface UseAiScreenerRunnerOptions {
  dataProvider: DataProvider | null;
  dispatch: Dispatch<AppAction>;
  providers: AiProvider[];
  tabs: AiScreenerTab[];
  tickers: Map<string, TickerRecord>;
  resolveSelection?: (tab: AiScreenerTab) => { providerId: string; modelId: string | null };
  upsertTab: (tabId: string, updater: (tab: AiScreenerTab) => AiScreenerTab) => void;
}

export function useAiScreenerRunner({
  dataProvider,
  dispatch,
  providers,
  tabs,
  tickers,
  resolveSelection = (tab) => ({ providerId: tab.providerId, modelId: tab.modelId }),
  upsertTab,
}: UseAiScreenerRunnerOptions) {
  const [runState, setRunState] = useState<RunState | null>(null);
  const runRef = useRef<AiRunController | null>(null);

  const cancelRun = useCallback(() => {
    runRef.current?.cancel();
    runRef.current = null;
    setRunState(null);
  }, []);

  const runTab = useCallback(async (tabId: string) => {
    const tab = tabs.find((entry) => entry.id === tabId);
    if (!tab) return;
    const selection = resolveSelection(tab);

    const provider = getAiProvider(selection.providerId, providers);
    if (!provider) {
      upsertTab(tab.id, (current) => ({ ...current, lastError: "Unknown AI provider configured for this screener." }));
      return;
    }
    if (!provider.available) {
      upsertTab(tab.id, (current) => ({
        ...current,
        lastError: getAiProviderUnavailableReason(provider),
      }));
      return;
    }

    try {
      const providerStatus = await checkAiProviderStatus(provider);
      if (!providerStatus.available || (!providerStatus.authenticated && !providerStatus.inconclusive)) {
        upsertTab(tab.id, (current) => ({
          ...current,
          lastError: providerStatus.message ?? `${provider.name} is not ready.`,
        }));
        return;
      }
    } catch (error) {
      upsertTab(tab.id, (current) => ({
        ...current,
        lastError: error instanceof Error ? error.message : `${provider.name} status check failed.`,
      }));
      return;
    }

    runRef.current?.cancel();
    const startedAt = Date.now();
    const prompt = buildScreenerPrompt({
      currentDate: new Date(startedAt).toISOString().slice(0, 10),
      prompt: tab.prompt,
    });

    setRunState({ tabId: tab.id, output: "" });
    upsertTab(tab.id, (current) => ({
      ...current,
      lastRunAt: startedAt,
      lastError: null,
      lastWarning: null,
    }));

    let rawOutput = "";
    let run: AiRunController | null = null;
    try {
      run = runAiPrompt({
        providerId: provider.id,
        prompt,
        modelId: selection.modelId ?? undefined,
        outputMode: "screener",
        onChunk: (output) => {
          setRunState((current) => (
            current?.tabId === tab.id
              ? { ...current, output }
              : current
          ));
        },
      });
      runRef.current = run;
      rawOutput = await run.done;

      const parsed = parseScreenerResponse(rawOutput);
      const validated = await validateScreenerResults(parsed.tickers, tickers, dispatch, dataProvider);

      upsertTab(tab.id, (current) => ({
        ...current,
        title: parsed.title || current.title || deriveScreenerTitle(current.prompt),
        summary: parsed.summary,
        results: validated.results,
        lastSuccessAt: startedAt,
        lastRunPromptSignature: getScreenerPromptSignature(
          current.prompt,
          selection.providerId,
          selection.modelId,
        ),
        lastError: null,
        lastWarning: validated.warning,
        debugOutput: null,
      }));
    } catch (error: unknown) {
      if (isAiRunCancelled(error)) return;
      upsertTab(tab.id, (current) => ({
        ...current,
        lastError: error instanceof Error ? error.message : "AI screener failed.",
        debugOutput: rawOutput.trim() || current.debugOutput,
      }));
    } finally {
      // Only tear down if this run is still the active one: a newer run may have
      // replaced it while this one was finishing, and clearing the ref then would
      // leave the new run uncancellable.
      if (runRef.current === run) {
        runRef.current = null;
        setRunState((current) => (current?.tabId === tab.id ? null : current));
      }
    }
  }, [dataProvider, dispatch, providers, resolveSelection, tabs, tickers, upsertTab]);

  useEffect(() => () => {
    runRef.current?.cancel();
  }, []);

  return {
    cancelRun,
    runState,
    runTab,
  };
}

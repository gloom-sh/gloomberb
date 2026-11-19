import { useEffect, useMemo, useRef } from "react";
import { useSavedCopyFooter } from "../../../components/layout/pane/footer/registration";
import { deleteSavedCopy, readSavedCopy, writeSavedCopy } from "../../../data/pane-saved-copies";
import type { SecFilingItem } from "../../../types/data-provider";
import { useSecFilingContentCache } from "../sec/filing-content";
import { parseInsiderFiling, type ParsedInsiderFiling } from "./model";

type DisplayRow = Omit<ParsedInsiderFiling, "filing" | "isLoading">;

export function useInsiderFilingRows(listing: string, access: string | null, filings: readonly SecFilingItem[]) {
  const scope = JSON.stringify([listing, access]);
  const { contentCache, contentErrors, pendingCount } = useSecFilingContentCache({ scopeKey: scope, targets: filings });
  const entries = useMemo(() => filings.map((filing) => {
    const accession = filing.accessionNumber;
    const key = access ? { key: ["insider-filing-rows", scope, accession, filing.cik, filing.primaryDocument] } : null;
    const settled = contentCache.has(accession);
    const document = contentCache.get(accession) ?? null;
    const failed = contentErrors.has(accession);
    const saved = key && (!settled || failed) ? readSavedCopy<DisplayRow[]>(key) : null;
    const rows = saved ? saved.value.map((row) => ({ ...row, filing, isLoading: false }))
      : parseInsiderFiling(filing, document, !settled);
    return { accession, key, document, rows, settled: settled || !!saved, savedAt: saved?.fetchedAt };
  }), [access, contentCache, contentErrors, filings, scope]);

  const documents = useRef(new Set<string>());
  useEffect(() => {
    documents.current.clear();
  }, [scope]);
  useEffect(() => {
    for (const entry of entries) {
      if (!entry.key || documents.current.has(entry.accession)) continue;
      if (!entry.document) {
        if (entry.settled && entry.savedAt == null) deleteSavedCopy(entry.key);
        continue;
      }
      documents.current.add(entry.accession);
      writeSavedCopy(entry.key, entry.rows.map(({ filing, isLoading, ...row }) => row));
    }
  }, [entries]);

  const savedAt = entries.reduce<number | null>((oldest, entry) => entry.savedAt == null ? oldest : Math.min(oldest ?? entry.savedAt, entry.savedAt), null);
  useSavedCopyFooter(savedAt, pendingCount > 0);
  return useMemo(() => ({
    rows: entries.flatMap((entry) => entry.rows),
    ownerFilingsShown: entries.some((entry) => entry.settled && entry.rows.length === 0),
    ownFilingShown: entries.some((entry) => entry.settled && entry.rows.length > 0),
    pendingCount: Math.max(0, pendingCount - entries.filter((entry) => entry.savedAt != null).length),
  }), [entries, pendingCount]);
}

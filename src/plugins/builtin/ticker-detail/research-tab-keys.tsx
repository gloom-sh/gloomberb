import { createContext, useContext, useId, useLayoutEffect, useMemo, useState, type ReactNode } from "react";

/**
 * The Ticker Research strip owns h/l and the arrows. A tab's content can show
 * its own strip (Holders' chart/table) or a detail that moves with h/l (a 13F
 * fund's sections); this says which of them gets the keys, so it never depends
 * on which handler registered first.
 */
interface ResearchTabKeys {
  claim(owner: string, claimed: boolean): void;
}

const ResearchTabKeysContext = createContext<ResearchTabKeys | null>(null);

/**
 * True inside a Ticker Research tab. A strip of the tab's own leaves h/l to the
 * research strip there and switches with its own key instead.
 */
export function useInResearchTab(): boolean {
  return useContext(ResearchTabKeysContext) !== null;
}

/**
 * While `claimed`, h/l and the arrows go to the caller instead of the research
 * strip, the way a pane's own tabs let go of them while a detail is open. Esc
 * closing the detail hands them back. Outside the research pane it does nothing.
 */
export function useClaimResearchTabKeys(claimed: boolean): void {
  const context = useContext(ResearchTabKeysContext);
  const owner = useId();
  useLayoutEffect(() => {
    if (!context || !claimed) return;
    context.claim(owner, true);
    return () => context.claim(owner, false);
  }, [claimed, context, owner]);
}

/** Owned by the research pane: whether a tab has claimed the strip's keys, and the value its tabs read. */
export function useResearchTabKeysHost(): { claimed: boolean; value: ResearchTabKeys } {
  const [owners, setOwners] = useState<ReadonlySet<string>>(() => new Set());
  const value = useMemo<ResearchTabKeys>(() => ({
    claim(owner, claimed) {
      setOwners((current) => {
        if (current.has(owner) === claimed) return current;
        const next = new Set(current);
        if (claimed) next.add(owner);
        else next.delete(owner);
        return next;
      });
    },
  }), []);
  return { claimed: owners.size > 0, value };
}

/** `null` when the research strip is hidden: a tab's own strip then keeps h/l and the arrows. */
export function ResearchTabKeysProvider({ value, children }: { value: ResearchTabKeys | null; children: ReactNode }) {
  return <ResearchTabKeysContext.Provider value={value}>{children}</ResearchTabKeysContext.Provider>;
}

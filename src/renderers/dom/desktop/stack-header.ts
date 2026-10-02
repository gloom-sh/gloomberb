import { createContext, type RefObject } from "react";

/**
 * Offered by an open stack detail to the toolbar at the top of its content.
 * When a detail starts with a query bar, Back and the item title move into
 * that bar as its first segments, so the detail has one toolbar instead of a
 * Back band stacked on a filter band.
 */
export interface StackHeaderSlot {
  backLabel: string;
  title?: string;
  onBack(): void;
  /** The detail content; only a bar at its very top may take the header. */
  containerRef: RefObject<HTMLElement | null>;
  /** Hides the stack's own Back band until the returned release is called. */
  attach(): () => void;
}

export const StackHeaderContext = createContext<StackHeaderSlot | null>(null);

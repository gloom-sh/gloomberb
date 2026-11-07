import type { ReactNode } from "react";
import type { AppConfig, ColumnConfig } from "./config";
import type { ContextMenuContext, ContextMenuItem } from "./context-menu";
import type { TickerFinancials } from "./financials";
import type { TickerInstrumentKind } from "./instrument";
import type { TickerRecord } from "./ticker";

export interface CustomColumnDef extends ColumnConfig {
  render: (ticker: TickerRecord, financials: TickerFinancials | null) => string;
}

export interface TickerResearchTabProps {
  width: number;
  height: number;
  focused: boolean;
  onCapture: (capturing: boolean) => void;
}

interface TickerResearchTabVisibilityContext {
  config: AppConfig;
  ticker: TickerRecord | null;
  financials: TickerFinancials | null | undefined;
  hasOptionsChain: boolean;
  /** Resolved from the quote, broker contract and saved type; `equity` when nothing says otherwise. */
  instrumentKind: TickerInstrumentKind;
}

export interface TickerResearchTabDef {
  id: string;
  name: string;
  order: number;
  component: (props: TickerResearchTabProps) => ReactNode;
  /**
   * Instrument kinds this tab has data for, such as `["equity"]` for company
   * filings. Omit when every ticker has it (chart, news, notes).
   */
  instruments?: readonly TickerInstrumentKind[];
  /** Narrower checks than `instruments`: a US listing, an options chain, a connected broker. */
  isVisible?: (context: TickerResearchTabVisibilityContext) => boolean;
}

export interface TickerAction {
  id: string;
  label: string;
  keywords: string[];
  filter?: (ticker: TickerRecord) => boolean;
  execute: (ticker: TickerRecord, financials: TickerFinancials | null) => void | Promise<void>;
}

export interface ContextMenuProviderDef {
  id: string;
  order?: number;
  contexts?: ContextMenuContext["kind"][];
  getItems(context: ContextMenuContext): ContextMenuItem[] | null | undefined;
}

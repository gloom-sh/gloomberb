import { useCallback } from "react";
import type { PaneHint } from "../../../components";
import type { PaneTemplateCreateOptions } from "../../../types/plugin";
import { usePluginAppActions } from "../../runtime";
import { RESEARCH_SEARCH_TEMPLATE_ID } from "../research-search/model";
import { useOpenDescription } from "../shared/open-description";
import { THIRTEENF_TEMPLATE_ID } from "../thirteenf/model";
import type { EventAlertRule } from "./events";
import type { AlertHistoryItem } from "./history";
import { isResearchAlertKind, readResearchRule } from "./research-rules";
import type { AlertRule } from "./types";

/** What an alert follows, read the same way from a saved rule and from a delivered alert. */
export interface AlertSubject {
  kind: string;
  symbol?: string;
  exchange?: string;
  marketId?: string;
  /** A macro event rule's release: `cpi` or `fomc`. */
  event?: string;
  keyword?: string;
  cik?: string;
}

/** A listing's DES, or a pane template and what it opens on. */
export type AlertTarget =
  | { kind: "description"; symbol: string; exchange?: string }
  | { kind: "pane"; templateId: string; options?: PaneTemplateCreateOptions };

const pane = (templateId: string, options?: PaneTemplateCreateOptions): AlertTarget =>
  ({ kind: "pane", templateId, ...(options ? { options } : {}) });

/**
 * The one map from what an alert follows to what it opens, for every rule kind and every delivered alert:
 * a perpetual opens PERP on its market; a dated event the pane its date comes from (ERN, CPI, WIRP); catalyst,
 * Congress and 13F rules their calendar or list, on the company or fund they name; a hiring move HIRE on the
 * company; any other rule on a security
 * that listing's DES. A rule on no security opens the pane it watches (SRCH for a news keyword, FLOW for flow
 * on the user's lists, FIRST for breaking news). Null when there is nothing to open.
 */
export function alertTarget(subject: AlertSubject): AlertTarget | null {
  const { kind, symbol } = subject;
  switch (kind) {
    case "perps_threshold": return subject.marketId ? pane("perps-pane", { arg: subject.marketId }) : null;
    case "earnings_date":
    case "earnings": return symbol ? pane("earnings-calendar-pane", { arg: symbol }) : null;
    case "macro_event": return subject.event === "cpi" ? pane("cpi-pane") : subject.event === "fomc" ? pane("rate-path-pane") : null;
    case "catalyst": return pane("catalysts-pane", symbol ? { symbol } : undefined);
    case "congress_trade": return pane("congress-trades-pane");
    case "thirteenf_filing": return pane(THIRTEENF_TEMPLATE_ID, subject.cik ? { arg: subject.cik } : undefined);
    case "news_keyword": if (!symbol) return pane(RESEARCH_SEARCH_TEMPLATE_ID, subject.keyword ? { arg: subject.keyword } : undefined); break;
    case "options_flow": if (!symbol) return pane("scanner-flow-pane"); break;
    case "breaking_news": if (!symbol) return pane("news-breaking-pane"); break;
    // A hiring move opens HIRE on the company, where its Moves tab says why.
    case "hiring_move": return symbol ? pane("hiring-pane", { symbol }) : null;
  }
  return symbol ? { kind: "description", symbol, ...(subject.exchange ? { exchange: subject.exchange } : {}) } : null;
}

/** A research rule's `US` is any US venue, which names no listing. */
const venue = (exchange: string | undefined) => exchange && exchange !== "US" ? exchange : undefined;

/** An Events rule: a ticker, a fund or a research rule's own fields. */
export function eventRuleSubject(rule: EventAlertRule): AlertSubject {
  if (isResearchAlertKind(rule.kind)) {
    const config = readResearchRule(rule.kind, rule.value);
    return { kind: rule.kind, symbol: config?.symbol, exchange: venue(config?.exchange), marketId: config?.marketId, event: config?.event, keyword: config?.keyword };
  }
  return { kind: rule.kind, ...(rule.target === "ticker" ? { symbol: rule.value } : rule.target === "fund" ? { cik: rule.value } : {}) };
}

export const priceRuleSubject = (alert: AlertRule): AlertSubject => ({ kind: "price", symbol: alert.symbol, exchange: alert.exchange });

/** A delivered alert, from the fields its notification carries. */
export function deliveredAlertSubject(item: AlertHistoryItem): AlertSubject {
  const text = (key: string) => {
    const value = item.data?.[key];
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  };
  return { kind: item.kind, symbol: text("symbol"), exchange: venue(text("exchange")), marketId: text("marketId"), event: text("event"), keyword: text("keyword"), cik: text("cik") };
}

/** The `v` hint each alerts tab gives its selected row, when the row has something to open. */
export const alertViewHints = (target: AlertTarget | null, open: (target: AlertTarget) => void): PaneHint[] =>
  target ? [{ id: "view", key: "v", label: "iew", title: "View what it follows", onPress: () => open(target) }] : [];

/** Opens an alert's target: a DES the way every pane's `d` does, any other pane from its template. */
export function useOpenAlertTarget(): (target: AlertTarget) => void {
  const openDescription = useOpenDescription();
  const { createPaneFromTemplate } = usePluginAppActions();
  return useCallback((target: AlertTarget) => {
    if (target.kind === "description") openDescription(target.symbol, target.exchange);
    else createPaneFromTemplate(target.templateId, target.options);
  }, [createPaneFromTemplate, openDescription]);
}

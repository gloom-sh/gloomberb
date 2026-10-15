import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { NestedPaneTabs, PaneFooterScope, usePaneTabs } from "../../../components";
import { withPluginStateNamespace } from "../../runtime/context";
import { Box } from "../../../ui";
import type { PaneProps } from "../../../types/plugin";
import { useCommandTab, useCommandValue } from "../shared/command-tab";
import { CdsPane } from "../cds/pane";
import { CreditConditionsPane } from "../credit-conditions";
import { CreditDocumentsPane } from "../credit-documents/pane";
import { DebtMaturitiesPane } from "../debt-maturities/pane";
import { CdxPane } from "../credit-boards/cdx-pane";
import { SovrPane } from "../credit-boards/sovr-pane";
import { BondCalculatorPane } from "../bond-calculator/pane";
import { TreasuryAuctionsPane } from "../treasury-auctions/pane";
import { TraceBondsPane } from "../trace-bonds/pane";
import { TreasuryDailyPane } from "../treasury-daily/pane";
import { PrimaryDealersPane } from "../primary-dealers/pane";
import {
  FIXED_INCOME_PANE_ID,
  FIXED_INCOME_SECTIONS,
  FIXED_INCOME_VIEW_STATE,
  type FixedIncomeSection,
} from "./model";

const FixedIncomeCdsPane = withPluginStateNamespace(FIXED_INCOME_VIEW_STATE.cds, CdsPane);
const FixedIncomeCdxPane = withPluginStateNamespace(FIXED_INCOME_VIEW_STATE.creditBoards, CdxPane);
const FixedIncomeSovrPane = withPluginStateNamespace(FIXED_INCOME_VIEW_STATE.creditBoards, SovrPane);
const FixedIncomeCreditConditionsPane = withPluginStateNamespace(FIXED_INCOME_VIEW_STATE.creditConditions, CreditConditionsPane);
const ResearchCreditDocumentsPane = withPluginStateNamespace("ticker-research", CreditDocumentsPane);
const ResearchDebtMaturitiesPane = withPluginStateNamespace("ticker-research", DebtMaturitiesPane);
const FixedIncomeBondCalculatorPane = withPluginStateNamespace(FIXED_INCOME_VIEW_STATE.bondCalculator, BondCalculatorPane);
const FixedIncomeTreasuryAuctionsPane = withPluginStateNamespace(FIXED_INCOME_VIEW_STATE.treasuryAuctions, TreasuryAuctionsPane);
const FixedIncomeTraceBondsPane = withPluginStateNamespace(FIXED_INCOME_VIEW_STATE.traceBonds, TraceBondsPane);
const FixedIncomeTreasuryDailyPane = withPluginStateNamespace(FIXED_INCOME_VIEW_STATE.treasuryDaily, TreasuryDailyPane);
const FixedIncomePrimaryDealersPane = withPluginStateNamespace(FIXED_INCOME_VIEW_STATE.primaryDealers, PrimaryDealersPane);

type ViewDef = { value: string; label: string; paneType: string; component: (props: PaneProps) => ReactNode };

const SECTION_VIEWS: Record<FixedIncomeSection, { defaultView: string; views: ViewDef[] }> = {
  credit: {
    defaultView: "single-name",
    views: [
      { value: "single-name", label: "Single-name CDS", paneType: "cds", component: FixedIncomeCdsPane },
      { value: "index", label: "Index CDS", paneType: "cdx-board", component: FixedIncomeCdxPane },
      { value: "sovereign", label: "Sovereign CDS", paneType: "cdx-board", component: FixedIncomeSovrPane },
      { value: "spreads", label: "Credit Spreads", paneType: "credit-conditions", component: FixedIncomeCreditConditionsPane },
    ],
  },
  "issuer-debt": {
    defaultView: "documents",
    views: [
      { value: "documents", label: "Documents", paneType: "credit-documents", component: ResearchCreditDocumentsPane },
      { value: "maturities", label: "Maturities", paneType: "debt-maturities", component: ResearchDebtMaturitiesPane },
    ],
  },
  bonds: {
    defaultView: "tape",
    views: [
      { value: "tape", label: "Corporate Tape", paneType: "trace-bonds", component: FixedIncomeTraceBondsPane },
      { value: "calculator", label: "Calculator", paneType: "bond-calculator", component: FixedIncomeBondCalculatorPane },
    ],
  },
  treasury: {
    defaultView: "auctions",
    views: [
      { value: "auctions", label: "Auctions", paneType: "treasury-auctions", component: FixedIncomeTreasuryAuctionsPane },
      { value: "cash-debt", label: "Cash & Debt", paneType: "treasury-daily", component: FixedIncomeTreasuryDailyPane },
      { value: "dealers", label: "Dealers", paneType: "primary-dealers", component: FixedIncomePrimaryDealersPane },
    ],
  },
};

function FixedIncomeSectionPane({ section, ...props }: PaneProps & { section: FixedIncomeSection }) {
  const definition = SECTION_VIEWS[section];
  const [view, setView] = useCommandValue(
    FIXED_INCOME_PANE_ID,
    `fixed-income:view:${section}`,
    (params) => definition.views.some((candidate) => candidate.value === params.view) ? params.view! : null,
    definition.defaultView,
  );
  const [mounted, setMounted] = useState<Set<string>>(() => new Set([view]));
  useEffect(() => {
    setMounted((current) => current.has(view) ? current : new Set([...current, view]));
  }, [view]);

  const tabs = definition.views.map(({ value, label }) => ({ value, label }));
  const { strip, rows } = usePaneTabs({
    tabs,
    activeValue: view,
    onSelect: setView,
    focused: props.focused,
    dense: true,
    queryBarWidth: props.width,
  });
  const contentHeight = Math.max(1, props.height - rows);

  return (
    <Box width={props.width} height={props.height} flexDirection="column" overflow="hidden">
      {strip}
      <Box height={contentHeight} flexGrow={1} flexBasis={0} overflow="hidden">
        {definition.views.map(({ value, paneType, component: View }) => (
          mounted.has(value) || value === view ? (
            <Box
              key={value}
              visible={value === view}
              height={contentHeight}
              flexGrow={1}
              flexBasis={0}
              overflow="hidden"
              data-gloom-role="nested-pane-content"
            >
              <PaneFooterScope active={value === view}>
                <View {...props} paneType={paneType} height={contentHeight} focused={props.focused && value === view} />
              </PaneFooterScope>
            </Box>
          ) : null
        ))}
      </Box>
    </Box>
  );
}

export function FixedIncomePane(props: PaneProps) {
  const [section, setSection] = useCommandTab(
    FIXED_INCOME_PANE_ID,
    "fixed-income:section",
    FIXED_INCOME_SECTIONS.map(({ value }) => value),
    "credit",
  );
  const [mounted, setMounted] = useState<Set<FixedIncomeSection>>(() => new Set([section]));
  useEffect(() => {
    setMounted((current) => current.has(section) ? current : new Set([...current, section]));
  }, [section]);

  const { strip, rows } = usePaneTabs({
    tabs: FIXED_INCOME_SECTIONS,
    activeValue: section,
    onSelect: (value) => setSection(value as FixedIncomeSection),
    focused: props.focused,
    dense: true,
  });
  const contentHeight = Math.max(1, props.height - rows);

  return (
    <Box width={props.width} height={props.height} flexDirection="column" overflow="hidden">
      {strip}
      <Box height={contentHeight} flexGrow={1} flexBasis={0} overflow="hidden">
        {FIXED_INCOME_SECTIONS.map(({ value }) => (
          mounted.has(value) || value === section ? (
            <Box key={value} visible={value === section} height={contentHeight} flexGrow={1} flexBasis={0} overflow="hidden" data-gloom-role="nested-pane-content">
              <PaneFooterScope active={value === section}>
                <NestedPaneTabs>
                  <FixedIncomeSectionPane {...props} section={value} height={contentHeight} focused={props.focused && value === section} />
                </NestedPaneTabs>
              </PaneFooterScope>
            </Box>
          ) : null
        ))}
      </Box>
    </Box>
  );
}

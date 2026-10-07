import { usePaneMenuItems } from "../../../components";
import { usePluginAppActions } from "../../../public/react";

/** Existing estimates and reported earnings stay in place; their menu opens cited company disclosures. */
export function useCompanyDisclosureLinks(symbol: string | null) {
  const { createPaneFromTemplate } = usePluginAppActions();
  usePaneMenuItems("company-disclosures:related", () => symbol ? [
    { id: "company-kpis", label: "Company KPIs (KPIS)", onSelect: () => createPaneFromTemplate("company-kpis-pane", { symbol }) },
    { id: "company-guidance", label: "Company Guidance (GUIDE)", onSelect: () => createPaneFromTemplate("company-guidance-pane", { symbol }) },
  ] : null, [symbol, createPaneFromTemplate]);
}

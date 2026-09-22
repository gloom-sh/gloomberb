import type { PluginModule } from "../plugin-module";
import { bondCalculatorHeadless } from "./headless";
import { BondCalculatorPane } from "./pane";

export const bondCalculatorModule: PluginModule = {
  panes: [{ id: "bond-calculator", name: "Bond Calculator", icon: "Y", component: BondCalculatorPane,
    defaultPosition: "right", defaultMode: "floating", defaultFloatingSize: { width: 80, height: 31 } }],
  paneTemplates: [{ id: "bond-calculator-pane", paneId: "bond-calculator", label: "Bond Calculator",
    description: "Price, yield, accrued interest, duration, convexity and Treasury spread for a fixed coupon bond.",
    keywords: ["yas", "bond", "calculator", "yield", "price", "duration", "dv01"], shortcut: { prefix: "YAS" },
    headless: bondCalculatorHeadless, createInstance: () => ({}) }],
};

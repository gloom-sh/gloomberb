import type { PluginModule } from "../plugin-module";
import { bondCalculatorHeadless } from "./headless";
import { fixedIncomeShortcut } from "../fixed-income/shortcut";

export const bondCalculatorModule: PluginModule = {
  paneTemplates: [fixedIncomeShortcut({ id: "bond-calculator-pane", paneId: "bond-calculator", label: "Bond Calculator",
    description: "Price, yield, accrued interest, duration, convexity and Treasury spread for a fixed coupon bond.",
    keywords: ["yas", "bond", "calculator", "yield", "price", "duration", "dv01", "hedge ratio", "steepener", "flattener"], shortcut: { prefix: "YAS" },
    headless: bondCalculatorHeadless, createInstance: () => ({}) }, "bonds", "calculator")],
};

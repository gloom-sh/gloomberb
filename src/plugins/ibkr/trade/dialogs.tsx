import type { DialogApi, PromptContext } from "../../../ui/dialog";
import type { BrokerInstanceConfig } from "../../../types/config";
import type { BrokerAccount } from "../../../types/trading";
import { formatCurrency } from "../../../utils/format";
import { ChoiceDialog } from "../dialogs";

export function promptIbkrProfileChoice(
  dialog: DialogApi,
  gatewayInstances: BrokerInstanceConfig[],
): Promise<string | undefined> {
  return dialog.prompt<string>({
    content: (ctx: PromptContext<string>) => (
      <ChoiceDialog
        {...ctx}
        title="Choose IBKR Profile"
        choices={gatewayInstances.map((instance) => ({
          id: instance.id,
          label: instance.label,
          description: "Gateway / TWS",
        }))}
      />
    ),
  });
}

export function promptIbkrAccountChoice(
  dialog: DialogApi,
  selectedInstance: BrokerInstanceConfig,
  accounts: BrokerAccount[],
): Promise<string | undefined> {
  return dialog.prompt<string>({
    content: (ctx: PromptContext<string>) => (
      <ChoiceDialog
        {...ctx}
        title="Choose Account"
        choices={accounts.map((account) => ({
          id: account.accountId,
          label: `${selectedInstance.label} → ${account.accountId}`,
          description: `${formatCurrency(account.netLiquidation || 0, account.currency || "USD")} net liq`,
        }))}
      />
    ),
  });
}

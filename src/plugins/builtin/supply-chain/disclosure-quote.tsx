import type { SupplyRole } from "../../../api-client/supply-chain";
import { Prose } from "../../../components";
import { quoteBlockStyle } from "../../../components/ui/quote";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, useUiCapabilities } from "../../../ui";
import { quoteLanguageLabel, ROLE_COLORS } from "./model";

/**
 * A literal filing quote, with the same relationship accent in every SPLC view.
 * `label` replaces the quote's heading when the text is not a quotation, as
 * a tagged XBRL fact read out in words is not.
 */
export function DisclosureQuote({ role, quote, quoteLanguage, width, label }: { role: SupplyRole; quote: string; quoteLanguage?: string | null; width: number; label?: string }) {
  const colors = useThemeColors();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  return <Box marginY={1} paddingLeft={desktop ? 0 : 1} border={desktop ? undefined : ["left"]} borderColor={ROLE_COLORS[role]}
    style={desktop ? quoteBlockStyle(ROLE_COLORS[role]) : undefined}>
    <Text fg={colors.textDim}>{label ?? `Original quote · ${quoteLanguageLabel({ quoteLanguage: quoteLanguage ?? null })}`}</Text>
    <Prose text={quote} width={Math.max(1, width - 6)} figures={false} />
  </Box>;
}

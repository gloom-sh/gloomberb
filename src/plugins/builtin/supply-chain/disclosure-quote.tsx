import type { SupplyRole } from "../../../api-client/supply-chain";
import { Prose } from "../../../components";
import { blendHex } from "../../../theme/colors";
import { useThemeColors } from "../../../theme/theme-context";
import { Box, Text, useUiCapabilities } from "../../../ui";
import { quoteLanguageLabel, ROLE_COLORS } from "./model";

/** A literal filing quote, with the same relationship accent in every SPLC view. */
export function DisclosureQuote({ role, quote, quoteLanguage, width }: { role: SupplyRole; quote: string; quoteLanguage?: string | null; width: number }) {
  const colors = useThemeColors();
  const desktop = !!useUiCapabilities().nativePaneChrome;
  return <Box marginY={1} paddingLeft={desktop ? 0 : 1} border={desktop ? undefined : ["left"]} borderColor={ROLE_COLORS[role]}
    style={desktop ? { borderLeft: `3px solid ${ROLE_COLORS[role]}`, paddingLeft: 12, paddingTop: 4, paddingBottom: 4, backgroundColor: blendHex(colors.bg, ROLE_COLORS[role], 0.07), borderRadius: 2 } : undefined}>
    <Text fg={colors.textDim}>{`Original quote · ${quoteLanguageLabel({ quoteLanguage: quoteLanguage ?? null })}`}</Text>
    <Prose text={quote} width={Math.max(1, width - 6)} figures={false} />
  </Box>;
}

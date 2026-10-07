import { Box, ImageSurface, Text, TextAttributes, useUiCapabilities } from "../ui";
import { cloudLogoPath, type CloudLogoKind } from "../api-client/paths";
import { getCloudApiBaseUrl } from "../api-client/request";
import { resolveAssetDisplayKind } from "../market-data/market/format";
import { colors } from "../theme/colors";

export function resolveCompanyLogoSrc(input: {
  symbol: string;
  assetCategory?: string;
}): string | null {
  const kind = logoKindForAsset(input.assetCategory);
  if (!kind) return null;
  const path = cloudLogoPath(kind, input.symbol);
  return path ? `${getCloudApiBaseUrl()}${path}` : null;
}

export function CompanyLogo({
  symbol,
  assetCategory,
  name,
  width = 5,
  height = 2,
  style,
}: {
  symbol: string;
  assetCategory?: string;
  name?: string;
  width?: number;
  height?: number;
  /** Desktop placement in px, such as the gap to the text beside it. */
  style?: { marginTop?: number; marginRight?: number };
}) {
  const { nativePaneChrome, cellWidthPx = 8, cellHeightPx = 18 } = useUiCapabilities();
  const src = nativePaneChrome === true ? resolveCompanyLogoSrc({ symbol, assetCategory }) : null;
  if (!src) return null;

  return (
    <ImageSurface
      src={src}
      alt={name || symbol}
      width={width}
      height={height}
      marginRight={1}
      flexShrink={0}
      alignItems="center"
      justifyContent="center"
      objectFit="contain"
      style={{
        width: cellWidthPx * width,
        height: cellHeightPx * height,
        flexShrink: 0,
        ...style,
      }}
    >
      {/* Without a logo the initial fills the same tile, so the header keeps its shape. */}
      <Box width="100%" height="100%" bg={colors.border} alignItems="center" justifyContent="center">
        <Text
          fg={colors.text}
          attributes={TextAttributes.BOLD}
          style={{ fontSize: Math.round(cellHeightPx * height * 0.4) }}
        >
          {symbol.trim().charAt(0).toUpperCase() || "?"}
        </Text>
      </Box>
    </ImageSurface>
  );
}

function logoKindForAsset(assetCategory?: string): CloudLogoKind | null {
  const kind = resolveAssetDisplayKind({ assetCategory });
  if (kind === "cash" || kind === "contract") return null;
  return kind === "crypto" ? "crypto" : "ticker";
}

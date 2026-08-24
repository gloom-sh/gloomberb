import { ImageSurface, useUiCapabilities } from "../ui";
import { cloudLogoPath, type CloudLogoKind } from "../api-client/paths";
import { getCloudApiBaseUrl } from "../api-client/request";
import { resolveAssetDisplayKind } from "../market-data/market/format";

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
}: {
  symbol: string;
  assetCategory?: string;
  name?: string;
  width?: number;
  height?: number;
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
      overflow="visible"
      objectFit="contain"
      style={{
        width: cellWidthPx * width,
        height: cellHeightPx * height,
        flexShrink: 0,
      }}
    />
  );
}

function logoKindForAsset(assetCategory?: string): CloudLogoKind | null {
  const kind = resolveAssetDisplayKind({ assetCategory });
  if (kind === "cash" || kind === "contract") return null;
  return kind === "crypto" ? "crypto" : "ticker";
}

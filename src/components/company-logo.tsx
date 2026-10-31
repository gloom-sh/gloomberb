import { createElement } from "react";
import { Box, ImageSurface, Text, TextAttributes, useUiCapabilities } from "../ui";
import { cloudLogoPath, type CloudLogoKind } from "../api-client/paths";
import { getCloudApiBaseUrl } from "../api-client/request";
import { resolveAssetDisplayKind } from "../market-data/market/format";
import { colors } from "../theme/colors";
import type { DataTableCell } from "./ui/data-table";
import { LogoMark, type LogoMarkProps } from "./ui/logo-mark";

export function resolveCompanyLogoSrc(input: {
  symbol: string;
  assetCategory?: string;
}): string | null {
  const kind = logoKindForAsset(input.assetCategory);
  if (!kind) return null;
  const path = cloudLogoPath(kind, input.symbol);
  return path ? `${getCloudApiBaseUrl()}${path}` : null;
}

/** What a row's logo stands for: a company's listing or a coin. */
export interface CompanyLogoSubject {
  symbol: string;
  /** `CRYPTO` draws the coin's logo; any other listing but cash and contracts, the company's. */
  assetCategory?: string;
  /** Its initial stands in while there is no logo; the symbol's without a name. */
  name?: string | null;
}

/**
 * A company's or a coin's logo on a `LogoMark` tile, on the desktop and the
 * web: the logo Gloom Cloud serves for its ticker, and its initial on the
 * same tile when there is none, so a missing logo moves nothing.
 */
export function CompanyLogoMark({ symbol, assetCategory, name, size }: CompanyLogoSubject & Pick<LogoMarkProps, "size">) {
  return createElement(LogoMark, {
    src: resolveCompanyLogoSrc({ symbol, assetCategory }),
    name: name?.trim() || symbol,
    size,
    plate: true,
  });
}

/**
 * The cell that names a company or a coin in a table, led by its logo on the
 * desktop and the web (docs/pane-conventions.md, "Company and coin logos").
 * The terminal gets the cell as it was, and exports read only its text.
 */
export function withCompanyLogo(cell: DataTableCell, subject: CompanyLogoSubject | null | undefined, desktop: boolean): DataTableCell {
  if (!desktop || !subject?.symbol) return cell;
  return {
    ...cell,
    leading: createElement(CompanyLogoMark, { symbol: subject.symbol, assetCategory: subject.assetCategory, name: subject.name ?? cell.text }),
  };
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
      fallbackWhileLoading
      style={{
        width: cellWidthPx * width,
        height: cellHeightPx * height,
        flexShrink: 0,
        ...style,
      }}
    >
      {/* Without a logo, or until it loads, the initial fills the same tile, so the header keeps its shape. */}
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

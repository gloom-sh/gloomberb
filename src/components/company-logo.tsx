import { createElement } from "react";
import { Box, ImageSurface, Text, TextAttributes, useUiCapabilities } from "../ui";
import { cloudLogoPath, type CloudLogoKind } from "../api-client/paths";
import { getCloudApiBaseUrl } from "../api-client/request";
import { resolveAssetDisplayKind } from "../market-data/market/format";
import { colors } from "../theme/colors";
import type { DataTableCell } from "./ui/data-table";
import { LogoMark, type LogoMarkProps } from "./ui/logo-mark";
import { canonicalExchange, canonicalTickerKey, isUsEquityExchange } from "../utils/exchanges";
import { tickerHasListingSuffix } from "../sources/listing-symbols";

/**
 * A company's listing as the logo service knows it: one abroad by its venue
 * (BA on LSE is BA:LSE, BAE Systems, never BA, Boeing), a US listing, a
 * broker's SMART routing and a vendor's suffixed symbol (BA.L) as written.
 */
function logoListing(symbol: string, exchange: string | undefined): string {
  if (!exchange || symbol.includes(":") || tickerHasListingSuffix(symbol)) return symbol;
  const venue = canonicalExchange(exchange);
  return !venue || venue === "SMART" || isUsEquityExchange(venue) ? symbol : canonicalTickerKey(symbol, venue);
}

export function resolveCompanyLogoSrc(input: {
  symbol: string;
  assetCategory?: string;
  /** The listing's venue, so a symbol a US company also uses draws its own company's logo. */
  exchange?: string;
}): string | null {
  const kind = logoKindForAsset(input.assetCategory);
  if (!kind) return null;
  const path = cloudLogoPath(kind, kind === "ticker" ? logoListing(input.symbol, input.exchange) : input.symbol);
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
  exchange,
  name,
  width = 5,
  height = 2,
  style,
}: {
  symbol: string;
  assetCategory?: string;
  /** The listing's venue (resolveCompanyLogoSrc). */
  exchange?: string;
  name?: string;
  width?: number;
  height?: number;
  /** Desktop placement in px, such as the gap to the text beside it. */
  style?: { marginTop?: number; marginRight?: number };
}) {
  const { nativePaneChrome, cellWidthPx = 8, cellHeightPx = 18 } = useUiCapabilities();
  const src = nativePaneChrome === true ? resolveCompanyLogoSrc({ symbol, assetCategory, exchange }) : null;
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
      {/* Without a logo, or until it loads, the initial fills the same tile, so the header keeps its shape. It is the company's, as LogoMark's is, so a code like 0700 is not a 0. */}
      <Box width="100%" height="100%" bg={colors.border} alignItems="center" justifyContent="center">
        <Text
          fg={colors.text}
          attributes={TextAttributes.BOLD}
          style={{ fontSize: Math.round(cellHeightPx * height * 0.4) }}
        >
          {(name?.trim() || symbol.trim()).charAt(0).toUpperCase() || "?"}
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

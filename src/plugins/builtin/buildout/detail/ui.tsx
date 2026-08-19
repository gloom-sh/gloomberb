import type { ReactNode } from "react";
import { Box, Text, TextAttributes } from "../../../../ui";
import { Button, TickerBadgeList } from "../../../../components";
import { ExternalLinkText } from "../../../../components/ui/external-link";
import { MarkdownText } from "../../../../components/markdown-text";
import { colors } from "../../../../theme/colors";
import type { InlineTickerCatalogEntry } from "../../../../state/hooks/inline-tickers";
import type { BuildoutCompany, BuildoutRelatedCompany, BuildoutSource } from "../model/types";
import { domainFromUrl, text, textOrNull, tickerSymbol, truncate } from "../format";

export type InlineTickerCatalog = Record<string, InlineTickerCatalogEntry>;

export type DetailSpec = {
  label: string;
  value?: string | null;
  color?: string;
};

export function DetailSpecGrid({ items, width, marginTop = 1 }: { items: DetailSpec[]; width: number; marginTop?: number }) {
  const visibleItems = items.filter((item) => textOrNull(item.value) != null);
  if (visibleItems.length === 0) return null;

  const columnCount = width >= 110 ? 4 : width >= 78 ? 3 : width >= 52 ? 2 : 1;
  const columnWidth = Math.max(18, Math.floor(width / columnCount));
  const rows: DetailSpec[][] = [];
  for (let index = 0; index < visibleItems.length; index += columnCount) {
    rows.push(visibleItems.slice(index, index + columnCount));
  }

  return (
    <Box marginTop={marginTop} flexDirection="column">
      {rows.map((row, rowIndex) => (
        <Box key={rowIndex} flexDirection="row" height={1} width={width} overflow="hidden">
          {row.map((item) => {
            const labelWidth = Math.min(Math.max(item.label.length + 2, 8), Math.max(8, Math.floor(columnWidth * 0.45)));
            const valueWidth = Math.max(0, columnWidth - labelWidth);
            const labelText = truncate(`${item.label}:`, Math.max(0, labelWidth - 1)).padEnd(labelWidth);
            return (
              <Box key={item.label} flexDirection="row" width={columnWidth} height={1} overflow="hidden">
                <Text fg={colors.textMuted}>{labelText}</Text>
                <Text fg={item.color ?? colors.text}>{truncate(text(item.value, ""), valueWidth)}</Text>
              </Box>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

export function MetaBadge({ label, tone = "neutral" }: { label?: string | null; tone?: "neutral" | "warning" }) {
  const value = textOrNull(label);
  if (!value) return null;
  const accent = tone === "warning" ? colors.warning : colors.borderFocused;
  return (
    <Box backgroundColor={accent} paddingX={1} height={1}>
      <Text fg={colors.bg} attributes={TextAttributes.BOLD}>{value.toUpperCase()}</Text>
    </Box>
  );
}

export function InlineSources({ domains, width }: { domains: readonly string[]; width: number }) {
  if (domains.length === 0) return null;
  const label = "Sources: ";
  return (
    <Box marginTop={1} flexDirection="row" width={width} height={1} overflow="hidden">
      <Text fg={colors.textMuted}>{label}</Text>
      <Text fg={colors.textDim}>{truncate(domains.join(", "), Math.max(0, width - label.length))}</Text>
    </Box>
  );
}

export function DetailSection({
  title,
  width,
  children,
}: {
  title: string;
  width: number;
  children: ReactNode;
}) {
  return (
    <Box marginTop={1} flexDirection="column" width={width}>
      <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{truncate(title, width)}</Text>
      {children}
    </Box>
  );
}

export function DetailListLine({
  label,
  values,
  width,
}: {
  label: string;
  values: readonly string[];
  width: number;
}) {
  if (values.length === 0) return null;
  const prefix = `${label}: `;
  return (
    <Box flexDirection="row" width={width} height={1} overflow="hidden">
      <Text fg={colors.textMuted}>{prefix}</Text>
      <Text fg={colors.textDim}>{truncate(values.join(", "), Math.max(0, width - prefix.length))}</Text>
    </Box>
  );
}

export function RelatedCompaniesLine({
  label,
  companies,
  width,
}: {
  label: string;
  companies: readonly BuildoutRelatedCompany[] | undefined;
  width: number;
}) {
  const items = companies ?? [];
  if (items.length === 0) return null;

  const visible = items.slice(0, 8);
  const symbols = visible
    .map((company) => tickerSymbol(company.ticker))
    .filter((symbol): symbol is string => symbol != null);
  const names = visible
    .filter((company) => !tickerSymbol(company.ticker))
    .map((company) => textOrNull(company.name))
    .filter((name): name is string => name != null);
  const overflow = items.length > visible.length ? ` +${items.length - visible.length}` : "";
  const prefix = `${label}: `;
  const badgeWidth = Math.min(Math.max(0, width - prefix.length - (names.length > 0 ? 1 : 0)), Math.max(0, symbols.length * 9));
  return (
    <Box flexDirection="row" width={width} height={1} overflow="hidden">
      <Text fg={colors.textMuted}>{prefix}</Text>
      {symbols.length > 0 ? (
        <TickerBadgeList
          symbols={symbols}
          width={badgeWidth}
          fallbackColor={colors.textBright}
        />
      ) : null}
      <Text fg={colors.textDim}>
        {truncate(`${names.length > 0 ? names.join(", ") : ""}${overflow}`, Math.max(0, width - prefix.length - badgeWidth))}
      </Text>
    </Box>
  );
}

export function SourceDetailLines({
  sources,
  width,
  maxItems = 3,
}: {
  sources: readonly BuildoutSource[] | undefined;
  width: number;
  maxItems?: number;
}) {
  const entries = (sources ?? [])
    .flatMap((source) => {
      const flatUrl = source.url;
      const flatTitle = source.title ?? source.snippet ?? source.reasoning;
      const flat = flatUrl || flatTitle
        ? [{
          url: flatUrl ?? null,
          domain: source.domain ?? domainFromUrl(flatUrl) ?? null,
          title: flatTitle,
          note: source.reasoning ?? source.snippet,
          tier: source.tier,
        }]
        : [];
      const citations = (source.citations ?? []).map((citation) => ({
        url: citation.url ?? null,
        domain: domainFromUrl(citation.url) ?? null,
        title: citation.title ?? citation.excerpts?.[0] ?? null,
        note: citation.excerpts?.[0] ?? null,
        tier: source.tier,
      }));
      return [...flat, ...citations];
    })
    .filter((entry) => textOrNull(entry.domain ?? entry.title ?? entry.note) != null)
    .slice(0, maxItems);

  if (entries.length === 0) return null;
  return (
    <Box marginTop={1} flexDirection="column" width={width}>
      {entries.map((entry, index) => {
        const prefix = entry.domain ? `${entry.domain}${entry.tier ? ` T${entry.tier}` : ""}` : "";
        const body = entry.title ?? entry.note ?? "";
        const bodyText = truncate(prefix ? `: ${body}` : body, Math.max(0, width - prefix.length));
        return (
          <Box key={`${entry.domain ?? "source"}:${index}`} flexDirection="row" height={1} width={width} overflow="hidden">
            {prefix ? (
              entry.url ? (
                <ExternalLinkText url={entry.url} label={prefix} color={colors.textMuted} />
              ) : (
                <Text fg={colors.textMuted}>{prefix}</Text>
              )
            ) : null}
            <Text fg={colors.textMuted}>{bodyText}</Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function MarkdownBlock({
  text: markdown,
  width,
  catalog,
  openTicker,
  marginTop = 1,
}: {
  text?: string | null;
  width: number;
  catalog: InlineTickerCatalog;
  openTicker: (symbol: string) => void;
  marginTop?: number;
}) {
  if (!markdown) return null;
  return (
    <Box marginTop={marginTop}>
      <MarkdownText
        text={markdown}
        lineWidth={width}
        textColor={colors.textDim}
        catalog={catalog}
        openTicker={openTicker}
      />
    </Box>
  );
}

export function CompaniesUpgradeCta({
  hiddenCount,
  width,
  busy,
  message,
  onUpgrade,
}: {
  hiddenCount: number;
  width: number;
  busy: boolean;
  message: string | null;
  onUpgrade: () => void;
}) {
  if (hiddenCount <= 0) return null;
  const noun = hiddenCount === 1 ? "company" : "companies";
  const contentWidth = Math.max(20, width - 2);
  const title = truncate(`${hiddenCount} more ${noun} available`, contentWidth).padEnd(contentWidth);
  const subtitle = truncate("Upgrade to unlock the full list and company profiles under $10B market cap.", contentWidth).padEnd(contentWidth);
  const note = (message ? truncate(message, contentWidth) : "").padEnd(contentWidth);
  return (
    <Box
      flexDirection="column"
      height={message ? 6 : 5}
      width="100%"
      paddingX={1}
      backgroundColor={colors.panel}
      overflow="hidden"
    >
      <Box height={1} width="100%" backgroundColor={colors.panel}>
        <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{title}</Text>
      </Box>
      <Box height={1} width="100%" backgroundColor={colors.panel}>
        <Text fg={colors.textDim}>{subtitle}</Text>
      </Box>
      <Box height={1} width="100%" backgroundColor={colors.panel} />
      <Box flexDirection="row" height={1} width="100%" backgroundColor={colors.panel}>
        <Button
          label={busy ? "Opening..." : "Upgrade to Pro"}
          variant="primary"
          disabled={busy}
          onPress={onUpgrade}
        />
      </Box>
      {message ? (
        <Box height={1} width="100%" backgroundColor={colors.panel}>
          <Text fg={colors.warning}>{note}</Text>
        </Box>
      ) : null}
    </Box>
  );
}

export function tickerBadges({
  symbols,
  width,
  fallbackColor,
}: {
  symbols: readonly string[];
  width: number;
  fallbackColor?: string;
}) {
  if (symbols.length === 0) return null;
  return (
    <TickerBadgeList
      symbols={symbols}
      width={width}
      fallbackColor={fallbackColor}
    />
  );
}

export function FavoriteCell({
  starred,
  busy,
  selected,
  interactive = false,
  onPress,
}: {
  starred: boolean;
  busy: boolean;
  selected: boolean;
  interactive?: boolean;
  onPress?: () => void;
}) {
  const color = selected
    ? colors.selectedText
    : busy ? colors.textMuted : starred ? colors.warning : colors.textMuted;
  return (
    <Box
      width={2}
      height={1}
      style={{ cursor: interactive && !busy ? "pointer" : "default" }}
      onMouseDown={onPress ? (event: any) => {
        event.preventDefault?.();
        event.stopPropagation?.();
        if (!busy) onPress();
      } : undefined}
    >
      <Text fg={color} attributes={starred ? TextAttributes.BOLD : TextAttributes.NONE} selectable={false}>
        {busy ? "*" : starred ? "★" : "☆"}
      </Text>
    </Box>
  );
}

export function CompanyCell({
  company,
  width,
  selected,
}: {
  company: BuildoutCompany;
  width: number;
  selected: boolean;
}) {
  const symbol = tickerSymbol(company.ticker);
  if (!symbol) {
    return <Text fg={selected ? colors.selectedText : colors.text}>{truncate(company.name, width)}</Text>;
  }
  const badgeWidth = Math.min(11, width);
  return (
    <Box flexDirection="row" width={width} height={1} overflow="hidden">
      <TickerBadgeList
        symbols={[symbol]}
        width={badgeWidth}
        fallbackColor={selected ? colors.selectedText : colors.textBright}
      />
      <Text fg={selected ? colors.selectedText : colors.text}>
        {truncate(company.name, Math.max(0, width - badgeWidth))}
      </Text>
    </Box>
  );
}

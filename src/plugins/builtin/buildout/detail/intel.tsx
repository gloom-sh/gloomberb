import { Badge } from "../../../../components";
import { RemoteImage } from "../../../../components/ui";
import { colors } from "../../../../theme/colors";
import { Box, Text } from "../../../../ui";
import { dateDetail, intelSourceDomains, tickerSymbol } from "../format";
import type { BuildoutRow } from "../model/types";
import { InlineSources, MarkdownBlock, tickerBadges, type InlineTickerCatalog } from "./ui";

type BuildoutIntel = Extract<BuildoutRow, { kind: "intel" }>["item"];

export function IntelDetail({
  item,
  bodyWidth,
  height,
  catalog,
  openTicker,
}: {
  item: BuildoutIntel;
  bodyWidth: number;
  height: number;
  catalog: InlineTickerCatalog;
  openTicker: (symbol: string) => void;
}) {
  return (
    <>
      <Box flexDirection="row" height={1} gap={1} overflow="hidden">
        {item.type?.trim() && <Badge label={item.type.trim().toUpperCase()} tone="accent" variant="solid" />}
        {item.publishedAt ? <Text fg={colors.textDim}>{dateDetail(item.publishedAt)}</Text> : null}
      </Box>
      {(item.companies?.length ?? 0) > 0 && (
        <Box marginTop={1} height={1}>
          {tickerBadges({
            symbols: item.companies!.map((company) => tickerSymbol(company.ticker) ?? "").filter(Boolean),
            width: Math.min(bodyWidth, 56),
          })}
        </Box>
      )}
      {item.imageUrl ? (
        <Box marginTop={1}>
          <RemoteImage
            src={item.imageUrl}
            alt={item.headline}
            width={Math.min(bodyWidth, 96)}
            height={Math.max(6, Math.min(16, Math.floor(height / 3)))}
            label="image"
          />
        </Box>
      ) : null}
      <MarkdownBlock text={item.context ?? item.content} width={bodyWidth} catalog={catalog} openTicker={openTicker} />
      {item.context && item.content && item.context !== item.content
        ? <MarkdownBlock text={item.content} width={bodyWidth} catalog={catalog} openTicker={openTicker} />
        : null}
      <InlineSources domains={intelSourceDomains(item)} width={bodyWidth} />
    </>
  );
}

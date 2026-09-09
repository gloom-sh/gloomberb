import type { ReactNode } from "react";
import { Section } from "../../../../components";
import { colors } from "../../../../theme/colors";
import { Box, Text } from "../../../../ui";
import { activityColor, activityLabel, dateShort, sourceDomains, truncate } from "../format";
import type { BuildoutSite } from "../model/types";
import { SiteSatelliteImages } from "./satellite-images";
import { DetailSpecGrid, InlineSources, MarkdownBlock, SourceDetailLines, tickerBadges, type InlineTickerCatalog } from "./ui";
import { booleanText, dateCell, metadataSpecs, reportSectionText } from "./values";

export function SiteDetail({
  site,
  bodyWidth,
  height,
  catalog,
  openTicker,
  favoriteToggle,
}: {
  site: BuildoutSite;
  bodyWidth: number;
  height: number;
  catalog: InlineTickerCatalog;
  openTicker: (symbol: string) => void;
  favoriteToggle: ReactNode;
}) {
  const sourceList = [...(site.discoverySources ?? []), ...(site.projectReportSources ?? [])];
  const specs = metadataSpecs(site.siteMetadata);

  return (
    <>
      {favoriteToggle || site.ownerTicker ? (
        <Box flexDirection="row" height={1} gap={1}>
          {favoriteToggle}
          {site.ownerTicker ? tickerBadges({
            symbols: [site.ownerTicker],
            width: Math.min(bodyWidth - (favoriteToggle ? 3 : 0), 16),
          }) : null}
        </Box>
      ) : null}
      <DetailSpecGrid
        width={bodyWidth}
        items={[
          { label: "Type", value: site.type },
          { label: "Owner", value: site.ownerName ?? site.ownerTicker },
          { label: "Location", value: [site.location?.city, site.location?.country].filter(Boolean).join(", ") },
          { label: "Address", value: site.address },
          { label: "Park", value: site.parkName },
          { label: "Power/Cap", value: site.powerCapacity },
          { label: "ETA", value: site.eta },
          { label: "Area", value: site.areaKm2 },
          { label: "Boundary", value: booleanText(site.boundaryConfirmed) },
          { label: "Construction", value: site.constructionActivity == null ? null : activityLabel(site.constructionActivity), color: activityColor(site.constructionActivity, false) },
          { label: "Parking", value: site.parkingActivity == null ? null : activityLabel(site.parkingActivity), color: activityColor(site.parkingActivity, false) },
          { label: "Last Sat", value: dateCell(site.latestCapture) },
          { label: "Activity At", value: dateCell(site.activityUpdatedAt) },
          { label: "Enriched", value: dateCell(site.lastEnrichedAt) },
        ]}
      />
      <InlineSources domains={sourceDomains(sourceList)} width={bodyWidth} />
      <SourceDetailLines sources={sourceList} width={bodyWidth} />
      <MarkdownBlock text={site.description} width={bodyWidth} catalog={catalog} openTicker={openTicker} />
      <SiteSatelliteImages site={site} width={bodyWidth} height={height} />
      {(site.observations?.length ?? 0) > 0 ? (
        <Section title="Recent Captures" width={bodyWidth}>
          {site.observations!.slice(0, 8).map((observation, index) => {
            const bounds = observation.captureBounds?.minLat != null && observation.captureBounds?.minLng != null
              ? `${observation.captureBounds.minLat.toFixed(3)}, ${observation.captureBounds.minLng.toFixed(3)}`
              : null;
            return (
              <Text key={observation.id ?? index} fg={colors.textMuted}>
                {truncate([
                  dateShort(observation.captureDate),
                  observation.observationSource,
                  observation.note,
                  bounds,
                ].filter(Boolean).join(" - "), bodyWidth)}
              </Text>
            );
          })}
        </Section>
      ) : null}
      {specs.length > 0 ? (
        <Section title="Specs" width={bodyWidth}>
          <DetailSpecGrid width={bodyWidth} marginTop={0} items={specs} />
        </Section>
      ) : null}
      {(site.projectReportSections?.length ?? 0) > 0 ? (
        <Section title="Project Report" width={bodyWidth}>
          {site.projectReportSections!.map((section, index) => (
            <Box key={`${section.title ?? "section"}:${index}`} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
              {section.title ? <Text fg={colors.textDim}>{section.title}</Text> : null}
              <MarkdownBlock text={reportSectionText(section)} width={bodyWidth} catalog={catalog} openTicker={openTicker} marginTop={0} />
            </Box>
          ))}
        </Section>
      ) : null}
      {site.researchReport ? (
        <Section title="Research" width={bodyWidth}>
          <MarkdownBlock text={site.researchReport} width={bodyWidth} catalog={catalog} openTicker={openTicker} marginTop={0} />
        </Section>
      ) : null}
      {(site.builders?.length ?? 0) > 0 ? (
        <Section title="Involved Companies" width={bodyWidth}>
          {site.builders!.slice(0, 12).map((builder, index) => (
            <Box key={`${builder.companyName}-${index}`} flexDirection="column" marginTop={index === 0 ? 0 : 1}>
              <Box flexDirection="row" height={1}>
                {builder.companyTicker
                  ? tickerBadges({
                    symbols: [builder.companyTicker],
                    width: Math.min(12, bodyWidth),
                  })
                  : null}
                <Text fg={colors.textMuted}>
                  {truncate(`${builder.companyName ?? "Company"}${builder.role ? ` - ${builder.role}` : ""}`, Math.max(0, bodyWidth - (builder.companyTicker ? 12 : 0)))}
                </Text>
              </Box>
              <MarkdownBlock text={builder.summary} width={bodyWidth} catalog={catalog} openTicker={openTicker} marginTop={0} />
            </Box>
          ))}
        </Section>
      ) : null}
    </>
  );
}

import { useState } from "react";
import { ActionRow, KeyValueRow, PaneLinkMenu, SectionHeading, usePaneLinkMenuEntry } from "../../../../components";
import { tf } from "../../../../i18n";
import { ahPairOf } from "../../../../market-data/ah-pair";
import { ratioCount } from "../../../../market-data/depositary-pair";
import { hongKongListingCode, listingSuffixVenue } from "../../../../sources/listing-symbols";
import type { IssuerListing, IssuerListings } from "../../../../types/issuer-listings";
import { Box } from "../../../../ui";
import { canonicalExchange, canonicalTickerKey, isUsListingExchange, parsePublicTickerKey } from "../../../../utils/exchanges";
import { useOpenDescription } from "../../shared/open-description";

export function otherListings(issuer: IssuerListings, symbol: string, exchange?: string | null) {
  const asked = parsePublicTickerKey(symbol);
  const venue = asked.exchange ?? canonicalExchange(exchange ?? "");
  const suffix = listingSuffixVenue(asked.symbol, venue);
  const code = hongKongListingCode(suffix?.symbol ?? asked.symbol, venue || suffix?.exchange || "");
  const askedVenue = venue || suffix?.exchange;
  const lineKey = (line: IssuerListing) => canonicalTickerKey(line.symbol, line.exchange);
  const candidates = issuer.listings.filter(line => askedVenue
    ? canonicalExchange(line.exchange) === askedVenue
    : isUsListingExchange(line.exchange));
  const aliases = candidates.filter(line => parsePublicTickerKey(line.symbol).symbol.replace(/[-/]/g, ".") === code.replace(/[-/]/g, "."));
  const own = issuer.listings.find(line => line.symbol === issuer.requestedSymbol)
    ?? candidates.find(line => parsePublicTickerKey(line.symbol).symbol === asked.symbol)
    ?? candidates.find(line => parsePublicTickerKey(line.symbol).symbol === code)
    ?? (aliases.length === 1 ? aliases[0] : undefined);
  if (!own) return [];
  const ah = ahPairOf(issuer);
  const rows = issuer.listings.filter(line => line !== own).map(line => {
    const target = lineKey(line);
    let role = line.primary ? "Primary listing" : "Listing";
    let rank = line.primary ? 1 : line.exchange === own.exchange && !line.directoryOnly ? 2 : 6;
    let ratio = line.sharesPerReceipt;
    if (own.underlyingIsin && own.underlyingIsin === line.isin) {
      role = "Underlying"; rank = line.primary ? 0 : 4; ratio = own.sharesPerReceipt;
    } else if (ah && (target === ah.h || target === ah.a)) {
      role = target === ah.h ? "H Share" : "A Share"; rank = 0;
    } else if (own.isin && own.isin === line.isin) {
      role = "Same security"; rank = line.primary ? 1 : line.directoryOnly ? 5 : 3;
    } else if (line.depositary) {
      role = "Receipt"; rank = isUsListingExchange(line.exchange) || line.exchange === "OTC" ? 2 : 5;
    }
    const detail = ratio != null ? tf(ratio === 1 ? "{count} share per receipt" : "{count} shares per receipt", { count: ratioCount(ratio) }) : undefined;
    return { target, role, detail, rank, isin: line.isin };
  });
  // Show each share class or receipt before additional venues for that same security.
  const seen = new Set<string>();
  const unique = [], additional = [];
  for (const row of rows.sort((a, b) => a.rank - b.rank)) {
    if (row.isin && seen.has(row.isin)) additional.push(row);
    else unique.push(row);
    if (row.isin) seen.add(row.isin);
  }
  return [...unique, ...additional];
}

function MoreListings({ expanded, count, toggle }: { expanded: boolean; count: number; toggle: () => void }) {
  const label = expanded ? "Show fewer listings" : tf(count === 1 ? "Show {count} more listing" : "Show {count} more listings", { count });
  usePaneLinkMenuEntry("more-listings", label, toggle);
  return <ActionRow label={label} expanded={expanded} onPress={toggle} />;
}

export function RelatedListings({ issuer, symbol, exchange }: { issuer: IssuerListings; symbol: string; exchange?: string | null }) {
  const open = useOpenDescription();
  const [expanded, setExpanded] = useState(false);
  const rows = otherListings(issuer, symbol, exchange);
  if (!rows.length) return null;
  return <Box flexDirection="column">
    <SectionHeading title="Related listings" />
    <PaneLinkMenu>
      {(expanded ? rows : rows.slice(0, 3)).map(({ target, role, detail }) => (
        <KeyValueRow key={target} label={role} value={target} detail={detail} labelWidth={16}
          link={{ label: tf("Open {ticker}", { ticker: target }), onOpen: () => open(target) }} />
      ))}
      {rows.length > 3 && <MoreListings expanded={expanded} count={rows.length - 3} toggle={() => setExpanded(value => !value)} />}
    </PaneLinkMenu>
  </Box>;
}

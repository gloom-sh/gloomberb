import { expect, test } from "bun:test";
import type { IssuerListing, IssuerListings } from "../../../../types/issuer-listings";
import { otherListings } from "./related-listings";

const line = (symbol: string, exchange: string, facts: Partial<IssuerListing> = {}): IssuerListing => ({
  symbol, exchange, name: symbol, primary: false, ...facts,
});
const issuer = (...listings: IssuerListing[]): IssuerListings => ({ issuer: "company", name: "Company", country: "CA", listings });

test("keep the same code on another venue and the other classes, including for a saved class alias", () => {
  const company = issuer(line("RCI.B:TSX", "TSX"), line("RCI", "NYSE"), line("RCI:TSX", "TSX"), line("RCI.A:TSX", "TSX"));
  const links = (symbol: string, venue: string) => otherListings(company, symbol, venue).map(row => row.target);
  expect(links("RCI-B", "XTSE").sort()).toEqual(["RCI.A:TSX", "RCI:NYSE", "RCI:TSX"]);
  expect(links("RCI", "NYSE")).toContain("RCI:TSX");
  expect(links("RCI:TSX", "NYSE")).toContain("RCI:NYSE");
  expect(links("RCI.B", "NASDAQ")).toEqual([]);
});

test("an extra Hong Kong currency counter keeps the A/H link, including on a five-digit saved code", () => {
  const byd = issuer(line("002594:SZSE", "SZSE"), line("1211:HKEX", "HKEX"), line("81211:HKEX", "HKEX", { directoryOnly: true }));
  expect(otherListings(byd, "002594", "XSHE")[0]).toMatchObject({ role: "H Share", target: "1211:HKEX" });
  expect(otherListings(byd, "01211", "SEHK")[0]).toMatchObject({ role: "A Share", target: "002594:SZSE" });
});

test("a receipt opens its actual underlying with its own ratio and distinguishes a different receipt", () => {
  const sk = issuer(line("000660:KRX", "KRX", { isin: "ordinary", primary: true }),
    line("HY9H:FWB2", "FWB2", { isin: "gdr", depositary: true, underlyingIsin: "ordinary", sharesPerReceipt: 1 }),
    line("SKHY", "NASDAQ", { isin: "adr", depositary: true, underlyingIsin: "ordinary", sharesPerReceipt: 0.1 }));
  const rows = otherListings(sk, "HY9H.F", "XFRA");
  expect(rows[0]).toMatchObject({ target: "000660:KRX", role: "Underlying", detail: "1 share per receipt" });
  expect(rows[1]).toMatchObject({ target: "SKHY:NASDAQ", role: "Receipt", detail: "0.1 shares per receipt" });
});

test("a provider venue alias uses the resolved listing and keeps other venues of the same security", () => {
  const group = issuer(line("NPN:JSE", "JSE"), line("NPSNY:OTC", "OTC"));
  group.requestedSymbol = "NPSNY:OTC";
  expect(otherListings(group, "NPSNY", "OTC MARKETS OTCPK").map(row => row.target)).toEqual(["NPN:JSE"]);
});

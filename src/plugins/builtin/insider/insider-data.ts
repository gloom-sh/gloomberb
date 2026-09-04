
export interface InsiderTransaction {
  filingDate: Date;
  reportedName: string;
  title: string;
  transactionType: "P" | "S" | "A" | "D" | "";
  shares: number;
  pricePerShare: number | null;
  totalValue: number | null;
  sharesOwned: number | null;
  form: string;
}

export function parseForm4Xml(xml: string): InsiderTransaction | null {
  const nameMatch = xml.match(/<rptOwnerName>([^<]+)<\/rptOwnerName>/);
  if (!nameMatch) return null;

  const titleMatch = xml.match(/<officerTitle>([^<]+)<\/officerTitle>/);
  const codeMatch = xml.match(/<transactionCode>([^<]+)<\/transactionCode>/);
  const sharesMatch = xml.match(/<transactionShares>[\s\S]*?<value>([^<]+)<\/value>/);
  const priceMatch = xml.match(/<transactionPricePerShare>[\s\S]*?<value>([^<]+)<\/value>/);
  const ownedMatch = xml.match(/<sharesOwnedFollowingTransaction>[\s\S]*?<value>([^<]+)<\/value>/);
  const dateMatch = xml.match(/<transactionDate>[\s\S]*?<value>([^<]+)<\/value>/);

  const shares = sharesMatch ? parseFloat(sharesMatch[1]!) : 0;
  const price = priceMatch ? parseFloat(priceMatch[1]!) : null;
  const code = codeMatch?.[1] ?? "";

  return {
    filingDate: dateMatch ? new Date(dateMatch[1]!) : new Date(),
    reportedName: nameMatch[1]!.trim(),
    title: titleMatch?.[1]?.trim() ?? "",
    transactionType: (code === "P" || code === "S" || code === "A" || code === "D") ? code : "",
    shares: isNaN(shares) ? 0 : shares,
    pricePerShare: price !== null && !isNaN(price) ? price : null,
    totalValue: price !== null && !isNaN(price) && !isNaN(shares) ? shares * price : null,
    sharesOwned: ownedMatch ? parseFloat(ownedMatch[1]!) : null,
    form: "4",
  };
}

export function transactionTypeLabel(type: InsiderTransaction["transactionType"]): string {
  switch (type) {
    case "P": return "BUY";
    case "S": return "SELL";
    case "A": return "AWARD";
    case "D": return "DISPOSE";
    default: return "-";
  }
}

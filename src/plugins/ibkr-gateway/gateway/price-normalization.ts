import {
  normalizePriceValueByDivisor,
  resolveExchangeSubUnitCurrencyUnit,
} from "../../../utils/currency-units";

interface IbkrPriceContractLike {
  currency?: string;
  exchange?: string;
  primaryExch?: string;
  secType?: string;
}

interface IbkrPriceDetailsLike {
  priceMagnifier?: number;
  validExchanges?: string;
}

function normalizeIbkrExchange(value?: string): string {
  return (value ?? "").trim().toUpperCase();
}

function isSubUnitEligibleSecType(secType?: string): boolean {
  const normalized = normalizeIbkrExchange(secType);
  return normalized === "STK" || normalized === "ETF";
}

export function getIbkrPriceDivisor(
  contract: IbkrPriceContractLike,
  details?: IbkrPriceDetailsLike,
): number {
  if (!isSubUnitEligibleSecType(contract.secType)) return 1;

  const magnifier = details?.priceMagnifier;
  if (typeof magnifier === "number" && Number.isFinite(magnifier) && magnifier > 1) {
    return magnifier;
  }

  const validExchanges = details?.validExchanges
    ?.split(",")
    .map((exchange) => exchange.trim())
    .filter(Boolean) ?? [];
  const unit = resolveExchangeSubUnitCurrencyUnit(contract.currency, [
    contract.primaryExch,
    contract.exchange,
    ...validExchanges,
  ]);
  return unit.divisor;
}

export const normalizeIbkrPriceValue = normalizePriceValueByDivisor;

import { truncateWithEllipsis } from "../../../../utils/text-wrap";

interface ScreenerCandidate {
  symbol: string;
  exchange: string;
  reason: string;
}

export interface ParsedScreenerResponse {
  title: string | null;
  summary: string | null;
  tickers: ScreenerCandidate[];
}

export interface ValidatedScreenerResult {
  symbol: string;
  exchange: string;
  reason: string;
  resolvedName: string;
}

function tryParseJson(raw: string): unknown | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const candidates = [
    trimmed,
    trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim() ?? null,
  ].filter((candidate): candidate is string => !!candidate);

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next parse candidate
    }
  }
  return null;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function deriveScreenerTitle(prompt: string): string {
  const normalized = prompt
    .split(/\s+/)
    .join(" ")
    .trim();
  return truncateWithEllipsis(normalized || "New Screener", 22);
}

export function getScreenerPromptSignature(prompt: string, providerId: string, modelId?: string | null): string {
  return JSON.stringify([providerId.trim(), modelId?.trim() || null, prompt.trim()]);
}

export function matchesScreenerPromptSignature(
  signature: string | null,
  prompt: string,
  providerId: string,
  modelId?: string | null,
): boolean {
  if (signature === getScreenerPromptSignature(prompt, providerId, modelId)) return true;
  return !modelId?.trim() && signature === JSON.stringify([providerId.trim(), prompt.trim()]);
}

export function buildScreenerPrompt({
  currentDate,
  prompt,
}: {
  currentDate: string;
  prompt: string;
}): string {
  const lines = [
    `Today is ${currentDate}.`,
    "",
    "Find public-market tickers that match this screening prompt:",
    prompt.trim(),
    "",
    "Use the available Gloomberb data tools to validate every company before submitting it.",
    "",
  ];

  lines.push(
    "Submit the final structured screener result with an optional short title, an optional one-line summary, and the validated tickers.",
    "Rules:",
    "- Return at most 25 unique ticker candidates.",
    "- Use uppercase symbols.",
    "- `reason` must be concise and specific.",
    "- Include the exchange. For financial criteria, give the fiscal period, reporting currency, metric values and source in `reason`.",
    "- Do not treat unavailable data as a match or invent sources. State any unverified coverage in the summary.",
    "- Omit any company you cannot validate with confidence.",
  );

  return lines.join("\n");
}

export function parseScreenerResponse(raw: string): ParsedScreenerResponse {
  const parsed = tryParseJson(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("AI screener returned invalid JSON.");
  }

  const payload = parsed as Record<string, unknown>;
  const tickersRaw = Array.isArray(payload.tickers) ? payload.tickers : null;
  if (!tickersRaw) {
    throw new Error("AI screener JSON did not include a `tickers` array.");
  }
  if (tickersRaw.some((entry) => !entry || typeof entry !== "object"
    || !normalizeString((entry as Record<string, unknown>).symbol))) {
    throw new Error("AI screener returned malformed ticker candidates. Previous results are retained; retry the screen.");
  }

  const tickers = tickersRaw
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const candidate = entry as Record<string, unknown>;
      const symbol = normalizeString(candidate.symbol).toUpperCase();
      const exchange = normalizeString(candidate.exchange).toUpperCase();
      const reason = normalizeString(candidate.reason);
      if (!symbol) return null;
      return {
        symbol,
        exchange,
        reason: reason || "No reason provided.",
      } satisfies ScreenerCandidate;
    })
    .filter((entry): entry is ScreenerCandidate => entry != null)
    .slice(0, 25);

  return {
    title: normalizeString(payload.title) || null,
    summary: normalizeString(payload.summary) || null,
    tickers,
  };
}

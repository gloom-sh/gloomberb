import { loadingText } from "../../../components/ui/status";
import { formatRelativeTime } from "../../../utils/datetime-format";

export function briefFooterInfo(input: {
  loading?: boolean;
  error?: string | null;
  stale?: boolean;
  asOf?: string | null;
}): string {
  if (input.loading) return loadingText();
  const error = input.error?.trim();
  if (error) return error;
  if (input.asOf) return formatRelativeTime(input.asOf, Date.now(), "");
  return input.stale ? "" : "Live";
}

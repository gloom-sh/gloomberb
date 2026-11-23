import { useState } from "react";
import { useAgeClock } from "../../../react/auto-refresh";
import { usScannerSessionClosed } from "../shared/scanner-capture";

/** Whether the US market is shut by the calendar (`usScannerSessionClosed`), read again every half minute while the pane can be seen. */
export function useUsScannerSessionClosed(): boolean {
  const [mountedAt] = useState(Date.now);
  return usScannerSessionClosed(useAgeClock(mountedAt));
}

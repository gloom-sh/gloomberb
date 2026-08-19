import { Box } from "../../../ui";
import { Spinner } from "../../../components";

/** Shown until the first scanner payload arrives, so a live connection never reads as empty. */
export function ScannerWaitingState() {
  return (
    <Box paddingX={1} paddingY={1}>
      <Spinner label="Waiting for the scanner..." />
    </Box>
  );
}

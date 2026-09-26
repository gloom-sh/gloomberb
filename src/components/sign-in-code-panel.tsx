import { useMemo } from "react";
import { t } from "../i18n";
import { useAppLanguage } from "../i18n/react";
import { useShortcut } from "../react/input";
import { colors } from "../theme/colors";
import { Box, Text, TextAttributes, useUiHost, useRendererHost } from "../ui";
import { Button } from "./ui/button";
import { renderAsciiText } from "../ui/ascii-font";
import { renderQrLines, renderQrSvgDataUri } from "../ui/qr";
import { isPlainKey } from "../utils/keyboard";

// Phone cameras need dark-on-light no matter what the terminal theme is.
const QR_FG = "#000000";
const QR_BG = "#ffffff";

/**
 * A browser hand-off: button, QR code, short code, the URL, and a live status.
 * Used to sign in to Gloom and to connect a broker. Degrades by height: the QR
 * needs its full module grid, so short terminals drop decoration first and
 * finally fall back to the code plus URL, which works over SSH too.
 */
export function SignInCodePanel({
  url,
  code,
  status,
  height,
  shortcutScope,
}: {
  url: string | null;
  code: string | null;
  status: { text: string; color: string };
  /** Rows available to this panel; drives the degradation tiers. */
  height: number;
  /**
   * Scope for the browser key. A host that holds every key it does not use
   * (the sign-in gate) passes its own, so the key runs ahead of the hold.
   */
  shortcutScope: string;
}) {
  useAppLanguage();
  const renderer = useRendererHost();
  const desktop = useUiHost().kind === "desktop-web";
  // Cell lines still drive layout on desktop: they give the code its row/column
  // footprint, but the pixels come from the SVG below.
  const qrLines = useMemo(() => (url ? renderQrLines(url) : []), [url]);
  const qrImage = useMemo(() => (desktop && url ? renderQrSvgDataUri(url) : undefined), [desktop, url]);
  useShortcut((event) => {
    if (!isPlainKey(event, "b") || !url) return;
    event.preventDefault(); event.stopPropagation();
    void renderer.openExternal(url).catch(() => {});
  }, { scope: shortcutScope, phase: "before" });

  // Reserve the browser button before fitting the QR, code, and status.
  const contentHeight = height - (url ? 2 : 0);
  const showQr = qrLines.length > 0 && contentHeight >= qrLines.length + 2;
  const spacious = showQr && contentHeight >= qrLines.length + 8;
  const showUrl = !!url && (!showQr || contentHeight >= qrLines.length + 4);

  return (
    <Box flexDirection="column" alignItems="center">
      {url && <Box height={2}>
        <Button label="Continue in browser" shortcut="b" variant="primary" onPress={() => {
          void renderer.openExternal(url).catch(() => {});
        }} />
      </Box>}
      {showQr && (qrImage
        ? (
          <Box
            width={qrLines[0]?.length ?? 0}
            height={qrLines.length}
            style={{
              backgroundImage: qrImage,
              backgroundColor: QR_BG,
              backgroundSize: "contain",
              backgroundPosition: "center",
              backgroundRepeat: "no-repeat",
            }}
          />
        )
        : (
          <Box flexDirection="column" height={qrLines.length}>
            {qrLines.map((line, index) => (
              <Box key={index} height={1}>
                <Text fg={QR_FG} bg={QR_BG}>{line}</Text>
              </Box>
            ))}
          </Box>
        ))}
      {!showQr && url && (
        <Box height={1}>
          <Text fg={colors.textDim}>{t("Terminal is too short to draw the QR code.")}</Text>
        </Box>
      )}
      {code && (
        <>
          {spacious && <Box height={1} />}
          {spacious
            ? (
              <Box flexDirection="column" height={2}>
                {renderAsciiText(code, "tiny").map((line, index) => (
                  <Box key={index} height={1}>
                    <Text fg={colors.textBright}>{line}</Text>
                  </Box>
                ))}
              </Box>
            )
            : (
              <Box height={1}>
                <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{code}</Text>
              </Box>
            )}
        </>
      )}
      {showUrl && (
        <>
          {spacious && <Box height={1} />}
          <Box height={1}>
            <Text fg={colors.textMuted}>{url}</Text>
          </Box>
        </>
      )}
      {spacious && <Box height={1} />}
      <Box height={1}>
        <Text fg={status.color}>{status.text}</Text>
      </Box>
    </Box>
  );
}

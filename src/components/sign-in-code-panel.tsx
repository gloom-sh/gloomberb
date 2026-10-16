import { useMemo } from "react";
import { t } from "../i18n";
import { useAppLanguage } from "../i18n/react";
import { useShortcut } from "../react/input";
import { colors } from "../theme/colors";
import { Box, Text, TextAttributes, useUiCapabilities, useRendererHost } from "../ui";
import { Button } from "./ui/button";
import { FigureText } from "./ui/figure";
import { renderQrLines, renderQrSvgDataUri } from "../ui/qr";
import { isPlainKey } from "../utils/keyboard";

// Phone cameras need dark-on-light no matter what the terminal theme is.
const QR_FG = "#000000";
const QR_BG = "#ffffff";

/**
 * Desktop QR modules are whole pixels, about a quarter of a text row (4 px at
 * the default size), so the code scans from a phone held at reading distance
 * without filling the dialog. Fewer than 3 px and a camera struggles.
 */
const QR_MODULE_ROWS = 1 / 4.5;
const MIN_QR_MODULE_PX = 3;

/**
 * Desktop rows around the QR code: the browser button with the row under it,
 * the row between the code and what follows, the link, and the status with
 * the row above it. The code (a figure, about a row and a half) adds two.
 */
const DESKTOP_ROWS_BESIDE_QR = 6;
const DESKTOP_CODE_ROWS = 2;

/**
 * The pixel size of each QR module on the desktop: whole pixels, as large as
 * the default size allows within `availablePx`, or null when even the
 * smallest a camera reads does not fit.
 */
export function desktopQrModulePx(modules: number, availablePx: number, cellHeightPx: number): number | null {
  const target = Math.max(MIN_QR_MODULE_PX, Math.round(cellHeightPx * QR_MODULE_ROWS));
  const fits = Math.floor(availablePx / modules);
  const size = Math.min(target, fits);
  return size >= MIN_QR_MODULE_PX ? size : null;
}

interface SignInCodePanelProps {
  url: string | null;
  /**
   * A code to show under the QR code: Gloom's own sign-in compares it with
   * the page it opens. A broker connect shows none.
   */
  code: string | null;
  status: { text: string; color: string };
  /** Rows available to this panel; drives the degradation tiers. */
  height: number;
  /**
   * Scope for the browser key. A host that holds every key it does not use
   * (the sign-in gate) passes its own, so the key runs ahead of the hold.
   */
  shortcutScope: string;
  /** Whether `b` opens the link: a pane's panel takes it only while the pane has the keyboard. */
  browserKey?: boolean;
}

/**
 * A browser hand-off: button, QR code, an optional short code, the URL, and a
 * live status. Used to sign in to Gloom and to connect a broker. Degrades by
 * height: the QR needs its full module grid in the terminal, so short
 * terminals drop decoration first and finally fall back to the URL (and code),
 * which works over SSH too. The desktop draws the QR as an image in whole
 * pixel modules, smaller when the rows run out.
 */
export function SignInCodePanel(props: SignInCodePanelProps) {
  useAppLanguage();
  const renderer = useRendererHost();
  const desktop = useUiCapabilities().nativePaneChrome === true;
  const { url, shortcutScope, browserKey = true } = props;
  useShortcut((event) => {
    if (!isPlainKey(event, "b") || !url) return;
    event.preventDefault(); event.stopPropagation();
    void renderer.openExternal(url).catch(() => {});
  }, { scope: shortcutScope, phase: "before", enabled: browserKey });

  const button = url
    ? (
      <Button label="Continue in browser" shortcut="b" variant="primary" onPress={() => {
        void renderer.openExternal(url).catch(() => {});
      }} />
    )
    : null;
  return desktop
    ? <DesktopPanel {...props} button={button} />
    : <TerminalPanel {...props} button={button} />;
}

type PanelBodyProps = SignInCodePanelProps & { button: React.ReactNode };

/** Laid out by the browser: a QR image in whole-pixel modules, the code as a figure. */
function DesktopPanel({ url, code, status, height, button }: PanelBodyProps) {
  const { cellHeightPx = 18 } = useUiCapabilities();
  const qr = useMemo(() => (url ? renderQrSvgDataUri(url) : null), [url]);
  const besideQr = DESKTOP_ROWS_BESIDE_QR + (code ? DESKTOP_CODE_ROWS : 0);
  const modulePx = qr ? desktopQrModulePx(qr.modules, (height - besideQr) * cellHeightPx, cellHeightPx) : null;
  const qrPx = qr && modulePx ? modulePx * qr.modules : 0;

  return (
    <Box flexDirection="column" alignItems="center">
      {button}
      {qr && qrPx > 0 && (
        <Box
          marginTop={1}
          data-gloom-role="sign-in-qr"
          style={{
            // Exactly the code's own square, quiet zone included: no fill of
            // its own around it, and no scaling between whole pixels.
            width: qrPx,
            height: qrPx,
            backgroundImage: qr.image,
            backgroundSize: "100% 100%",
            backgroundRepeat: "no-repeat",
          }}
        />
      )}
      {url && !qrPx && (
        <Box marginTop={1}>
          <Text fg={colors.textDim}>{t("Not enough room to draw the QR code.")}</Text>
        </Box>
      )}
      {code && (
        <Box marginTop={1} data-gloom-role="sign-in-code">
          <FigureText>{code}</FigureText>
        </Box>
      )}
      {url && (
        <Box marginTop={code ? 0 : 1} maxWidth="100%">
          <Text fg={colors.textMuted} wrapText selectable style={{ textAlign: "center" }}>{url}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text fg={status.color}>{status.text}</Text>
      </Box>
    </Box>
  );
}

/** Laid out in cells: half-block QR lines need their full grid, so short terminals drop rows first. */
function TerminalPanel({ url, code, status, height, button }: PanelBodyProps) {
  const qrLines = useMemo(() => (url ? renderQrLines(url) : []), [url]);
  // Reserve the browser button before fitting the QR, code, and status.
  const contentHeight = height - (url ? 2 : 0);
  const codeRows = code ? 1 : 0;
  const showQr = qrLines.length > 0 && contentHeight >= qrLines.length + codeRows + 1;
  const qrRows = showQr ? qrLines.length : 0;
  // A blank row before the code, the link and the status when there is room.
  const spacious = showQr && contentHeight >= qrRows + codeRows * 2 + (url ? 2 : 0) + 2;
  const showUrl = !!url && (!showQr || spacious || contentHeight >= qrRows + codeRows + 2);

  return (
    <Box flexDirection="column" alignItems="center">
      {button && <Box height={2}>{button}</Box>}
      {showQr && (
        <Box flexDirection="column" height={qrLines.length}>
          {qrLines.map((line, index) => (
            <Box key={index} height={1}>
              <Text fg={QR_FG} bg={QR_BG}>{line}</Text>
            </Box>
          ))}
        </Box>
      )}
      {!showQr && url && (
        <Box height={1}>
          <Text fg={colors.textDim}>{t("Not enough room to draw the QR code.")}</Text>
        </Box>
      )}
      {code && (
        <>
          {spacious && <Box height={1} />}
          <Box height={1}>
            <Text fg={colors.textBright} attributes={TextAttributes.BOLD}>{code}</Text>
          </Box>
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

import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient, type AuthUser } from "../api-client";
import { Button } from "../components/ui/button";
import { useShortcut } from "../react/input";
import { Box, Text } from "../ui";
import { colors } from "../theme/colors";
import { isPlainKey } from "../utils/keyboard";

const RESEND_COOLDOWN_MS = 60_000;
const SENT = "Confirmation link sent. Check your inbox and spam folder.";
/** When this app last sent the link, so reopening the panel inside the cooldown sends no second one. */
let lastSentAt = 0;

function cooldownLeft(now = Date.now()): number {
  return Math.max(0, lastSentAt + RESEND_COOLDOWN_MS - now);
}

/** Forgets the last send, for a test that opens the panel more than once. */
export function resetVerificationCooldownForTests(): void {
  lastSentAt = 0;
}

/**
 * Shared continuation after email signup in the terminal and browser, and
 * what a press of "verify your email" or a wall's resend opens later on.
 */
export function CloudVerificationPanel({ onVerified, onContinueFree, sendOnOpen = false }: {
  onVerified: (user: AuthUser) => void;
  onContinueFree: () => void;
  /** Opened by a press that asks for the link again: send it once, unless one just went out. */
  sendOnOpen?: boolean;
}) {
  const [status, setStatus] = useState(() => cooldownLeft() > 0 && sendOnOpen
    ? SENT
    : "Check your inbox and spam folder. This page continues automatically.");
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(() => cooldownLeft() > 0);
  const completed = useRef(false);
  const callback = useRef(onVerified);
  callback.current = onVerified;
  const check = useCallback(async () => {
    try {
      const user = await apiClient.getSession();
      if (user?.emailVerified && !completed.current) {
        completed.current = true;
        callback.current(user);
      }
    } catch { setStatus("Connection interrupted. Check again when you're online."); }
  }, []);
  useEffect(() => {
    void check();
    const timer = setInterval(() => { void check(); }, 5000);
    return () => clearInterval(timer);
  }, [check]);
  useEffect(() => {
    if (!cooldown) return;
    const timer = setTimeout(() => setCooldown(false), cooldownLeft() || RESEND_COOLDOWN_MS);
    return () => clearTimeout(timer);
  }, [cooldown]);
  const resend = useCallback(() => {
    if (sending || cooldown) return;
    setSending(true);
    void apiClient.sendVerification().then(() => {
      lastSentAt = Date.now();
      setCooldown(true); setStatus(SENT);
    }).catch((error) => setStatus(error instanceof Error ? error.message : "Couldn't send email. Try again."))
      .finally(() => setSending(false));
  }, [cooldown, sending]);
  const sentOnOpen = useRef(false);
  useEffect(() => {
    if (!sendOnOpen || sentOnOpen.current) return;
    sentOnOpen.current = true;
    resend();
  }, [resend, sendOnOpen]);
  // Each button has a key, shown beside its label.
  useShortcut((event) => {
    if (isPlainKey(event, "enter", "return")) void check();
    else if (isPlainKey(event, "r")) resend();
    else if (isPlainKey(event, "c")) onContinueFree();
    else return;
    event.preventDefault(); event.stopPropagation();
  }, { scope: "cloud-email-verification" });
  return <Box flexDirection="column" gap={1}>
    <Text fg={colors.textDim} wrapText>{status}</Text>
    <Box flexDirection="row" gap={1}>
      <Button label="I've confirmed" variant="primary" shortcut="Enter" onPress={() => { void check(); }} />
      <Button label={cooldown ? "Email sent" : "Resend email"} shortcut="r" disabled={sending || cooldown} onPress={resend} />
    </Box>
    <Button label="Keep using the terminal" variant="ghost" shortcut="c" onPress={onContinueFree} />
  </Box>;
}

import { useCallback, useEffect, useRef, useState } from "react";
import { apiClient, type AuthUser } from "../../../api-client";
import { Button } from "../../../components/ui/button";
import { useShortcut } from "../../../react/input";
import { Box, Text } from "../../../ui";
import { colors } from "../../../theme/colors";

/** Shared continuation after email signup in the terminal and browser. */
export function CloudVerificationPanel({ onVerified, onContinueFree }: {
  onVerified: (user: AuthUser) => void;
  onContinueFree: () => void;
}) {
  const [status, setStatus] = useState("Check your inbox and spam folder. This page continues automatically.");
  const [sending, setSending] = useState(false);
  const [cooldown, setCooldown] = useState(false);
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
    const timer = setTimeout(() => setCooldown(false), 60_000);
    return () => clearTimeout(timer);
  }, [cooldown]);
  useShortcut((event) => {
    if (event.name !== "enter" && event.name !== "return") return;
    event.preventDefault(); event.stopPropagation(); void check();
  }, { scope: "cloud-email-verification" });
  return <Box flexDirection="column" gap={1}>
    <Text fg={colors.textDim} wrapText>{status}</Text>
    <Box flexDirection="row" gap={1}>
      <Button label="I've confirmed" variant="primary" onPress={() => { void check(); }} />
      <Button label={cooldown ? "Email sent" : "Resend email"} disabled={sending || cooldown} onPress={() => {
        setSending(true);
        void apiClient.sendVerification().then(() => {
          setCooldown(true); setStatus("Confirmation link sent. Check your inbox and spam folder.");
        }).catch((error) => setStatus(error instanceof Error ? error.message : "Couldn't send email. Try again."))
          .finally(() => setSending(false));
      }} />
    </Box>
    <Button label="Keep using the terminal" variant="ghost" onPress={onContinueFree} />
  </Box>;
}

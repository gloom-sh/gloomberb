import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CloudEarningsCallAudioPayload, CloudEarningsTranscriptPayload } from "../../../api-client";
import type { AudioPlaybackState, AudioPlayerHandle } from "../../../ui/host";
import { usePluginPaneState } from "../../runtime";
import { callAudioExpired, loadCallAudio } from "./data";
import { lineAt, transcriptLineStarts, type TranscriptLine } from "./model";

export const PLAYBACK_RATES = [1, 1.5, 2] as const;
/** The arrows move playback this far. */
export const SEEK_STEP_SECONDS = 10;
/** A call's recording is asked for again on its own at most this often, and this far apart. */
const MAX_AUTO_RENEWALS = 2;
const MIN_RENEWAL_GAP_MS = 30_000;

type CallAudioStatus = "off" | "loading" | "ready" | "none" | "error";

export interface CallPlayback {
  status: CallAudioStatus;
  audio: CloudEarningsCallAudioPayload | null;
  /** What went wrong with the recording, for the footer. */
  error: string | null;
  state: AudioPlaybackState;
  starts: Array<Array<number | null>>;
  current: TranscriptLine | null;
  rate: number;
  setRate: (rate: number) => void;
  handleRef: { current: AudioPlayerHandle | null };
  onTimeUpdate: (seconds: number) => void;
  onStateChange: (state: AudioPlaybackState) => void;
  onError: (message: string) => void;
  /** Plays from `seconds`, or starts the recording over when it failed. */
  playFrom: (seconds: number) => void;
  toggle: () => void;
  seekBy: (delta: number) => void;
}

function sameLine(a: TranscriptLine | null, b: TranscriptLine | null): boolean {
  return a === b || (!!a && !!b && a.turn === b.turn && a.paragraph === b.paragraph);
}

/**
 * The recording of the open call, where the host can play one: asked for
 * once the transcript is on screen, played by the pane's `AudioPlayer`, and
 * tracked to the paragraph being heard. The address it plays is signed and
 * runs out; when the player is refused one that has, a fresh one is asked
 * for and playback carries on from where it was.
 */
export function useCallPlayback({
  callId,
  transcript,
  enabled,
}: {
  callId: string | null;
  transcript: CloudEarningsTranscriptPayload | null;
  enabled: boolean;
}): CallPlayback {
  const [audio, setAudio] = useState<CloudEarningsCallAudioPayload | null>(null);
  const [status, setStatus] = useState<CallAudioStatus>("off");
  const [error, setError] = useState<string | null>(null);
  // Asking again for the open call's recording, after a failure or once its address has run out.
  const [renewal, setRenewal] = useState<{ callId: string | null; count: number }>({ callId: null, count: 0 });
  const callIdRef = useRef(callId);
  callIdRef.current = callId;
  const [state, setState] = useState<AudioPlaybackState>("idle");
  const [current, setCurrent] = useState<TranscriptLine | null>(null);
  const [storedRate, setStoredRate] = usePluginPaneState<number>("playbackRate", 1);
  const rate = PLAYBACK_RATES.includes(storedRate as typeof PLAYBACK_RATES[number]) ? storedRate : 1;
  const handleRef = useRef<AudioPlayerHandle | null>(null);
  // Set when a fresh address is asked for after the old one ran out, so the
  // error that prompted it is not reported.
  const renewing = useRef(false);
  // The renewals made without being asked, so a recording that fails for
  // another reason than its address cannot be fetched and failed in a loop.
  const autoRenewals = useRef<{ callId: string | null; count: number; at: number }>({ callId: null, count: 0, at: 0 });

  const active = enabled && !!callId;
  useEffect(() => {
    if (!active || !callId) {
      setAudio(null);
      setStatus("off");
      setError(null);
      setCurrent(null);
      setState("idle");
      return;
    }
    let cancelled = false;
    const force = renewal.callId === callId && renewal.count > 0;
    if (!force) {
      setAudio(null);
      setCurrent(null);
      setState("idle");
    }
    setStatus((now) => (force && now === "ready" ? now : "loading"));
    setError(null);
    loadCallAudio(callId, { force })
      .then((next) => {
        if (cancelled) return;
        setAudio(next);
        setStatus(next ? "ready" : "none");
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setStatus("error");
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) renewing.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [active, callId, renewal]);

  const starts = useMemo(
    () => transcript ? transcriptLineStarts(transcript.turns ?? [], audio?.durationSeconds ?? transcript.durationSeconds) : [],
    [audio?.durationSeconds, transcript],
  );
  const startsRef = useRef(starts);
  startsRef.current = starts;

  const onTimeUpdate = useCallback((seconds: number) => {
    const line = lineAt(startsRef.current, seconds);
    setCurrent((previous) => (sameLine(previous, line) ? previous : line));
  }, []);

  const onStateChange = useCallback((next: AudioPlaybackState) => {
    setState(next);
    if (next === "playing") setError(null);
  }, []);

  const audioRef = useRef(audio);
  audioRef.current = audio;
  const onError = useCallback((message: string) => {
    const held = audioRef.current;
    const made = autoRenewals.current.callId === callIdRef.current ? autoRenewals.current : { callId: callIdRef.current, count: 0, at: 0 };
    const now = Date.now();
    if (
      held && callAudioExpired(held) && !renewing.current
      && made.count < MAX_AUTO_RENEWALS && (made.count === 0 || now - made.at >= MIN_RENEWAL_GAP_MS)
    ) {
      renewing.current = true;
      autoRenewals.current = { callId: callIdRef.current, count: made.count + 1, at: now };
      setRenewal((last) => ({ callId: callIdRef.current, count: last.count + 1 }));
      return;
    }
    setError(message);
  }, []);

  const failed = status === "error" || state === "error";
  const failedRef = useRef(failed);
  failedRef.current = failed;
  const retry = useCallback(() => {
    renewing.current = false;
    setRenewal((last) => ({ callId: callIdRef.current, count: last.count + 1 }));
  }, []);

  const playFrom = useCallback((seconds: number) => {
    if (failedRef.current) {
      retry();
      return;
    }
    handleRef.current?.seek(seconds, { play: true });
  }, [retry]);

  const toggle = useCallback(() => {
    if (failedRef.current) {
      retry();
      return;
    }
    void handleRef.current?.toggle();
  }, [retry]);

  const seekBy = useCallback((delta: number) => {
    handleRef.current?.seekBy(delta);
  }, []);

  return {
    status,
    audio,
    error,
    state,
    starts,
    current,
    rate,
    setRate: setStoredRate,
    handleRef,
    onTimeUpdate,
    onStateChange,
    onError,
    playFrom,
    toggle,
    seekBy,
  };
}

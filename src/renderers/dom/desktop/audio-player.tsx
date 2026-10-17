/** @jsxImportSource react */
import { useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { AudioPlaybackState, AudioPlayerHandle, HostAudioPlayerProps, HostQueryBarItem } from "../../../ui/host";
import { releasePointerFocus } from "../host/focus-scope";
import { WebIcon } from "./icons";
import { InlineChoices } from "./query-bar";

/** "4:05", or "1:02:09" past an hour. */
function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(Number.isFinite(seconds) ? seconds : 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const rest = String(total % 60).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`;
}

/** "1×", "1.5×". */
function rateLabel(rate: number): string {
  return `${Number(rate.toFixed(2))}\u00d7`;
}

function mediaErrorMessage(audio: HTMLAudioElement): string {
  switch (audio.error?.code) {
    case 2: return "The recording stopped loading.";
    case 3: return "The recording could not be decoded.";
    case 4: return "The recording could not be opened.";
    default: return "The recording could not be played.";
  }
}

/**
 * The audio player of the desktop and the web: one band in the look of the
 * query bar (play, the time, a seek track, the speed as inline choices) over
 * an `<audio>` element. MP3 plays in Chromium and WebKit alike, and the
 * signed address it plays answers Range requests, so seeking is the
 * browser's own.
 */
export function WebAudioPlayer({
  src,
  sourceKey,
  label,
  durationSeconds,
  rates,
  rate,
  onRateChange,
  handleRef,
  onTimeUpdate,
  onStateChange,
  onError,
}: HostAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<AudioPlaybackState>("idle");
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(durationSeconds ?? 0);
  // Where the pointer holds the track, until it lets go.
  const [scrub, setScrub] = useState<number | null>(null);
  // Whether the listener wants it playing: an address that runs out mid-call
  // comes back playing, and one paused stays paused.
  const wantsPlay = useRef(false);
  const callbacks = useRef({ onTimeUpdate, onStateChange, onError });
  callbacks.current = { onTimeUpdate, onStateChange, onError };
  const rateRef = useRef(rate);
  rateRef.current = rate;

  const report = useCallback((next: AudioPlaybackState) => {
    setState(next);
    callbacks.current.onStateChange?.(next);
  }, []);

  const play = useCallback(async () => {
    const audio = audioRef.current;
    if (!audio) return;
    wantsPlay.current = true;
    try {
      await audio.play();
    } catch {
      // Refused (no source yet, or the page has not been touched): the state
      // follows the element's own events.
    }
  }, []);
  const pause = useCallback(() => {
    wantsPlay.current = false;
    audioRef.current?.pause();
  }, []);
  const seek = useCallback((seconds: number, options?: { play?: boolean }) => {
    const audio = audioRef.current;
    if (!audio) return;
    const limit = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : Number.POSITIVE_INFINITY;
    const target = Math.max(0, Math.min(seconds, limit));
    audio.currentTime = target;
    setTime(target);
    callbacks.current.onTimeUpdate?.(target);
    if (options?.play) void play();
  }, [play]);

  useImperativeHandle(handleRef, (): AudioPlayerHandle => ({
    play,
    pause,
    toggle: async () => {
      const audio = audioRef.current;
      if (!audio) return;
      if (audio.paused) await play();
      else pause();
    },
    seek,
    seekBy: (delta) => seek((audioRef.current?.currentTime ?? 0) + delta),
    currentTime: () => audioRef.current?.currentTime ?? 0,
  }), [pause, play, seek]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const onTime = () => {
      setTime(audio.currentTime);
      callbacks.current.onTimeUpdate?.(audio.currentTime);
    };
    const onDuration = () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) setDuration(audio.duration);
    };
    const onPlaying = () => report("playing");
    const onPause = () => { if (!audio.ended) report("paused"); };
    const onWaiting = () => report("loading");
    const onEnded = () => {
      wantsPlay.current = false;
      report("ended");
    };
    const onFailure = () => {
      report("error");
      callbacks.current.onError?.(mediaErrorMessage(audio));
    };
    // WebKit drops the rate when a source loads.
    const onLoaded = () => { audio.playbackRate = rateRef.current; };
    audio.addEventListener("timeupdate", onTime);
    audio.addEventListener("seeked", onTime);
    audio.addEventListener("durationchange", onDuration);
    audio.addEventListener("loadedmetadata", onDuration);
    audio.addEventListener("loadedmetadata", onLoaded);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("ended", onEnded);
    audio.addEventListener("error", onFailure);
    return () => {
      audio.removeEventListener("timeupdate", onTime);
      audio.removeEventListener("seeked", onTime);
      audio.removeEventListener("durationchange", onDuration);
      audio.removeEventListener("loadedmetadata", onDuration);
      audio.removeEventListener("loadedmetadata", onLoaded);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("ended", onEnded);
      audio.removeEventListener("error", onFailure);
    };
  }, [report]);

  // A new recording starts from the top; a new address for the same one (the
  // signed one ran out) picks up where it was.
  const loaded = useRef<{ src: string; key: string } | null>(null);
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !src) return;
    const previous = loaded.current;
    if (previous?.src === src && previous.key === sourceKey) return;
    const resume = previous?.key === sourceKey ? { at: audio.currentTime, play: wantsPlay.current } : null;
    loaded.current = { src, key: sourceKey };
    if (!resume) {
      wantsPlay.current = false;
      setTime(0);
      setDuration(durationSeconds ?? 0);
      report("idle");
    }
    audio.src = src;
    audio.load();
    if (!resume) return;
    // A fresh address clears the failure of the old one.
    report(resume.play ? "loading" : "paused");
    const restore = () => {
      audio.currentTime = resume.at;
      if (resume.play) void play();
    };
    audio.addEventListener("loadedmetadata", restore, { once: true });
    return () => audio.removeEventListener("loadedmetadata", restore);
  }, [durationSeconds, play, report, sourceKey, src]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.defaultPlaybackRate = rate;
    audio.playbackRate = rate;
  }, [rate]);

  // Leaving the call stops it.
  useEffect(() => () => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.pause();
    audio.removeAttribute("src");
    audio.load();
  }, []);

  const total = duration > 0 ? duration : (durationSeconds ?? 0);
  const shown = scrub ?? time;
  const fraction = total > 0 ? Math.max(0, Math.min(1, shown / total)) : 0;

  const secondsAt = (clientX: number): number => {
    const box = trackRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0 || total <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - box.left) / box.width)) * total;
  };
  const onTrackDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || total <= 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setScrub(secondsAt(event.clientX));
  };
  const onTrackMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (scrub === null) return;
    setScrub(secondsAt(event.clientX));
  };
  const onTrackUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (scrub === null) return;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    const target = secondsAt(event.clientX);
    setScrub(null);
    seek(target);
  };

  const playing = state === "playing" || (state === "loading" && wantsPlay.current);
  const speed = useMemo<HostQueryBarItem>(() => ({
    id: "speed",
    kind: "select",
    label: "Speed",
    valueLabel: rateLabel(rate),
    narrowing: false,
    inline: true,
    options: rates.map((option) => ({ value: String(option), label: rateLabel(option), selected: option === rate })),
    onSelect: (value) => onRateChange(Number(value)),
    onToggle: () => {},
    onReset: () => {},
  }), [onRateChange, rate, rates]);

  return (
    <div
      className="gloom-qb gloom-player"
      data-gloom-role="audio-player"
      data-state={state}
      role="group"
      aria-label={label}
    >
      <div className="gloom-qb-scroll">
        <button
          type="button"
          className="gloom-player-toggle"
          aria-label={playing ? "Pause" : "Play"}
          aria-keyshortcuts="Space"
          title={playing ? "Pause (Space)" : "Play (Space)"}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            const audio = audioRef.current;
            if (audio?.paused) void play();
            else pause();
            releasePointerFocus(event.currentTarget, event.detail);
          }}
        >
          <WebIcon name={playing ? "pause" : "play"} size={11} />
        </button>
        <span className="gloom-player-time" data-gloom-role="audio-elapsed">{clock(shown)}</span>
        <div
          ref={trackRef}
          className="gloom-player-track"
          role="slider"
          aria-label="Position"
          aria-valuemin={0}
          aria-valuemax={Math.round(total)}
          aria-valuenow={Math.round(shown)}
          aria-valuetext={`${clock(shown)} of ${clock(total)}`}
          data-gloom-interactive={total > 0 ? "true" : undefined}
          data-scrubbing={scrub !== null ? "true" : undefined}
          onPointerDown={onTrackDown}
          onPointerMove={onTrackMove}
          onPointerUp={onTrackUp}
          onPointerCancel={() => setScrub(null)}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <div className="gloom-player-rail">
            <div className="gloom-player-fill" style={{ width: `${fraction * 100}%` }} />
          </div>
          <div className="gloom-player-thumb" style={{ left: `${fraction * 100}%` }} />
        </div>
        <span className="gloom-player-time" data-gloom-role="audio-total">{clock(total)}</span>
        <InlineChoices item={speed} />
      </div>
      <audio ref={audioRef} preload="metadata" aria-label={label} />
    </div>
  );
}

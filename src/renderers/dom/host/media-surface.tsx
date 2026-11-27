/** @jsxImportSource react */
import type Hls from "hls.js";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { MediaSurfaceHandle, MediaSurfaceProps } from "../../../ui/host";
import { cleanDomProps, commonStyle } from "./style";

type PlaybackState = Parameters<NonNullable<MediaSurfaceProps["onPlaybackStateChange"]>>[0];
const YOUTUBE_ATTEMPT_TIMEOUT_MS = 15_000;
const YOUTUBE_WIDGET_ID = "gloom-media";
const YOUTUBE_EVENTS = ["onStateChange", "onError", "onAutoplayBlocked"];
const YOUTUBE_UNAVAILABLE = "The embedded player could not play this stream.";

type YoutubeControls = { play(): void; pause(): void; mute(): void };

function youtubePlaybackState(value: unknown): PlaybackState | "ended" | undefined {
  switch (value) {
    case 0: return "ended";
    case 1: return "playing";
    case 2: return "paused";
    case 3: return "loading";
    case -1:
    case 5: return "idle";
    default: return undefined;
  }
}

export const WebMediaSurface = forwardRef<HTMLVideoElement, MediaSurfaceProps>(function WebMediaSurface(rawProps, forwardedRef) {
  const {
    children,
    src,
    title,
    poster,
    autoPlay = false,
    muted = false,
    mediaHandleRef,
    onPlaybackStateChange,
    onMutedChange,
    onError,
    ...props
  } = rawProps as MediaSurfaceProps & {
    children?: ReactNode;
    src?: string;
    title?: string;
    poster?: string;
    autoPlay?: boolean;
    muted?: boolean;
    mediaHandleRef?: MediaSurfaceProps["mediaHandleRef"];
    onPlaybackStateChange?: (state: PlaybackState) => void;
    onMutedChange?: (muted: boolean) => void;
    onError?: (message: string) => void;
  };
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const youtubeMutedRef = useRef(muted);
  const youtubePlayingRef = useRef(false);
  const youtubeControls = useRef<YoutubeControls | null>(null);
  const retryYoutubeSrc = useRef<string | null>(null);
  const callbacks = useRef({ onPlaybackStateChange, onError });
  callbacks.current = { onPlaybackStateChange, onError };
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const mediaSrc = typeof src === "string" ? src.trim() : "";
  const failed = failedSrc === mediaSrc;
  const embedUrl = /^https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\//.test(mediaSrc) ? new URL(mediaSrc) : null;
  if (embedUrl) {
    embedUrl.protocol = "https:";
    if (embedUrl.searchParams.get("enablejsapi") !== "1") embedUrl.searchParams.set("enablejsapi", "1");
  }
  const youtubeOrigin = embedUrl?.origin;
  const baseStyle = commonStyle(props);

  useImperativeHandle(forwardedRef, () => videoRef.current as HTMLVideoElement, []);
  useImperativeHandle(mediaHandleRef, (): MediaSurfaceHandle => ({
    async play() {
      if (youtubeOrigin) {
        if (failed) {
          retryYoutubeSrc.current = mediaSrc;
          setFailedSrc(null);
        } else youtubeControls.current?.play();
        return;
      }
      if (videoRef.current) await videoRef.current.play();
    },
    pause() {
      if (youtubeOrigin) {
        youtubeControls.current?.pause();
        return;
      }
      videoRef.current?.pause();
    },
    async toggle() {
      if (youtubeOrigin) {
        if (failed) {
          retryYoutubeSrc.current = mediaSrc;
          setFailedSrc(null);
        } else if (youtubePlayingRef.current) youtubeControls.current?.pause();
        else youtubeControls.current?.play();
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      if (video.paused) {
        await video.play();
      } else {
        video.pause();
      }
    },
    toggleMuted() {
      if (youtubeOrigin) {
        youtubeMutedRef.current = !youtubeMutedRef.current;
        youtubeControls.current?.mute();
        onMutedChange?.(youtubeMutedRef.current);
        return youtubeMutedRef.current;
      }
      const video = videoRef.current;
      if (!video) return muted;
      video.muted = !video.muted;
      return video.muted;
    },
  }), [failed, mediaSrc, muted, onMutedChange, youtubeOrigin]);

  // Keys typed into a cross-origin frame never reach the app, so a click on
  // the player would take Tab, the command bar and every pane key with it.
  // Its controls work by pointer without focus; hand the keyboard back.
  useEffect(() => {
    if (!youtubeOrigin) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const releaseFrameFocus = () => {
      timer = null;
      const frame = iframeRef.current;
      if (!frame || document.activeElement !== frame) return;
      frame.blur();
      if (document.activeElement === frame) window.focus();
    };
    // The window blurs as the frame takes focus, on the press; the release
    // waits a task so the frame's own focus handling has run.
    const handleWindowBlur = () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(releaseFrameFocus, 0);
    };
    window.addEventListener("blur", handleWindowBlur);
    return () => {
      window.removeEventListener("blur", handleWindowBlur);
      if (timer !== null) clearTimeout(timer);
    };
  }, [youtubeOrigin]);

  useEffect(() => {
    youtubeMutedRef.current = muted;
    if (youtubeOrigin) onMutedChange?.(muted);
  }, [mediaSrc, muted, onMutedChange, youtubeOrigin]);

  useEffect(() => setFailedSrc(null), [mediaSrc]);

  useEffect(() => {
    const frame = iframeRef.current;
    if (!youtubeOrigin || failed || !frame) return;
    let last: PlaybackState | undefined;
    let ended = false;
    let connected = false;
    let hasStateTransition = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let queuedPlayback: "playVideo" | "pauseVideo" | undefined;
    let queuedMute = false;
    let pauseRequested = false;
    const active = () => !ended && iframeRef.current === frame;
    const post = (payload: object) => {
      if (active()) frame.contentWindow?.postMessage(JSON.stringify({ ...payload, id: YOUTUBE_WIDGET_ID, channel: "widget" }), youtubeOrigin);
    };
    const command = (func: string, args: string[] = []) => post({ event: "command", func, args });
    const update = (state: PlaybackState) => {
      if (state === last) return;
      last = state;
      youtubePlayingRef.current = state === "playing";
      callbacks.current.onPlaybackStateChange?.(state);
    };
    const stopAttempt = () => {
      clearTimeout(deadline);
      deadline = undefined;
    };
    const stopHandshake = () => {
      clearInterval(listenAgain);
      clearTimeout(handshakeDeadline);
    };
    const fail = () => {
      if (!active()) return;
      ended = true;
      stopHandshake();
      stopAttempt();
      setFailedSrc(mediaSrc);
      update("error");
      callbacks.current.onError?.(YOUTUBE_UNAVAILABLE);
    };
    const startAttempt = () => {
      if (!active() || deadline !== undefined) return;
      const timer = setTimeout(() => { if (deadline === timer) fail(); }, YOUTUBE_ATTEMPT_TIMEOUT_MS);
      deadline = timer;
      update("loading");
    };
    const setPlayback = (func: "playVideo" | "pauseVideo") => {
      if (connected) command(func);
      else queuedPlayback = func;
    };
    const setMute = () => command(youtubeMutedRef.current ? "mute" : "unMute");
    const controls: YoutubeControls = {
      play() {
        if (pauseRequested || last !== "playing") startAttempt();
        pauseRequested = false;
        setPlayback("playVideo");
      },
      pause() {
        pauseRequested = last === "loading" || last === "playing";
        stopAttempt();
        setPlayback("pauseVideo");
      },
      mute() {
        if (connected) setMute();
        else queuedMute = true;
      },
    };
    const connect = () => {
      if (connected) return;
      connected = true;
      stopHandshake();
      for (const kind of YOUTUBE_EVENTS) command("addEventListener", [kind]);
      if (queuedMute) setMute();
      if (queuedPlayback) command(queuedPlayback);
      if (deadline === undefined && last === "loading") update("idle");
    };
    const message = (event: MessageEvent) => {
      const source = frame.contentWindow;
      if (!active() || !source || event.source !== source || event.origin !== youtubeOrigin || typeof event.data !== "string") return;
      let payload: { event?: unknown; id?: unknown; info?: unknown } | null;
      try {
        payload = JSON.parse(event.data);
      } catch {
        // Intentional ignore: malformed player messages are not playback events.
        return;
      }
      if (!payload || typeof payload !== "object" || payload.id !== YOUTUBE_WIDGET_ID) return;
      const { event: kind, info } = payload;
      const snapshot = info && typeof info === "object" ? info : undefined;
      if (kind === "onReady" || kind === "alreadyInitialized" || (kind === "initialDelivery" && snapshot)) connect();
      if (kind === "onError" && typeof info === "number" && Number.isInteger(info) && info > 0) {
        fail();
      } else if (kind === "onAutoplayBlocked") {
        pauseRequested = false;
        stopAttempt();
        update("idle");
      } else {
        const isTransition = kind === "onStateChange";
        if (hasStateTransition && !isTransition) return;
        const state = isTransition ? youtubePlaybackState(info)
          : (kind === "initialDelivery" || kind === "infoDelivery") && snapshot && "playerState" in snapshot
            ? youtubePlaybackState(snapshot.playerState) : undefined;
        if (state === undefined) return;
        if (isTransition) hasStateTransition = true;
        if (state === "ended") {
          if (deadline !== undefined && !isTransition) return;
          pauseRequested = false;
          stopAttempt();
          update("idle");
        } else if (state === "playing") {
          if (pauseRequested) return;
          stopAttempt();
          update(state);
        } else if (state === "loading") {
          if (!pauseRequested && (isTransition || last === "playing")) startAttempt();
        } else if (state === "paused" && (isTransition || pauseRequested)) {
          pauseRequested = false;
          stopAttempt();
          update(state);
        } else if (connected && deadline === undefined) {
          update(state);
        }
      }
    };
    const listen = () => post({ event: "listening" });
    const listenAgain = setInterval(listen, 250);
    const handshakeDeadline = setTimeout(() => { if (!connected) fail(); }, YOUTUBE_ATTEMPT_TIMEOUT_MS);
    window.addEventListener("message", message);
    youtubeControls.current = controls;
    update("loading");
    if (autoPlay) startAttempt();
    if (retryYoutubeSrc.current === mediaSrc) controls.play();
    retryYoutubeSrc.current = null;
    listen();
    return () => {
      ended = true;
      stopHandshake();
      stopAttempt();
      youtubeControls.current = null;
      window.removeEventListener("message", message);
    };
  }, [autoPlay, failed, mediaSrc, youtubeOrigin]);

  useEffect(() => {
    if (youtubeOrigin) return;
    const video = videoRef.current;
    if (!video || !mediaSrc) {
      if (!mediaSrc) onPlaybackStateChange?.("idle");
      return;
    }

    onPlaybackStateChange?.("loading");
    let hls: Hls | null = null;

    let active = true;
    const fail = (message: string) => {
      if (!active) return;
      setFailedSrc(mediaSrc);
      onPlaybackStateChange?.("error");
      onError?.(message);
    };
    const handlePlaying = () => onPlaybackStateChange?.("playing");
    const handlePause = () => onPlaybackStateChange?.("paused");
    const handleWaiting = () => onPlaybackStateChange?.("loading");
    const handleVolumeChange = () => onMutedChange?.(video.muted);
    const handleError = () => fail("The live stream could not be played.");
    video.addEventListener("playing", handlePlaying);
    video.addEventListener("pause", handlePause);
    video.addEventListener("waiting", handleWaiting);
    video.addEventListener("volumechange", handleVolumeChange);
    video.addEventListener("error", handleError);
    video.defaultMuted = muted;
    video.muted = muted;
    onMutedChange?.(video.muted);

    const startPlayback = () => {
      if (!autoPlay) return;
      void video.play().catch(() => {
        if (active) onPlaybackStateChange?.("paused");
      });
    };

    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = mediaSrc;
      video.load();
      startPlayback();
    } else {
      // Loaded with the first stream that needs it, not with the app.
      void import("./hls.chunk.js").then(({ default: HlsPlayer }) => {
        if (!active) return;
        if (!HlsPlayer.isSupported()) {
          fail("HLS playback is unavailable in this desktop runtime.");
          return;
        }
        hls = new HlsPlayer({
          backBufferLength: 30,
          enableWorker: true,
          lowLatencyMode: true,
          // A pane is a fraction of the screen, so the top rendition would be
          // decoded and then scaled away. Re-evaluated when the pane is resized.
          capLevelToPlayerSize: true,
        });
        hls.on(HlsPlayer.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          fail(data.details ? `Stream playback failed: ${data.details}` : "Stream playback failed.");
        });
        hls.on(HlsPlayer.Events.MANIFEST_PARSED, startPlayback);
        hls.loadSource(mediaSrc);
        hls.attachMedia(video);
      }, () => fail("The stream player could not be loaded."));
    }

    return () => {
      active = false;
      hls?.destroy();
      video.removeEventListener("playing", handlePlaying);
      video.removeEventListener("pause", handlePause);
      video.removeEventListener("waiting", handleWaiting);
      video.removeEventListener("volumechange", handleVolumeChange);
      video.removeEventListener("error", handleError);
      video.pause();
      video.removeAttribute("src");
      video.load();
    };
  }, [autoPlay, mediaSrc, onError, onMutedChange, onPlaybackStateChange, youtubeOrigin]);

  return (
    <div
      {...cleanDomProps(props)}
      style={{
        ...baseStyle,
        position: "relative",
        overflow: "hidden",
        background: "#050505",
        ...(props.style as CSSProperties | undefined),
      }}
    >
      {!failed && embedUrl ? (
        <iframe
          key={mediaSrc}
          ref={iframeRef}
          title={title || "Live TV stream"}
          src={embedUrl.href}
          referrerPolicy="strict-origin-when-cross-origin"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          style={{
            width: "100%",
            height: "100%",
            border: 0,
            display: "block",
            background: "#050505",
          }}
        />
      ) : mediaSrc && !failed ? (
        <video
          key={mediaSrc}
          ref={videoRef}
          aria-label={title || "Live TV stream"}
          title={title}
          poster={poster}
          controls
          playsInline
          autoPlay={autoPlay}
          muted={muted}
          style={{
            width: "100%",
            height: "100%",
            display: "block",
            objectFit: "contain",
            background: "#050505",
          }}
        />
      ) : children as ReactNode}
    </div>
  );
});

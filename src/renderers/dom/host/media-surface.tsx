/** @jsxImportSource react */
import type Hls from "hls.js";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { MediaSurfaceHandle, MediaSurfaceProps } from "../../../ui/host";
import { cleanDomProps, commonStyle } from "./style";

type PlaybackState = Parameters<NonNullable<MediaSurfaceProps["onPlaybackStateChange"]>>[0];
const YOUTUBE_READY_TIMEOUT_MS = 15_000;
const YOUTUBE_UNAVAILABLE = "The embedded player could not play this stream.";

function postYoutubeCommand(frame: HTMLIFrameElement | null, origin: string, func: string, args: unknown[] = []): void {
  frame?.contentWindow?.postMessage(JSON.stringify({ event: "command", id: 1, func, args }), origin);
}

function youtubePlaybackState(value: unknown): PlaybackState | undefined {
  switch (value) {
    case 1: return "playing";
    case 2: return "paused";
    case 3: return "loading";
    case -1:
    case 0:
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
        if (failed) setFailedSrc(null);
        else postYoutubeCommand(iframeRef.current, youtubeOrigin, "playVideo");
        return;
      }
      if (videoRef.current) await videoRef.current.play();
    },
    pause() {
      if (youtubeOrigin) {
        postYoutubeCommand(iframeRef.current, youtubeOrigin, "pauseVideo");
        return;
      }
      videoRef.current?.pause();
    },
    async toggle() {
      if (youtubeOrigin) {
        if (failed) setFailedSrc(null);
        else postYoutubeCommand(iframeRef.current, youtubeOrigin, youtubePlayingRef.current ? "pauseVideo" : "playVideo");
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
        postYoutubeCommand(iframeRef.current, youtubeOrigin, youtubeMutedRef.current ? "mute" : "unMute");
        onMutedChange?.(youtubeMutedRef.current);
        return youtubeMutedRef.current;
      }
      const video = videoRef.current;
      if (!video) return muted;
      video.muted = !video.muted;
      return video.muted;
    },
  }), [failed, muted, onMutedChange, youtubeOrigin]);

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
    const update = (state: PlaybackState) => {
      if (state === last) return;
      last = state;
      youtubePlayingRef.current = state === "playing";
      callbacks.current.onPlaybackStateChange?.(state);
    };
    const fail = () => {
      ended = true;
      clearTimeout(timeout);
      setFailedSrc(mediaSrc);
      update("error");
      callbacks.current.onError?.(YOUTUBE_UNAVAILABLE);
    };
    const timeout = setTimeout(fail, YOUTUBE_READY_TIMEOUT_MS);
    const message = (event: MessageEvent) => {
      const source = frame.contentWindow;
      if (ended || iframeRef.current !== frame || !source || event.source !== source || event.origin !== youtubeOrigin || typeof event.data !== "string") return;
      let payload: { event?: unknown; info?: unknown } | null;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (!payload || typeof payload !== "object") return;
      const { event: kind, info } = payload;
      if (kind === "onError" && typeof info === "number" && Number.isInteger(info) && info > 0) {
        fail();
      } else if (kind === "onReady") {
        clearTimeout(timeout);
        if (!autoPlay && last === "loading") update("idle");
      } else if (kind === "onAutoplayBlocked") {
        clearTimeout(timeout);
        update("idle");
      } else {
        const state = kind === "onStateChange" ? youtubePlaybackState(info)
          : (kind === "initialDelivery" || kind === "infoDelivery") && info && typeof info === "object" && "playerState" in info
            ? youtubePlaybackState(info.playerState) : undefined;
        if (state === undefined) return;
        clearTimeout(timeout);
        update(state);
      }
    };
    window.addEventListener("message", message);
    update("loading");
    return () => {
      clearTimeout(timeout);
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
          onLoad={(event) => {
            const frame = event.currentTarget;
            frame.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: 1 }), embedUrl.origin);
            for (const kind of ["onStateChange", "onError", "onAutoplayBlocked"]) {
              postYoutubeCommand(frame, embedUrl.origin, "addEventListener", [kind]);
            }
          }}
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

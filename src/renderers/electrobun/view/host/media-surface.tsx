/** @jsxImportSource react */
import Hls from "hls.js";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { MediaSurfaceHandle, MediaSurfaceProps } from "../../../../ui/host";
import { cleanDomProps, commonStyle } from "./style";

function postYoutubeCommand(frame: HTMLIFrameElement | null, func: string, args: unknown[] = []): void {
  frame?.contentWindow?.postMessage(JSON.stringify({ event: "command", func, args }), "*");
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
    onPlaybackStateChange?: (state: "idle" | "loading" | "playing" | "paused" | "error") => void;
    onMutedChange?: (muted: boolean) => void;
    onError?: (message: string) => void;
  };
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const youtubeMutedRef = useRef(muted);
  const youtubePlayingRef = useRef(autoPlay);
  const [failed, setFailed] = useState(false);
  const mediaSrc = typeof src === "string" ? src.trim() : "";
  const youtubeEmbed = /^https?:\/\/(?:www\.)?youtube(?:-nocookie)?\.com\/embed\//.test(mediaSrc);
  const baseStyle = commonStyle(props);

  useImperativeHandle(forwardedRef, () => videoRef.current as HTMLVideoElement, []);
  useImperativeHandle(mediaHandleRef, (): MediaSurfaceHandle => ({
    async play() {
      if (youtubeEmbed) {
        postYoutubeCommand(iframeRef.current, "playVideo");
        youtubePlayingRef.current = true;
        onPlaybackStateChange?.("playing");
        return;
      }
      if (videoRef.current) await videoRef.current.play();
    },
    pause() {
      if (youtubeEmbed) {
        postYoutubeCommand(iframeRef.current, "pauseVideo");
        youtubePlayingRef.current = false;
        onPlaybackStateChange?.("paused");
        return;
      }
      videoRef.current?.pause();
    },
    async toggle() {
      if (youtubeEmbed) {
        if (youtubePlayingRef.current) {
          postYoutubeCommand(iframeRef.current, "pauseVideo");
          youtubePlayingRef.current = false;
          onPlaybackStateChange?.("paused");
        } else {
          postYoutubeCommand(iframeRef.current, "playVideo");
          youtubePlayingRef.current = true;
          onPlaybackStateChange?.("playing");
        }
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
      if (youtubeEmbed) {
        youtubeMutedRef.current = !youtubeMutedRef.current;
        postYoutubeCommand(iframeRef.current, youtubeMutedRef.current ? "mute" : "unMute");
        onMutedChange?.(youtubeMutedRef.current);
        return youtubeMutedRef.current;
      }
      const video = videoRef.current;
      if (!video) return muted;
      video.muted = !video.muted;
      return video.muted;
    },
  }), [muted, onMutedChange, onPlaybackStateChange, youtubeEmbed]);

  useEffect(() => {
    youtubeMutedRef.current = muted;
    if (youtubeEmbed) {
      setFailed(false);
      onPlaybackStateChange?.(autoPlay ? "playing" : "paused");
      onMutedChange?.(muted);
      return;
    }
    const video = videoRef.current;
    if (!video || !mediaSrc) {
      onPlaybackStateChange?.("idle");
      return;
    }

    setFailed(false);
    onPlaybackStateChange?.("loading");
    let hls: Hls | null = null;

    let active = true;
    const fail = (message: string) => {
      if (!active) return;
      setFailed(true);
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
    } else if (Hls.isSupported()) {
      hls = new Hls({
        backBufferLength: 30,
        enableWorker: true,
        lowLatencyMode: true,
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        fail(data.details ? `Stream playback failed: ${data.details}` : "Stream playback failed.");
      });
      hls.on(Hls.Events.MANIFEST_PARSED, startPlayback);
      hls.loadSource(mediaSrc);
      hls.attachMedia(video);
    } else {
      fail("HLS playback is unavailable in this desktop runtime.");
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
  }, [autoPlay, mediaSrc, onError, onMutedChange, onPlaybackStateChange, youtubeEmbed]);

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
      {mediaSrc && !failed && youtubeEmbed ? (
        <iframe
          key={mediaSrc}
          ref={iframeRef}
          title={title || "Live TV stream"}
          src={mediaSrc}
          referrerPolicy="strict-origin-when-cross-origin"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          onLoad={() => {
            iframeRef.current?.contentWindow?.postMessage(JSON.stringify({ event: "listening", id: 1 }), "*");
            onPlaybackStateChange?.(autoPlay ? "playing" : "paused");
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

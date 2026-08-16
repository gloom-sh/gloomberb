import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, Tabs, usePaneFooter } from "../../../components";
import { updatePaneInstance } from "../../../pane-settings";
import { useShortcut } from "../../../react/input";
import {
  syncConfigActiveLayoutState,
  useAppDispatch,
  useAppStateRef,
  usePaneInstance,
} from "../../../state/app/context";
import { scheduleConfigSave } from "../../../state/config-save-scheduler";
import { colors } from "../../../theme/colors";
import type { PaneProps } from "../../../types/plugin";
import { Box, MediaSurface, Text, useRendererHost, type MediaSurfaceHandle } from "../../../ui";
import { getTvChannel, TV_CHANNELS, type TvChannelId } from "./channels";
import type { ResolvedLiveStream } from "../../../types/media";
import { resolveTvStream } from "./youtube-stream";

type PlaybackState = "idle" | "loading" | "playing" | "paused" | "error";

export function TvPane({ paneId, focused, width, height }: PaneProps) {
  const renderer = useRendererHost();
  const dispatch = useAppDispatch();
  const stateRef = useAppStateRef();
  const pane = usePaneInstance();
  const initialChannelIdRef = useRef<TvChannelId>(
    TV_CHANNELS.find((item) => item.id === pane?.settings?.channelId)?.id ?? "bloomberg",
  );
  const [channelId, setChannelId] = useState<TvChannelId>(initialChannelIdRef.current);
  const [stream, setStream] = useState<ResolvedLiveStream | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [playbackState, setPlaybackState] = useState<PlaybackState>("idle");
  const [muted, setMuted] = useState(true);
  const mediaRef = useRef<MediaSurfaceHandle | null>(null);
  const generationRef = useRef(0);
  const channel = getTvChannel(channelId);

  const persistChannelSelection = useCallback((nextId: TvChannelId) => {
    const nextChannel = getTvChannel(nextId);
    const nextTitle = `TV: ${nextChannel.name}`;
    const currentState = stateRef.current;
    const currentPane = currentState.config.layout.instances.find((instance) => instance.instanceId === paneId);
    if (currentPane?.title === nextTitle && currentPane.settings?.channelId === nextId) return;

    const layout = updatePaneInstance(currentState.config.layout, paneId, (instance) => ({
      ...instance,
      title: nextTitle,
      settings: { ...instance.settings, channelId: nextId },
    }));
    const syncedConfig = syncConfigActiveLayoutState(
      { ...currentState.config, layout },
      currentState.paneState,
      currentState.focusedPaneId,
      currentState.activePanel,
    );
    dispatch({ type: "SET_CONFIG", config: syncedConfig });
    scheduleConfigSave(syncedConfig);
  }, [dispatch, paneId, stateRef]);

  const load = useCallback(async (force = false) => {
    const generation = ++generationRef.current;
    setLoading(true);
    setError(null);
    setPlaybackError(null);
    setPlaybackState("idle");
    setStream((current) => current?.sourceId === channel.id ? current : null);
    try {
      const nextStream = renderer.resolveLiveStream
        ? await renderer.resolveLiveStream({ provider: "youtube", sourceId: channel.id, force })
        : await resolveTvStream(channel, { force });
      if (generation !== generationRef.current) return;
      setStream(nextStream);
    } catch (cause) {
      if (generation !== generationRef.current) return;
      setStream(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (generation === generationRef.current) setLoading(false);
    }
  }, [channel, renderer]);

  const refresh = useCallback(() => {
    void load(true);
  }, [load]);

  useEffect(() => {
    void load();
    return () => {
      generationRef.current += 1;
    };
  }, [load]);

  useEffect(() => {
    persistChannelSelection(channelId);
  }, [channelId, persistChannelSelection]);

  const selectChannel = useCallback((nextId: string) => {
    if (TV_CHANNELS.some((item) => item.id === nextId)) {
      setMuted(true);
      setChannelId(nextId as TvChannelId);
    }
  }, []);

  const togglePlayback = useCallback(async () => {
    setPlaybackError(null);
    try {
      await mediaRef.current?.toggle();
    } catch (cause) {
      setPlaybackState("error");
      setPlaybackError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const toggleMute = useCallback(() => {
    const nextMuted = mediaRef.current?.toggleMuted();
    if (typeof nextMuted === "boolean") setMuted(nextMuted);
  }, []);

  useShortcut((event) => {
    if (!focused) return;
    const channelIndex = Number(event.name) - 1;
    if (Number.isInteger(channelIndex) && TV_CHANNELS[channelIndex]) {
      event.preventDefault?.();
      selectChannel(TV_CHANNELS[channelIndex]!.id);
      return;
    }
    if (event.name === "r") {
      event.preventDefault?.();
      refresh();
      return;
    }
    if (event.name === "p" && stream) {
      event.preventDefault?.();
      void togglePlayback();
      return;
    }
    if (event.name === "m" && stream) {
      event.preventDefault?.();
      toggleMute();
    }
  });

  const status = loading
    ? `resolving ${channel.name}`
    : error
      ? "stream error"
      : playbackError
        ? /required|install|not found/i.test(playbackError) ? "player missing" : "playback error"
        : playbackState === "playing"
          ? "playing live"
          : playbackState === "loading"
            ? "buffering live"
            : stream
              ? "live"
              : "offline";

  usePaneFooter(paneId, () => ({
    info: [{
      id: "tv-status",
      parts: [{
        text: status,
        tone: error || playbackError ? "warning" : playbackState === "playing" ? "positive" : "value",
      }],
    }],
    hints: [
      {
        id: "playback",
        key: "p",
        label: playbackState === "playing" ? "ause" : "lay",
        onPress: () => { void togglePlayback(); },
        disabled: loading || !stream,
      },
      {
        id: "mute",
        key: "m",
        label: muted ? "unmute" : "ute",
        onPress: toggleMute,
        disabled: loading || !stream,
      },
      { id: "refresh", key: "r", label: "efresh", onPress: refresh, disabled: loading },
    ],
  }), [error, loading, muted, paneId, playbackError, playbackState, refresh, status, stream, toggleMute, togglePlayback]);

  const channelTabs = useMemo(() => TV_CHANNELS.map((item, index) => ({
    label: `${index + 1} ${item.name}`,
    value: item.id,
  })), []);
  const mediaHeight = Math.max(6, height - 1);

  return (
    <Box flexDirection="column" width={width} height={height}>
      <Box height={1} paddingX={1}>
        <Tabs
          tabs={channelTabs}
          activeValue={channelId}
          onSelect={selectChannel}
          compact
          variant="bare"
          focused={focused}
        />
      </Box>

      {loading && !stream ? (
        <Box flexGrow={1} justifyContent="center" alignItems="center">
          <Text fg={colors.textMuted}>{`Resolving ${channel.name} live stream...`}</Text>
        </Box>
      ) : error || !stream ? (
        <Box flexGrow={1} flexDirection="column" justifyContent="center" alignItems="center" gap={1}>
          <Text fg={colors.warning}>{error ?? `${channel.name} is offline.`}</Text>
          <Button label="Try again" variant="primary" onPress={refresh} />
        </Box>
      ) : (
        <MediaSurface
          src={stream.manifestUrl}
          title={stream.title}
          poster={stream.posterUrl}
          autoPlay
          muted={muted}
          mediaHandleRef={mediaRef}
          height={mediaHeight}
          flexGrow={1}
          onPlaybackStateChange={setPlaybackState}
          onMutedChange={setMuted}
          onError={setPlaybackError}
        >
          <Box flexGrow={1} justifyContent="center" alignItems="center">
            <Text fg={colors.warning}>{playbackError ?? stream.title}</Text>
          </Box>
        </MediaSurface>
      )}
    </Box>
  );
}

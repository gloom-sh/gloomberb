import type { ReactNode, Ref } from "react";
import { Box, useUiCapabilities, useUiHost, type BoxRenderable } from "../../ui";
import type { HostAudioPlayerProps } from "../../ui/host";

export type AudioPlayerProps = HostAudioPlayerProps;

/**
 * A transport bar over one recording: play and pause, the elapsed and total
 * time, a seek track and the speed. Drawn by hosts that play audio (the
 * desktop and the web); the terminal has none, and nothing is drawn there.
 */
export function AudioPlayer(props: AudioPlayerProps) {
  const { AudioPlayer: HostAudioPlayer } = useUiHost();
  return HostAudioPlayer ? <HostAudioPlayer {...props} /> : null;
}

/** Whether this host draws an `AudioPlayer`, so a pane asks for audio only where it can play it. */
export function useCanPlayAudio(): boolean {
  return useUiHost().AudioPlayer !== undefined;
}

export interface PlaybackLineProps {
  /** Seconds into the recording the line starts at; null when it cannot be played from. */
  start: number | null;
  /** The line being heard. */
  current?: boolean;
  /** Plays from `start`; omitted, the line is plain text. */
  onPlay?: (start: number) => void;
  marginTop?: number;
  nodeRef?: Ref<BoxRenderable | null>;
  children: ReactNode;
}

/** True when the pointer went up after selecting text rather than clicking. */
function selectingText(): boolean {
  const selection = (globalThis as { getSelection?: () => { isCollapsed: boolean } | null }).getSelection?.();
  return !!selection && !selection.isCollapsed;
}

/**
 * A passage of a recording's transcript: clicked, it plays from where it
 * starts; while it is heard it is marked like the row under the cursor of a
 * table, and the pointer over it shows half that. Without a recording it is
 * the plain block it wraps, the same in every renderer.
 */
export function PlaybackLine({ start, current = false, onPlay, marginTop, nodeRef, children }: PlaybackLineProps) {
  const { nativePaneChrome } = useUiCapabilities();
  const playable = nativePaneChrome === true && start !== null && onPlay !== undefined;
  if (!playable) {
    return <Box ref={nodeRef} flexDirection="column" marginTop={marginTop}>{children}</Box>;
  }
  return (
    <Box
      ref={nodeRef}
      flexDirection="column"
      marginTop={marginTop}
      className="gloom-playback-line"
      data-gloom-role="playback-line"
      data-gloom-interactive="true"
      data-current={current ? "true" : undefined}
      aria-current={current ? "true" : undefined}
      onMouseUp={(event?: { button?: number }) => {
        if ((event?.button ?? 0) !== 0 || selectingText()) return;
        onPlay(start);
      }}
    >
      {children}
    </Box>
  );
}

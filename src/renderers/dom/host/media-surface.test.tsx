/** @jsxImportSource react */
import { expect, mock, spyOn, test } from "bun:test";
import { act, createRef, useState } from "react";
import type { MediaSurfaceHandle } from "../../../ui/host";
import { createDomTestHarness } from "../test-utils";
import { WebMediaSurface } from "./media-surface";

const { window: testWindow, render } = createDomTestHarness({ withUi: false });
testWindow.happyDOM.settings.disableIframePageLoading = true;
const origin = "https://www.youtube.com";
const source = `${origin}/embed/abcdefghijk?autoplay=1&mute=1`;

async function embed() {
  const states: string[] = [];
  const onError = mock();
  const media = createRef<MediaSurfaceHandle>();
  let setSource: (value: string) => void;
  function Harness() {
    const [src, setSrc] = useState(source);
    setSource = setSrc;
    return <WebMediaSurface src={src} autoPlay muted mediaHandleRef={media} onPlaybackStateChange={(state) => states.push(state)} onError={onError}>
      <a href="https://www.youtube.com/watch?v=abcdefghijk">Open in browser</a>
    </WebMediaSurface>;
  }
  const pane = await render(<Harness />);
  const player = () => {
    const frame = pane.querySelector("iframe")!;
    const postMessage = mock<(message: string, targetOrigin: string) => void>();
    const frameWindow = { postMessage } as unknown as typeof testWindow;
    Object.defineProperty(frame, "contentWindow", { value: frameWindow });
    const send = (event: string, info?: unknown, from = frameWindow, eventOrigin = origin) => act(async () => {
      testWindow.dispatchEvent(new testWindow.MessageEvent("message", {
        data: JSON.stringify({ event, info, id: "gloom-media", channel: "widget" }), origin: eventOrigin, source: from,
      }));
    });
    return { frame, postMessage, send };
  };
  const changeSource = (next: string) => act(async () => setSource(next));
  return { ...player(), player, get media() { return media.current!; }, changeSource, pane, states, onError };
}

test("the iframe retries its handshake and subscribes before sending queued controls, without assuming playback", async () => {
  const interval = spyOn(globalThis, "setInterval");
  const clear = spyOn(globalThis, "clearInterval");
  try {
    const { frame, media, states, postMessage, send } = await embed();
    expect(new URL(frame.src).searchParams.get("enablejsapi")).toBe("1");
    const pollIndex = interval.mock.calls.findIndex(([, delay]) => delay === 250);
    const poll = interval.mock.calls[pollIndex]![0];
    await act(async () => media.play());
    poll();
    poll();
    await send("onReady", undefined, testWindow);
    const sent = () => postMessage.mock.calls.map(([message, target]) => ({ ...JSON.parse(message), target }));
    expect(sent().map(({ event }) => event)).toEqual(["listening", "listening"]);
    await send("initialDelivery", { playerState: -1 });
    await send("onReady");
    expect(clear).toHaveBeenCalledWith(interval.mock.results[pollIndex]?.value);
    expect(states).toEqual(["loading"]);
    await send("onStateChange", 1);
    await act(async () => media.toggle());
    expect(states.at(-1)).toBe("playing");
    await send("onStateChange", 2);
    expect(states).toEqual(["loading", "playing", "paused"]);
    expect(media.toggleMuted()).toBe(false);
    expect(sent().every(({ target, channel, id }) => target === origin && channel === "widget" && id === "gloom-media")).toBe(true);
    expect(sent().filter(({ func }) => func === "addEventListener").map(({ args }) => args[0])).toEqual([
      "onStateChange", "onError", "onAutoplayBlocked",
    ]);
    expect(sent().slice(5).map(({ func }) => func)).toEqual(["playVideo", "pauseVideo", "unMute"]);
  } finally {
    interval.mockRestore();
    clear.mockRestore();
  }
});

test("an embed configuration error shows the caller's browser action only for the active player", async () => {
  const { pane, states, onError, send } = await embed();
  await send("onStateChange", 1, testWindow);
  await send("onError", 153, undefined, "https://example.test");
  await send("onStateChange", "1");
  expect(states).toEqual(["loading"]);
  expect(onError).not.toHaveBeenCalled();
  await send("onError", 153);
  expect(states).toEqual(["loading", "error"]);
  expect(onError).toHaveBeenCalledWith("The embedded player could not play this stream.");
  expect(pane.querySelector("iframe")).toBeNull();
  expect(pane.querySelector("a")?.textContent).toBe("Open in browser");
  await send("onStateChange", 1);
  expect(states.at(-1)).toBe("error");
});

test("blocked autoplay leaves the embedded controls available for a manual play", async () => {
  const { pane, media, states, onError, send } = await embed();
  await send("onReady");
  await send("onStateChange", 3);
  await send("onAutoplayBlocked");
  await send("infoDelivery", { playerState: 3 });
  expect(states).toEqual(["loading", "idle"]);
  expect(onError).not.toHaveBeenCalled();
  expect(pane.querySelector("iframe")).not.toBeNull();
  await act(async () => media.play());
  expect(states.at(-1)).toBe("loading");
  await send("onStateChange", 1);
  expect(states.at(-1)).toBe("playing");
});

test("iframe playback after blocked autoplay supersedes a pending startup pause", async () => {
  const timer = spyOn(globalThis, "setTimeout");
  try {
    const { media, pane, states, onError, postMessage, send } = await embed();
    const attempt = timer.mock.calls.filter(([, delay]) => delay === 15_000).at(-1)![0];
    await send("onReady");
    await act(async () => media.pause());
    expect(JSON.parse(postMessage.mock.calls.at(-1)![0]).func).toBe("pauseVideo");
    await send("onAutoplayBlocked");
    expect(states).toEqual(["loading", "idle"]);
    await send("onStateChange", 1);
    await act(async () => attempt());
    expect(states).toEqual(["loading", "idle", "playing"]);
    expect(pane.querySelector("iframe")).not.toBeNull();
    expect(onError).not.toHaveBeenCalled();
  } finally {
    timer.mockRestore();
  }
});

test("ready followed by buffering and silence still expires the original play attempt", async () => {
  const timer = spyOn(globalThis, "setTimeout");
  try {
    const { pane, states, send } = await embed();
    const deadlines = () => timer.mock.calls.filter(([, delay]) => delay === 15_000).map(([expire]) => expire);
    const attempt = deadlines().at(-1)!;
    await send("onReady");
    await send("initialDelivery", { playerState: -1 });
    await send("infoDelivery", { playerState: 5 });
    await send("onStateChange", 3);
    await send("infoDelivery", { playerState: 3 });
    await send("infoDelivery", { playerState: 2 });
    expect(deadlines()).toHaveLength(2);
    expect(states).toEqual(["loading"]);
    await act(async () => attempt());
    expect(states).toEqual(["loading", "error"]);
    expect(pane.querySelector("a")?.textContent).toBe("Open in browser");
  } finally {
    timer.mockRestore();
  }
});

test("a delayed playing snapshot cannot clear a confirmed buffering deadline", async () => {
  const timer = spyOn(globalThis, "setTimeout");
  try {
    const { pane, states, send } = await embed();
    await send("onReady");
    await send("onStateChange", 1);
    await send("onStateChange", 3);
    const attempt = timer.mock.calls.filter(([, delay]) => delay === 15_000).at(-1)![0];
    await send("infoDelivery", { playerState: 1 });
    await act(async () => attempt());
    expect(states).toEqual(["loading", "playing", "loading", "error"]);
    expect(pane.querySelector("a")?.textContent).toBe("Open in browser");
  } finally {
    timer.mockRestore();
  }
});

test("a delayed buffering snapshot cannot start another deadline after confirmed playback", async () => {
  const timer = spyOn(globalThis, "setTimeout");
  try {
    const { states, send } = await embed();
    await send("onReady");
    await send("onStateChange", 3);
    await send("onStateChange", 1);
    const deadlines = () => timer.mock.calls.filter(([, delay]) => delay === 15_000).length;
    const before = deadlines();
    await send("infoDelivery", { playerState: 3 });
    expect(deadlines()).toBe(before);
    expect(states).toEqual(["loading", "playing"]);
  } finally {
    timer.mockRestore();
  }
});

test.each(["initialDelivery", "infoDelivery"] as const)("%s can confirm initial playback before a valid state transition", async (kind) => {
  const timer = spyOn(globalThis, "setTimeout");
  try {
    const { states, onError, send } = await embed();
    const attempt = timer.mock.calls.filter(([, delay]) => delay === 15_000).at(-1)![0];
    if (kind === "infoDelivery") await send("onReady");
    await send("onStateChange", "1");
    await send(kind, { playerState: 1 });
    await act(async () => attempt());
    expect(states).toEqual(["loading", "playing"]);
    expect(onError).not.toHaveBeenCalled();
  } finally {
    timer.mockRestore();
  }
});

test("pausing after the player ends does not hide a confirmed replay", async () => {
  const { media, states, postMessage, send } = await embed();
  await send("onReady");
  await send("onStateChange", 1);
  await send("onStateChange", 0);
  await act(async () => media.pause());
  expect(JSON.parse(postMessage.mock.calls.at(-1)![0]).func).toBe("pauseVideo");
  expect(states).toEqual(["loading", "playing", "idle"]);
  await send("onStateChange", 1);
  expect(states).toEqual(["loading", "playing", "idle", "playing"]);
});

test.each(["infoDelivery", "onStateChange"] as const)("replay buffering clears the play deadline only on an end transition (%s)", async (kind) => {
  const timer = spyOn(globalThis, "setTimeout");
  try {
    const { media, pane, states, onError, send } = await embed();
    await send("onReady");
    await send("onStateChange", 1);
    await send("onStateChange", 0);
    await act(async () => media.play());
    await send("onStateChange", 3);
    const attempt = timer.mock.calls.filter(([, delay]) => delay === 15_000).at(-1)![0];
    const confirmedEnd = kind === "onStateChange";
    await send(kind, confirmedEnd ? 0 : { playerState: 0 });
    await act(async () => attempt());
    expect(states).toEqual(["loading", "playing", "idle", "loading", confirmedEnd ? "idle" : "error"]);
    expect(pane.querySelector("iframe") !== null).toBe(confirmedEnd);
    expect(pane.querySelector("a")?.textContent).toBe(confirmedEnd ? undefined : "Open in browser");
    expect(onError).toHaveBeenCalledTimes(confirmedEnd ? 0 : 1);
  } finally {
    timer.mockRestore();
  }
});

test("explicit pause drops the deadline while seeking confirmation and manual play gets a new one", async () => {
  const timer = spyOn(globalThis, "setTimeout");
  try {
    const { media, states, send } = await embed();
    const currentDeadline = () => timer.mock.calls.filter(([, delay]) => delay === 15_000).at(-1)![0];
    const oldAttempt = currentDeadline();
    await send("onReady");
    await send("onStateChange", 3);
    await act(async () => media.pause());
    await send("infoDelivery", { playerState: 3 });
    await act(async () => oldAttempt());
    expect(states).toEqual(["loading"]);
    await send("onStateChange", 2);
    await act(async () => media.play());
    const newAttempt = currentDeadline();
    expect(newAttempt).not.toBe(oldAttempt);
    await act(async () => newAttempt());
    expect(states).toEqual(["loading", "paused", "loading", "error"]);
  } finally {
    timer.mockRestore();
  }
});

test("a source change and retry start fresh attempts and ignore the replaced player's timer", async () => {
  const timer = spyOn(globalThis, "setTimeout");
  try {
    const surface = await embed();
    const { changeSource, onError, pane, player, states } = surface;
    const currentDeadline = () => timer.mock.calls.filter(([, delay]) => delay === 15_000).at(-1)![0];
    const oldAttempt = currentDeadline();
    await changeSource(source.replace("abcdefghijk", "zyxwvutsrqp"));
    const changedAttempt = currentDeadline();
    expect(changedAttempt).not.toBe(oldAttempt);
    await act(async () => oldAttempt());
    await surface.send("onError", 153);
    expect(onError).not.toHaveBeenCalled();
    const changed = player();
    await changed.send("onReady");
    await changed.send("onError", 153);
    await act(async () => surface.media.play());
    const retryAttempt = currentDeadline();
    expect(retryAttempt).not.toBe(changedAttempt);
    await act(async () => changedAttempt());
    expect(onError).toHaveBeenCalledTimes(1);
    expect(pane.querySelector("iframe")).not.toBe(changed.frame);
    const retry = player();
    await retry.send("initialDelivery", { playerState: -1 });
    await retry.send("onStateChange", 1);
    await act(async () => retryAttempt());
    expect(states.at(-1)).toBe("playing");
    expect(onError).toHaveBeenCalledTimes(1);
  } finally {
    timer.mockRestore();
  }
});

test("a player that never reports readiness falls back instead of buffering indefinitely", async () => {
  const timer = spyOn(globalThis, "setTimeout");
  try {
    const { pane, states } = await embed();
    const expire = timer.mock.calls.find(([, delay]) => delay === 15_000)?.[0];
    expect(expire).toBeDefined();
    await act(async () => { expire?.(); });
    expect(states).toEqual(["loading", "error"]);
    expect(pane.querySelector("a")?.textContent).toBe("Open in browser");
  } finally {
    timer.mockRestore();
  }
});

test("native HLS still reports video events and shows the caller's fallback on failure", async () => {
  const states: string[] = [];
  const onError = mock();
  const videoPrototype = testWindow.HTMLVideoElement.prototype;
  const canPlayType = spyOn(videoPrototype, "canPlayType").mockReturnValue("probably");
  const play = spyOn(videoPrototype, "play").mockResolvedValue(undefined);
  const pause = spyOn(videoPrototype, "pause").mockImplementation(() => {});
  const load = spyOn(videoPrototype, "load").mockImplementation(() => {});
  try {
    const pane = await render(
      <WebMediaSurface src="https://example.test/stream.m3u8" autoPlay muted onPlaybackStateChange={(state) => states.push(state)} onError={onError}>
        Open in browser
      </WebMediaSurface>,
    );
    const video = pane.querySelector("video")!;
    expect(video.muted).toBe(true);
    expect(play).toHaveBeenCalledTimes(1);
    expect(states).toEqual(["loading"]);
    await act(async () => {
      for (const event of ["playing", "pause", "error"]) video.dispatchEvent(new Event(event));
    });
    expect(states).toEqual(["loading", "playing", "paused", "error"]);
    expect(onError).toHaveBeenCalledWith("The live stream could not be played.");
    expect(pane.textContent).toBe("Open in browser");
  } finally {
    for (const spy of [canPlayType, play, pause, load]) spy.mockRestore();
  }
});

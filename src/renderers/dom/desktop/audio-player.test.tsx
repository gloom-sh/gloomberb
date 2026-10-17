/** @jsxImportSource react */
import { expect, test } from "bun:test";
import { act, useState } from "react";
import type { HostAudioPlayerProps } from "../../../ui/host";
import { createDomTestHarness } from "../test-utils";
import { WebAudioPlayer } from "./audio-player";

const { render } = createDomTestHarness();

function props(key: string): HostAudioPlayerProps {
  return {
    src: `https://media.example.invalid/${key}.mp3`,
    sourceKey: key,
    label: key,
    durationSeconds: 60,
    rates: [1, 2],
    rate: 1,
    onRateChange: () => {},
    handleRef: { current: null },
  };
}

function Toggled() {
  const [shown, setShown] = useState(true);
  return (
    <>
      <button type="button" data-testid="leave" onClick={() => setShown(false)} />
      {shown ? <WebAudioPlayer {...props("leaving")} /> : null}
    </>
  );
}

test("starting one player stops the one already playing", async () => {
  const container = await render(<><WebAudioPlayer {...props("first")} /><WebAudioPlayer {...props("second")} /></>);
  const [first, second] = [...container.querySelectorAll("audio")] as HTMLAudioElement[];
  const paused: string[] = [];
  first!.pause = () => { paused.push("first"); };
  second!.pause = () => { paused.push("second"); };

  await act(async () => { first!.dispatchEvent(new Event("play")); });
  expect(paused).toEqual([]);
  await act(async () => { second!.dispatchEvent(new Event("play")); });
  expect(paused).toEqual(["first"]);
  // The one that was stopped does not stop the one now playing when it plays again.
  await act(async () => { first!.dispatchEvent(new Event("play")); });
  expect(paused).toEqual(["first", "second"]);
});

test("a player that goes away stops its recording and lets go of it", async () => {
  const container = await render(<Toggled />);
  const audio = container.querySelector("audio") as HTMLAudioElement;
  expect(audio.getAttribute("src")).toContain("leaving.mp3");
  let paused = 0;
  audio.pause = () => { paused += 1; };

  await act(async () => { (container.querySelector("[data-testid='leave']") as HTMLButtonElement).click(); });
  expect(container.querySelector("audio")).toBeNull();
  expect(paused).toBe(1);
  expect(audio.getAttribute("src")).toBeNull();
});

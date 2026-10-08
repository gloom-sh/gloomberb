import { describe, expect, test } from "bun:test";
import { parseChatComposerCommand } from "./composer-commands";

describe("parseChatComposerCommand", () => {
  test("parses direct-message commands with an optional draft", () => {
    expect(parseChatComposerCommand("/dm @Alice hello there")).toEqual({
      kind: "direct",
      username: "alice",
      draft: "hello there",
    });
    expect(parseChatComposerCommand("/dm Bob")).toEqual({
      kind: "direct",
      username: "bob",
      draft: "",
    });
  });

  test("parses group commands from tagged users and an optional name", () => {
    expect(parseChatComposerCommand("/group Infra desk @Alice @bob_123")).toEqual({
      kind: "group",
      usernames: ["alice", "bob_123"],
      name: "Infra desk",
    });
  });

  test("leaves malformed slash commands as normal chat text", () => {
    expect(parseChatComposerCommand("/dm ab hi")).toBeNull();
    expect(parseChatComposerCommand("/group Infra desk")).toBeNull();
  });

  test("parses /discord and its subcommands, ignoring case and spacing", () => {
    expect(parseChatComposerCommand("/discord")).toEqual({ kind: "discord", action: "connect" });
    expect(parseChatComposerCommand("/Discord  unlink")).toEqual({ kind: "discord", action: "unlink" });
    expect(parseChatComposerCommand("/discord mirror on")).toEqual({ kind: "discord", action: "mirror", enabled: true });
    expect(parseChatComposerCommand("/discord  MIRROR   off")).toEqual({ kind: "discord", action: "mirror", enabled: false });
  });

  test("answers a mistyped /discord with the usage instead of posting it to the channel", () => {
    for (const draft of ["/discord mirror", "/discord mirror maybe", "/discord mirror on please", "/discord unlink now", "/discord help"]) {
      expect(parseChatComposerCommand(draft)).toEqual({ kind: "discord", action: "usage" });
    }
    // A different word that merely starts with the command is ordinary text.
    expect(parseChatComposerCommand("/discordant")).toBeNull();
    expect(parseChatComposerCommand("see /discord")).toBeNull();
  });
});

import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { ChatDiscordLink } from "../../../api-client";
import { DISCORD_UNAVAILABLE, runDiscordCommand, type DiscordCommandApi } from "./discord-command";

function fakeApi(overrides: Partial<DiscordCommandApi> = {}) {
  const calls: string[] = [];
  const api: DiscordCommandApi = {
    getLink: async () => { calls.push("get"); return { linked: false, mirror: true }; },
    startLink: async () => { calls.push("start"); return { url: "https://discord.com/oauth2/authorize?client_id=1" }; },
    unlink: async () => { calls.push("unlink"); },
    setMirror: async (enabled) => { calls.push(`mirror:${enabled}`); },
    ...overrides,
  };
  return { api, calls };
}

function linked(link: Partial<ChatDiscordLink> = {}): DiscordCommandApi["getLink"] {
  return async () => ({ linked: true, discordUsername: "ada#1", mirror: true, ...link });
}

function missing(status: number) {
  return async () => { throw new ApiRequestError("Not found", status); };
}

describe("runDiscordCommand", () => {
  test("opens the authorize page and says to approve in the browser", async () => {
    const { api, calls } = fakeApi();
    const opened: string[] = [];
    const outcome = await runDiscordCommand({ kind: "discord", action: "connect" }, {
      api,
      openUrl: async (url) => { opened.push(url); },
    });
    expect(outcome).toEqual({ body: "Approve in your browser", type: "info" });
    expect(opened).toEqual(["https://discord.com/oauth2/authorize?client_id=1"]);
    expect(calls).toEqual(["get", "start"]);
  });

  test("does not open anything for a link that is not http(s)", async () => {
    const { api } = fakeApi({ startLink: async () => ({ url: "file:///etc/passwd" }) });
    const opened: string[] = [];
    const outcome = await runDiscordCommand({ kind: "discord", action: "connect" }, {
      api,
      openUrl: async (url) => { opened.push(url); },
    });
    expect(outcome.type).toBe("error");
    expect(opened).toEqual([]);
  });

  test("an account that is already linked shows who and what else it can do, without starting again", async () => {
    const { api, calls } = fakeApi({ getLink: linked({ mirror: false }) });
    const outcome = await runDiscordCommand({ kind: "discord", action: "connect" }, { api, openUrl: async () => {} });
    expect(outcome.body).toBe("Linked as ada#1. Mirroring is off. /discord mirror on|off, /discord unlink");
    expect(calls).toEqual([]);
  });

  test("a server without Discord sync answers 404 or 501 with one line, for every subcommand", async () => {
    for (const status of [404, 501]) {
      const api = fakeApi({ getLink: missing(status), startLink: missing(status), unlink: missing(status), setMirror: missing(status) }).api;
      for (const command of [
        { kind: "discord", action: "connect" },
        { kind: "discord", action: "unlink" },
        { kind: "discord", action: "mirror", enabled: false },
      ] as const) {
        expect(await runDiscordCommand(command, { api, openUrl: async () => {} })).toEqual({ body: DISCORD_UNAVAILABLE, type: "info" });
      }
    }
  });

  test("unlinking asks first, so a 404 means no Discord sync rather than nothing to unlink", async () => {
    const notLinked = fakeApi();
    expect(await runDiscordCommand({ kind: "discord", action: "unlink" }, { api: notLinked.api, openUrl: async () => {} }))
      .toEqual({ body: "Discord is not linked", type: "info" });
    expect(notLinked.calls).toEqual(["get"]);

    const isLinked = fakeApi({ getLink: linked() });
    expect((await runDiscordCommand({ kind: "discord", action: "unlink" }, { api: isLinked.api, openUrl: async () => {} })).type).toBe("success");
    expect(isLinked.calls).toEqual(["unlink"]);
  });

  test("sends the mirror choice and reports other failures as errors", async () => {
    const { api, calls } = fakeApi();
    await runDiscordCommand({ kind: "discord", action: "mirror", enabled: false }, { api, openUrl: async () => {} });
    expect(calls).toEqual(["mirror:false"]);

    const failing = fakeApi({ setMirror: async () => { throw new ApiRequestError("Sign in first", 401); } }).api;
    expect(await runDiscordCommand({ kind: "discord", action: "mirror", enabled: true }, { api: failing, openUrl: async () => {} }))
      .toEqual({ body: "Sign in first", type: "error" });
  });
});

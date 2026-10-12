import { describe, expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import type { ChatDiscordLink } from "../../../api-client";
import { DISCORD_LINK_URL, DISCORD_UNAVAILABLE, runDiscordCommand, type DiscordCommandApi } from "./discord-command";

const NOT_LINKED: ChatDiscordLink = { linked: false, mirror: true, available: true };

function fakeApi(overrides: Partial<DiscordCommandApi> = {}) {
  const calls: string[] = [];
  const api: DiscordCommandApi = {
    getLink: async () => { calls.push("get"); return NOT_LINKED; },
    unlink: async () => { calls.push("unlink"); },
    setMirror: async (enabled) => { calls.push(`mirror:${enabled}`); },
    ...overrides,
  };
  return { api, calls };
}

function answering(link: Partial<ChatDiscordLink>): DiscordCommandApi["getLink"] {
  return async () => ({ ...NOT_LINKED, ...link });
}

function missing(status: number) {
  return async () => { throw new ApiRequestError("Not found", status); };
}

describe("runDiscordCommand", () => {
  test("opens the connect page on gloom.sh and leaves the Discord approval to it", async () => {
    const { api, calls } = fakeApi();
    const opened: string[] = [];
    const outcome = await runDiscordCommand({ kind: "discord", action: "connect" }, {
      api,
      openUrl: async (url) => { opened.push(url); },
    });
    expect(outcome).toEqual({ body: "Opened gloom.sh in your browser to connect Discord", type: "info" });
    expect(opened).toEqual([DISCORD_LINK_URL]);
    // The browser may have no gloom.sh session, so the app must not start the authorization for it.
    expect(calls).toEqual(["get"]);
  });

  test("an account that is already linked shows who and what else it can do, without opening anything", async () => {
    const { api } = fakeApi({ getLink: answering({ linked: true, discordUsername: "ada#1", mirror: false }) });
    const opened: string[] = [];
    const outcome = await runDiscordCommand({ kind: "discord", action: "connect" }, {
      api,
      openUrl: async (url) => { opened.push(url); },
    });
    expect(outcome.body).toBe("Linked as ada#1. Mirroring is off. /discord mirror on|off, /discord unlink");
    expect(opened).toEqual([]);
  });

  test("linking switched off on the server reads as not available yet, even for a linked account", async () => {
    for (const link of [{}, { linked: true }]) {
      const { api } = fakeApi({ getLink: answering({ available: false, ...link }) });
      const opened: string[] = [];
      for (const action of ["connect", "unlink"] as const) {
        expect(await runDiscordCommand({ kind: "discord", action }, { api, openUrl: async (url) => { opened.push(url); } }))
          .toEqual({ body: DISCORD_UNAVAILABLE, type: "info" });
      }
      expect(opened).toEqual([]);
    }
  });

  test("a server without Discord sync answers 404 or 501 with one line, for every subcommand", async () => {
    for (const status of [404, 501]) {
      const api = fakeApi({ getLink: missing(status), unlink: missing(status), setMirror: missing(status) }).api;
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

    const isLinked = fakeApi({ getLink: answering({ linked: true }) });
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

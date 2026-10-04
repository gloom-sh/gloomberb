import { describe, expect, test } from "bun:test";
import { createWallExperimentSession, type WallExperimentContext } from "./wall-experiments";
import { EXPERIMENTS_STORAGE_KEY, type ExperimentAnswer } from "./web-experiments";

function storage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function context(overrides: Partial<WallExperimentContext> = {}): WallExperimentContext {
  return { surface: "web", anonymousId: "visitor-one", pro: false, optedOut: false, automated: false, local: storage(), session: storage(), ...overrides };
}

describe("wall experiment sessions", () => {
  test("concurrent walls share an exposure and later mounts and browser reloads keep its answer", async () => {
    const session = createWallExperimentSession();
    const ctx = context();
    const answer = Promise.withResolvers<ExperimentAnswer>();
    let calls = 0;
    const ask = async () => { calls++; return answer.promise; };
    const first = session.expose(ctx, ask);
    const second = session.expose(ctx, ask);
    answer.resolve({ accepted: true, variant: "teaser" });
    expect(await Promise.all([first, second])).toEqual(["teaser", "teaser"]);
    expect(await session.expose(ctx, ask)).toBe("teaser");
    expect(await createWallExperimentSession().expose(ctx, ask)).toBe("teaser");
    expect(calls).toBe(1);
  });

  test("the browser sends its first arm in a new session while the API's account answer wins", async () => {
    const local = storage({ [EXPERIMENTS_STORAGE_KEY]: "web_terminal_trial_offer:offer" });
    const received: Array<string | undefined> = [];
    await createWallExperimentSession().expose(context({ local }), async (variant) => {
      received.push(variant);
      return { accepted: true, variant: "teaser" };
    });
    const session = createWallExperimentSession();
    const signedIn = context({ local, accountId: "free-account" });
    expect(await session.expose(signedIn, async (variant) => {
      received.push(variant);
      return { accepted: true, variant: "control" };
    })).toBe("control");
    expect(received).toEqual([undefined, "teaser"]);
    expect(session.variant(signedIn)).toBe("control");
    expect(local.getItem(EXPERIMENTS_STORAGE_KEY)).toBe("web_terminal_trial_offer:offer,wall_teaser:teaser");
  });

  test("accounts on each surface have independent sessions and native visitors never qualify", async () => {
    const session = createWallExperimentSession();
    const seen: string[] = [];
    for (const surface of ["web", "desktop", "tui", "cli"] as const) {
      const ctx = context({ surface, accountId: `account-${surface}` });
      expect(await session.expose(ctx, async () => {
        seen.push(surface);
        return { accepted: true, variant: "control" };
      })).toBe("control");
      if (surface !== "web") expect(await session.expose(context({ surface }), async () => {
        throw new Error("Native visitors must not ask, even with a desktop handoff id");
      })).toBeNull();
    }
    expect(seen).toEqual(["web", "desktop", "tui", "cli"]);
  });

  test("account changes cannot inherit the previous account's in-flight response", async () => {
    const session = createWallExperimentSession();
    const first = Promise.withResolvers<ExperimentAnswer>();
    const one = context({ accountId: "one" });
    const two = context({ accountId: "two" });
    const waiting = session.expose(one, () => first.promise);
    expect(await session.expose(two, async () => ({ accepted: true, variant: "control" }))).toBe("control");
    first.resolve({ accepted: true, variant: "teaser" });
    expect(await waiting).toBe("teaser");
    expect(session.variant(two)).toBe("control");
  });

  test("opted-out, automated, Pro and unidentified visitors never ask even with a saved arm", async () => {
    for (const overrides of [{ optedOut: true }, { automated: true }, { pro: true }, { anonymousId: undefined }]) {
      const ctx = context({ ...overrides, local: storage({ [EXPERIMENTS_STORAGE_KEY]: "wall_teaser:teaser" }) });
      let asked = false;
      expect(await createWallExperimentSession().expose(ctx, async () => {
        asked = true;
        return { accepted: true, variant: "teaser" };
      })).toBeNull();
      expect(asked).toBe(false);
    }
  });

  test("a stopped experiment overrides a saved teaser and stays excluded on reload", async () => {
    const ctx = context({ local: storage({ [EXPERIMENTS_STORAGE_KEY]: "wall_teaser:teaser" }) });
    const session = createWallExperimentSession();
    expect(await session.expose(ctx, async () => ({ accepted: false }))).toBeNull();
    expect(session.variant(ctx)).toBeUndefined();
    expect(await createWallExperimentSession().expose(ctx, async () => {
      throw new Error("An excluded session must not ask again");
    })).toBeNull();
  });

  test("422 or connection failures show control without counting or retaining a stale arm", async () => {
    const ctx = context({ local: storage({ [EXPERIMENTS_STORAGE_KEY]: "wall_teaser:teaser" }) });
    const session = createWallExperimentSession();
    expect(await session.expose(ctx, async () => { throw new Error("422"); })).toBeNull();
    expect(session.variant(ctx)).toBeUndefined();
    expect(await session.expose(ctx, async () => ({ accepted: true, variant: "teaser" }))).toBe("teaser");
  });
});

describe("sign-in wall experiment sessions", () => {
  test("keeps its first arm and session exposure separate from the Pro wall experiment", async () => {
    const ctx = context();
    const signin = createWallExperimentSession("wall_teaser_signin");
    const answer = Promise.withResolvers<ExperimentAnswer>();
    const received: Array<string | undefined> = [];
    const ask = async (variant: string | undefined) => { received.push(variant); return answer.promise; };
    const first = signin.expose(ctx, ask);
    const concurrent = signin.expose(ctx, ask);
    answer.resolve({ accepted: true, variant: "teaser" });
    expect(await Promise.all([first, concurrent])).toEqual(["teaser", "teaser"]);
    expect(await createWallExperimentSession("wall_teaser_signin").expose(ctx, ask)).toBe("teaser");
    expect(received).toEqual([undefined]);
    await createWallExperimentSession().expose(ctx, async () => ({ accepted: true, variant: "control" }));
    expect(ctx.local?.getItem(EXPERIMENTS_STORAGE_KEY)).toBe("wall_teaser_signin:teaser,wall_teaser:control");
    expect(await createWallExperimentSession("wall_teaser_signin").expose({ ...ctx, session: storage() }, async (variant) => {
      expect(variant).toBe("teaser");
      return { accepted: true, variant: "teaser" };
    })).toBe("teaser");
  });

  test("signed-in accounts, native visitors, opt-outs and automation never enroll even with a saved arm", async () => {
    const signin = createWallExperimentSession("wall_teaser_signin");
    const ctx = context();
    await signin.expose(ctx, async () => ({ accepted: true, variant: "teaser" }));
    for (const overrides of [
      { accountId: "unverified-free" }, { accountId: "verified-free" }, { accountId: "pro", pro: true },
      { surface: "desktop" as const }, { surface: "tui" as const }, { surface: "cli" as const },
      { anonymousId: undefined }, { optedOut: true }, { automated: true },
    ]) {
      let asked = false;
      expect(await signin.expose({ ...ctx, ...overrides }, async () => {
        asked = true;
        return { accepted: true, variant: "teaser" };
      })).toBeNull();
      expect(asked).toBe(false);
      expect(signin.variant({ ...ctx, ...overrides })).toBeUndefined();
    }
  });

  test("a stale teaser never renders on an unavailable or stopped experiment", async () => {
    const ctx = context({ local: storage({ [EXPERIMENTS_STORAGE_KEY]: "wall_teaser_signin:teaser" }) });
    const signin = createWallExperimentSession("wall_teaser_signin");
    expect(await signin.expose(ctx, async () => { throw new Error("422"); })).toBeNull();
    expect(signin.variant(ctx)).toBeUndefined();
    expect(await signin.expose(ctx, async () => ({ accepted: false }))).toBeNull();
    let asked = false;
    expect(await createWallExperimentSession("wall_teaser_signin").expose(ctx, async () => {
      asked = true;
      return { accepted: true, variant: "teaser" };
    })).toBeNull();
    expect(asked).toBe(false);
  });
});

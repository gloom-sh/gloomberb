import { describe, expect, mock, test } from "bun:test";
import { createUpgradeExperimentSession, type UpgradeExperimentContext } from "./upgrade-experiment";
import type { ExperimentAnswer } from "./web-experiments";

function storage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => void values.set(key, value) };
}

const account: UpgradeExperimentContext = { accountId: "free-account", pro: false, optedOut: false, automated: false };

describe("upgrade_personalized exposure", () => {
  test("surfaces shown together share one exposure, and the answer holds for the session", async () => {
    const session = storage();
    const answer = Promise.withResolvers<ExperimentAnswer>();
    const ask = mock(() => answer.promise);
    const experiment = createUpgradeExperimentSession();
    const onboarding = experiment.expose({ ...account, session }, ask);
    const sheet = experiment.expose({ ...account, session }, ask);
    answer.resolve({ accepted: true, variant: "personalized" });
    expect(await Promise.all([onboarding, sheet])).toEqual(["personalized", "personalized"]);
    expect(ask).toHaveBeenCalledTimes(1);
    // A reload in the same browser session keeps it without asking again.
    const reloaded = createUpgradeExperimentSession();
    expect(reloaded.known({ ...account, session })).toBe("personalized");
    expect(await reloaded.expose({ ...account, session }, ask)).toBe("personalized");
    expect(ask).toHaveBeenCalledTimes(1);
    // Cached answers cannot bypass a later opt-out or account change.
    expect(reloaded.known({ ...account, session, optedOut: true })).toBeNull();
    expect(reloaded.known({ ...account, session, accountId: undefined })).toBeNull();
    expect(reloaded.known({ ...account, session, accountId: "other-account" })).toBeUndefined();
  });

  test("a failed request is not an exposure, and the API's no is kept for the session", async () => {
    const experiment = createUpgradeExperimentSession();
    expect(await experiment.expose(account, () => Promise.reject(new Error("422")))).toBeNull();
    expect(experiment.known(account)).toBeUndefined();
    const ask = mock(async (): Promise<ExperimentAnswer> => ({ accepted: false }));
    expect(await experiment.expose(account, ask)).toBeNull();
    expect(await experiment.expose(account, ask)).toBeNull();
    expect(ask).toHaveBeenCalledTimes(1);
    expect(experiment.known(account)).toBeNull();
  });
});

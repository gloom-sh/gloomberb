import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { t } from "../../../i18n";
import {
  DELETE_ACCOUNT_LOG_IN_AGAIN,
  type DeleteAccountMessage,
  deleteAccountConfirmingSession,
  deleteAccountRefusal,
} from "./delete-account";

const refused = (status: number, details?: Record<string, unknown>) =>
  new ApiRequestError("refused", status, undefined, undefined, details);

test("an old session's refusal asks for the password or for logging in again", () => {
  expect(deleteAccountRefusal(refused(403, { message: "Confirm your password.", confirm: "password" }))).toBe("password");
  expect(deleteAccountRefusal(refused(403, { message: "Log in again.", confirm: "log_in" }))).toBe("log_in");
});

test("any other failure is shown as it is", () => {
  expect(deleteAccountRefusal(refused(403, { message: "Origin is not allowed" }))).toBeNull();
  expect(deleteAccountRefusal(refused(429, { message: "Too many tries." }))).toBeNull();
  expect(deleteAccountRefusal(refused(500, { confirm: "password" }))).toBeNull();
  expect(deleteAccountRefusal(refused(403, { confirm: "something-else" }))).toBeNull();
  expect(deleteAccountRefusal(new Error("offline"))).toBeNull();
});

/** The account pane's delete, after the user confirmed, with what it did. */
function deleting(answers: Array<() => Promise<void>>) {
  const removed: Array<string | undefined> = [];
  const asked: Array<(password: string) => Promise<void>> = [];
  const messages: Array<DeleteAccountMessage | null> = [];
  const busy: boolean[] = [];
  let deleted = 0;
  const run = deleteAccountConfirmingSession({
    remove: async (password) => {
      removed.push(password);
      const answer = answers.shift();
      if (!answer) throw new Error("No answer left");
      await answer();
    },
    askPassword: (submit) => { asked.push(submit); },
    deleted: async () => { deleted += 1; },
    setBusy: (value) => { busy.push(value); },
    setMessage: (message) => { messages.push(message); },
  });
  return { run, removed, asked, messages, busy, deleted: () => deleted };
}

const refusedWith = (confirm: string, message: string) => async () => {
  throw new ApiRequestError(message, 403, undefined, undefined, { message, confirm });
};
const ok = async () => {};

test("the pane deletes at once from a session signed in within a day", async () => {
  const flow = deleting([ok]);
  await flow.run;
  expect(flow.removed).toEqual([undefined]);
  expect(flow.deleted()).toBe(1);
  expect(flow.asked).toEqual([]);
  expect(flow.busy).toEqual([true, false]);
});

test("refused for an old session, the pane asks for the password and deletes with it", async () => {
  const flow = deleting([
    refusedWith("password", "Confirm your password, or log in again, to delete your account."),
    ok,
  ]);
  await flow.run;
  // The refusal opens the password dialog, and shows no error of its own.
  expect(flow.asked).toHaveLength(1);
  expect(flow.messages.at(-1)).toBeNull();
  expect(flow.deleted()).toBe(0);

  await flow.asked[0]!("the-password");
  expect(flow.removed).toEqual([undefined, "the-password"]);
  expect(flow.deleted()).toBe(1);
  expect(flow.busy).toEqual([true, false, true, false]);
});

test("a wrong password keeps the dialog asking, with the server's answer", async () => {
  const flow = deleting([
    refusedWith("password", "Confirm your password, or log in again, to delete your account."),
    refusedWith("password", "That password is not right."),
  ]);
  await flow.run;
  await expect(flow.asked[0]!("a-guess")).rejects.toThrow("That password is not right.");
  expect(flow.removed).toEqual([undefined, "a-guess"]);
  expect(flow.deleted()).toBe(0);
});

test("an account with no password is told to sign in again through the browser, and asked nothing", async () => {
  const flow = deleting([refusedWith("log_in", "To delete your account, sign out of gloom.sh in your browser and back in, then sign out here and back in.")]);
  await flow.run;
  expect(flow.asked).toEqual([]);
  expect(flow.messages.at(-1)).toEqual({ tone: "error", text: t(DELETE_ACCOUNT_LOG_IN_AGAIN) });
  // Logging out and in here alone would bring another old session: the
  // app signs in through the browser's session.
  expect(DELETE_ACCOUNT_LOG_IN_AGAIN).toBe(
    "To delete your account, sign out of gloom.sh in your browser and back in, then log out here and back in.",
  );
  expect(flow.deleted()).toBe(0);
});

test("any other failure shows the server's message and asks nothing", async () => {
  const flow = deleting([async () => {
    throw new ApiRequestError("Too many tries: wait a few minutes.", 429);
  }]);
  await flow.run;
  expect(flow.asked).toEqual([]);
  expect(flow.messages.at(-1)).toEqual({ tone: "error", text: "Too many tries: wait a few minutes." });
  expect(flow.busy).toEqual([true, false]);
});

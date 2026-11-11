import { expect, test } from "bun:test";
import { ApiRequestError } from "../../../api-client/errors";
import { deleteAccountRefusal } from "./delete-account";

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

import { describe, expect, test } from "bun:test";
import { createTestTeam } from "../../../team/test-fixture";
import { mayDeleteNote } from "./owner";

describe("mayDeleteNote", () => {
  const desk = { kind: "team" as const, teamId: "desk" };
  const member = [createTestTeam({ id: "desk", role: "member" })];
  const admin = [createTestTeam({ id: "desk", role: "admin" })];

  test("my notes, and team notes I wrote, are mine to delete", () => {
    expect(mayDeleteNote({ owner: { kind: "user" }, createdBy: "u2" }, member, "me")).toBe(true);
    expect(mayDeleteNote({ owner: desk, createdBy: "me" }, member, "me")).toBe(true);
  });

  test("a teammate's note, or one with no known author, is a team admin's to delete", () => {
    expect(mayDeleteNote({ owner: desk, createdBy: "u2" }, member, "me")).toBe(false);
    expect(mayDeleteNote({ owner: desk, createdBy: null }, member, "me")).toBe(false);
    expect(mayDeleteNote({ owner: desk, createdBy: "u2" }, member, null)).toBe(false);
    expect(mayDeleteNote({ owner: desk, createdBy: "u2" }, [], "me")).toBe(false);
    expect(mayDeleteNote({ owner: desk, createdBy: "u2" }, admin, "me")).toBe(true);
    expect(mayDeleteNote({ owner: desk, createdBy: null }, admin, "me")).toBe(true);
  });

  test("a note the server sent no author for stays deletable, as that server allows", () => {
    expect(mayDeleteNote({ owner: desk }, member, "me")).toBe(true);
  });
});

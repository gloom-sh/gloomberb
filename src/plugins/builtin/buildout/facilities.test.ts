import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { apiClient } from "../../../api-client";
import type { AuthUser, BuildoutAccountResponse } from "../../../api-client/types";
import { setHttpFetchTransport } from "../../../utils/http-transport";
import { facilitiesLayer } from "./facilities";

const point = (id: string, owner: string, type: string, powerCapacity: string | null = null) => ({
  id, name: `Site ${id}`, type, ownerCompanyId: owner, ownerTicker: owner.toUpperCase(), powerCapacity, lat: 40, lng: -100,
});

let asked: string[] = [];
let signedIn: ReturnType<typeof spyOn<typeof apiClient, "isSignedIn">>;
beforeEach(() => {
  asked = [];
  signedIn = spyOn(apiClient, "isSignedIn").mockReturnValue(false);
  setHttpFetchTransport(async (input, init) => {
    const url = new URL(String(input));
    asked.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/sites/world-map" && url.searchParams.get("company") === "NOPE") return new Response("Company not found", { status: 404 });
    if (url.pathname === "/sites/world-map") {
      const paid = new Headers(init?.headers).get("Authorization") === "Bearer fixture-token";
      return Response.json({ points: [
        point("a", "crwv", "Data Center", "300.00 MW"),
        point("b", "corz", "Data Center", "1.2 GW"),
        point("c", "nvda", "Office"),
        point("d", "msft", "Data Center"),
        ...(paid ? [point("p", "orcl", "Data Center", "5 GW")] : []),
      ] });
    }
    // A free account sees the theme's first companies; the rest are blurred and never listed.
    if (url.pathname === "/companies") return Response.json({ companies: [{ id: "crwv" }, { id: "corz" }], blurredCount: 9 });
    return new Response("unexpected", { status: 500 });
  });
});
afterEach(() => {
  signedIn.mockRestore();
  setHttpFetchTransport(null);
});

const entities = (scope: string | null) => facilitiesLayer.entities({ q: "", sort: null, dir: "desc", limit: 50, offset: 0, bbox: null, scope });

test("a theme shows the sites owned by the theme's companies the account can see, largest first, without offices", async () => {
  const page = await entities("theme:neoclouds");
  expect(page.rows.map((row) => [row.id, row.props.mw])).toEqual([["b", 1200], ["a", 300]]);
  expect(asked).toContain("/companies?list=neoclouds&limit=200&offset=0&sort=marketCap&order=desc");
});

test("a company the dataset does not know has no sites rather than an error", async () => {
  const page = await entities("company:NOPE");
  expect(page.rows).toEqual([]);
  expect(asked).toEqual(["/sites/world-map?company=NOPE"]);
});

test("paid sites leave the map at sign-out, and the free set never stands in for a plan", async () => {
  const user = { id: "fixture-user" } as AuthUser;
  const spies = [
    spyOn(apiClient, "getCurrentUser").mockReturnValue(user),
    spyOn(apiClient, "getSession").mockResolvedValue(user),
    spyOn(apiClient, "getBuildoutAccount").mockResolvedValue({ subscription: { active: true } } as BuildoutAccountResponse),
    spyOn(apiClient, "getBuildoutToken").mockResolvedValue({ token: "fixture-token", expiresAt: new Date(Date.now() + 600_000).toISOString() }),
  ];
  try {
    const ids = async () => (await entities(null)).rows.map((row) => row.id);
    expect(await ids()).not.toContain("p");
    signedIn.mockReturnValue(true);
    expect(await ids()).toContain("p");
    signedIn.mockReturnValue(false);
    expect(await ids()).not.toContain("p");
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
});

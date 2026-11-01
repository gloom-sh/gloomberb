import { expect, test } from "bun:test";
import { normalizeCompanyProfile, totalPowerMw } from "./model";

/** CoreWeave's supply chain as the dataset gives it, trimmed to the fields the flow reads. */
const COREWEAVE = {
  id: "co-crwv",
  name: "CoreWeave",
  ticker: "CRWV",
  supplyChain: {
    suppliers: [
      { companyId: "bloom", name: "Bloom Energy", ticker: "BE", flowCategory: "data_center_onsite_power", description: "Bloom Energy deploys fuel-cell power systems for CoreWeave at the Volo AI data center." },
      { companyId: "corz", name: "Core Scientific", ticker: "CORZ", flowCategory: "colocation_capacity_supply", weightUsd: 10_200_000_000, weightPeriod: "12-year contract terms", evidenceSummary: "Core Scientific announced 12-year HPC hosting contracts and expansions with CoreWeave, including 70 MW of additional infrastructure at Denton and approximately 590 MW of contracted critical IT load across six Core Scientific sites." },
      // The same company again, for another thing it supplies: one card, the one with a figure.
      { companyId: "bloom", name: "Bloom Energy", ticker: "BE", flowCategory: "onsite_data_center_power", description: "Bloom Energy supplies onsite fuel-cell power for CoreWeave." },
      { companyId: "apld", name: "Applied Digital", ticker: "APLD", flowCategory: "data_center_capacity", weightUsd: 11_000_000_000, weightPeriod: "approximately 15-year CoreWeave lease agreements", description: "Applied Digital leases 400 MW of Polaris Forge 1 AI Factory critical IT load in Ellendale, North Dakota to CoreWeave under long-term agreements." },
      { companyId: "nvda", name: "NVIDIA", ticker: "NVDA", flowCategory: "confidential_ai_compute", relationshipScope: "software_platform" },
      { companyId: "dell", name: "Dell Technologies", ticker: "DELL", relationshipScope: "ai_compute_supply_chain", description: "Dell supplies integrated NVIDIA GB300 NVL72 racks to CoreWeave." },
    ],
    customers: [
      { companyId: "openai", name: "OpenAI", flowCategory: "cloud GPU compute services", evidenceSummary: "OpenAI committed up to approximately $6.5 billion through May 2031 under an expanded order form." },
      { companyId: "msft", name: "Microsoft", ticker: "MSFT", flowCategory: "AI cloud capacity", weightUsd: 3_417_000_000, weightPeriod: "FY2025", evidenceSummary: "CoreWeave disclosed Microsoft as its top customer, representing approximately 67% of FY2025 revenue." },
    ],
    competitors: [{ companyId: "nbis", name: "Nebius", ticker: "NBIS" }],
  },
};

test("power and hosting deals are read apart from suppliers, with the MW, money and term their texts give", () => {
  const profile = normalizeCompanyProfile(COREWEAVE, "free");
  const byRole = (role: string) => profile.relations.filter((entry) => entry.role === role).map((entry) => [entry.name, entry.figure]);
  // The relationship's total, not the expansion it mentions first, in order of MW; a deal with no figure says what it is.
  expect(byRole("power")).toEqual([
    ["Core Scientific", "590 MW · $10.2B · 12 yr"],
    ["Applied Digital", "400 MW · $11B · 15 yr"],
    ["Bloom Energy", "Data center onsite power"],
  ]);
  expect(byRole("supplier")).toEqual([["NVIDIA", "Confidential AI compute"], ["Dell Technologies", "AI compute supply chain"]]);
  expect(byRole("customer")).toEqual([
    ["Microsoft", "67% of FY2025 revenue"],
    ["OpenAI", "$6.5B through May 2031"],
  ]);
  expect(byRole("competitor").map(([name]) => name)).toEqual(["Nebius"]);
  expect(totalPowerMw(profile)).toBe(990);
});

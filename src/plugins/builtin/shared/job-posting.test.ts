import { expect, test } from "bun:test";
import { employmentText, postingPlace, postingTitle } from "./job-posting";

test("a place names its country, and never reads a state code as one", () => {
  const place = (location: string | null, country: string | null, remote: boolean | null = null) => postingPlace({ location, country, remote });
  expect(place("Paris, FR", "FR")).toBe("Paris, France");
  expect(place("Toronto, ON, CA", "CA")).toBe("Toronto, ON, Canada");
  expect(place("Sacramento, CA", "US")).toBe("Sacramento, CA, United States");
  // No country: "CA" is as likely California, so it stays as written.
  expect(place("Sacramento, CA", null)).toBe("Sacramento, CA");
  expect(place("Austin, TX; Denver, CO", "US")).toBe("Austin, TX; Denver, CO");
  expect(place(null, "DE", true)).toBe("Germany · Remote");
  expect(place(null, null)).toBeNull();
});

test("a title the careers system never gave, and hours in words", () => {
  expect(postingTitle("Job 481078358194-engineering-manager-st-nashville-tn", "481078358194-engineering-manager-st-nashville-tn")).toBe("Untitled role");
  expect(postingTitle("Job R-2606711")).toBe("Untitled role");
  expect(postingTitle("Barista Store 325 Boul Gr%C3%A9ber")).toBe("Untitled role");
  expect(postingTitle("shift supervisor - Store# 84768, ATRIUM TWO")).toBe("shift supervisor - Store# 84768, ATRIUM TWO");
  expect(postingTitle("Engineer 2")).toBe("Engineer 2");
  expect([employmentText("FULL_TIME"), employmentText("Full-time"), employmentText("CDI"), employmentText("UNAVAILABLE")]).toEqual(["Full time", "Full time", "CDI", null]);
});

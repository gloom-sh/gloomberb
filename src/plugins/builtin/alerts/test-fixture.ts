import { afterEach, beforeEach, setSystemTime } from "bun:test";

export function useAlertTestClock(): void {
  beforeEach(() => setSystemTime(new Date("2026-11-20T15:00:00Z")));
  afterEach(() => setSystemTime());
}

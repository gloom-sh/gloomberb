/**
 * Test helpers for external plugin repositories (`gloomberb/test-support`).
 *
 * Plugins live in their own repos and run their own `bun test`, so the fakes
 * they need to exercise persistence-backed logic have to ship with the host
 * rather than being copied per plugin and drifting.
 */

export { MemoryPluginPersistence } from "../test-support/plugin-persistence";

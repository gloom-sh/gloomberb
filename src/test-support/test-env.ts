/**
 * Tests run against React's development build, the only one that exports
 * `act`. A shell that exports NODE_ENV=production would otherwise load the
 * production build, and every test importing `act` would fail to load. Listed
 * first in bunfig.toml's preload, so it runs before anything imports React.
 */
process.env.NODE_ENV = "test";

/**
 * Tests never send crash reports or usage counts. Each test home looks like a
 * brand-new install to the service, so a run that reached it would count dozens
 * of installs that exist for the length of one test. Set here, the opt-out also
 * reaches every process a test starts with the inherited environment (a CLI
 * run, a packaged entry), which the in-process guard in `telemetry-guard.ts`
 * cannot see. A test that checks telemetry itself calls `allowTelemetryInTests`
 * from that file and stubs where the report goes.
 */
process.env.GLOOMBERB_NO_TELEMETRY = "1";
process.env.DO_NOT_TRACK = "1";

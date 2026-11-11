/**
 * Tests run against React's development build, the only one that exports
 * `act`. A shell that exports NODE_ENV=production would otherwise load the
 * production build, and every test importing `act` would fail to load. Listed
 * first in bunfig.toml's preload, so it runs before anything imports React.
 */
process.env.NODE_ENV = "test";

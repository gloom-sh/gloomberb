# Baseline verification

The starting main revision was `5ce0c7c5a08ec2eabc738a6789d5e8d9e9c80db4`. It was checked before changing the header.

| Behavior | Baseline result | Evidence |
|---|---|---|
| Help and the market summary keep their cells | Already fixed at the requested widths | [Actual terminal frames](terminal/header-frames.md) |
| A failed update remains visible at common widths | Already fixed, including the compact message and retry key at 80 columns | [Failed frames](terminal/header-frames.md#failed) |
| Transient update-check notices stay inside their slot | Already clipped | [Notice frames](terminal/header-frames.md#notice) |
| Update failures reach error tracking without raw user paths | Already sends fixed phase/code values in a plain object without an error stack | [Reporter](https://github.com/gloom-sh/gloomberb/blob/5ce0c7c5a08ec2eabc738a6789d5e8d9e9c80db4/src/telemetry/update-failures.ts), [existing regression tests](https://github.com/gloom-sh/gloomberb/blob/5ce0c7c5a08ec2eabc738a6789d5e8d9e9c80db4/src/telemetry/update-failures.test.ts) |
| Optional status parts fit whole or give way | Still incomplete: narrow ready/download messages and a 60-column failure reason ended mid-word | [Before/after frames](terminal/header-frames.md) |

The change therefore only adjusts terminal status fitting. Existing updater and telemetry tests pass as part of the 63-test focused run. The desktop/web status renderer is unchanged.

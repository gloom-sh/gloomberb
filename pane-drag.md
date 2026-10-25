# Drag and resize validation

Base: `4c11d3c99f0849cda8e9a7f296272fc7d73d2a22`. Head: `9a04f6db778bbe451c7811a5c57bea829102bd7d`.

The benchmark failed absolute pointer-lag checks after its built-in remeasurement: ten alternating runs per revision. Five scenarios exceed the 24 px limit on the head; nine frame/content checks fail. The dock divider changes from 12.93 to 27.75 px, while the other failing scenarios exceed the limit on both revisions. No main-thread, commit-count, release-jump or bitmap-sharpness violation is listed. The run does not establish the cause. No additional manual rerun was used.

The pane-control suite separately passed all 327 checks.

### Pane drag and resize frame budget

Middle value of 10 alternating runs per side, 1.5 s drags at 60 moves a second, headless Chrome without a GPU. Frames are animation frames, not GPU-presented frames; missed frames are estimated against a 60 Hz display. Behind the pointer: how far the dragged edge of the frame, and of the content in it, was from where the pointer had it, in px (95th percentile). Jump on release: how far the frame's and the content's edge moved when the pointer let go where it rested.

| | main | this PR |
|---|---|---|
| docked pane drag: main thread per frame | 1.1 ms | 1.07 ms |
| docked pane drag: script per frame | 0.36 ms | 0.35 ms |
| docked pane drag: style and layout per frame | 0.11 ms | 0.11 ms |
| docked pane drag: React commits | 9 | 9 |
| docked pane drag: frames per second | 59.04 | 59.1 |
| docked pane drag: frame time p95 | 16.8 ms | 16.8 ms |
| docked pane drag: missed frames (est., 60 Hz) | 1 | 1 |
| docked pane drag: intervals over 1.5 frames | 1 | 1 |
| floating pane drag: main thread per frame | 0.97 ms | 1.02 ms |
| floating pane drag: script per frame | 0.29 ms | 0.31 ms |
| floating pane drag: style and layout per frame | 0.1 ms | 0.11 ms |
| floating pane drag: React commits | 5 | 5.5 |
| floating pane drag: frames per second | 57.45 | 57.95 |
| floating pane drag: frame time p95 | 16.8 ms | 16.8 ms |
| floating pane drag: missed frames (est., 60 Hz) | 4 | 2 |
| floating pane drag: intervals over 1.5 frames | 2 | 1 |
| news table resize: main thread per frame | 5.02 ms | 5.14 ms |
| news table resize: script per frame | 1.02 ms | 1.12 ms |
| news table resize: style and layout per frame | 1.1 ms | 1.12 ms |
| news table resize: React commits | 35.5 | 34.5 |
| news table resize: frames per second | 58.13 | 54.75 |
| news table resize: frame time p95 | 25.05 ms | 25.05 ms |
| news table resize: missed frames (est., 60 Hz) | 3 | 7.5 |
| news table resize: intervals over 1.5 frames | 3 | 5 |
| news table resize: frame behind the pointer | 8.95 px | 8.3 px |
| news table resize: content behind the pointer | 8.95 px | 8.3 px |
| news table resize: frame jump on release | 0 px | 0 px |
| news table resize: content jump on release | 0 px | 0 px |
| chart resize: main thread per frame | 4.59 ms | 4.83 ms |
| chart resize: script per frame | 1.62 ms | 1.66 ms |
| chart resize: style and layout per frame | 0.49 ms | 0.5 ms |
| chart resize: React commits | 23 | 24 |
| chart resize: frames per second | 57.53 | 57.85 |
| chart resize: frame time p95 | 16.8 ms | 16.8 ms |
| chart resize: missed frames (est., 60 Hz) | 3 | 3 |
| chart resize: intervals over 1.5 frames | 3 | 2 |
| chart resize: frame behind the pointer | 15.37 px | 0.02 px |
| chart resize: content behind the pointer | 15.37 px | 0.02 px |
| chart resize: frame jump on release | 0 px | 0 px |
| chart resize: content jump on release | 0 px | 0 px |
| chart resize: chart bitmap scaled by CSS (p95) | 28.26% | 26.39% |
| chart resize: chart bitmap scaled at rest | 0% | 0% |
| heat map resize: main thread per frame | 4.36 ms | 4.51 ms |
| heat map resize: script per frame | 0.65 ms | 0.71 ms |
| heat map resize: style and layout per frame | 0.79 ms | 0.81 ms |
| heat map resize: React commits | 12 | 13 |
| heat map resize: frames per second | 59.04 | 57.74 |
| heat map resize: frame time p95 | 16.8 ms | 16.8 ms |
| heat map resize: missed frames (est., 60 Hz) | 1 | 2.5 |
| heat map resize: intervals over 1.5 frames | 1 | 2 |
| heat map resize: frame behind the pointer | 2.72 px | 0.02 px |
| heat map resize: content behind the pointer | 2.72 px | 0.02 px |
| heat map resize: frame jump on release | 0 px | 0 px |
| heat map resize: content jump on release | 0 px | 0 px |
| market heat map resize: main thread per frame | 9.15 ms | 7.99 ms |
| market heat map resize: script per frame | 1.16 ms | 1.12 ms |
| market heat map resize: style and layout per frame | 1.99 ms | 1.8 ms |
| market heat map resize: React commits | 17.5 | 16.5 |
| market heat map resize: frames per second | 57.39 | 51.58 |
| market heat map resize: frame time p95 | 16.8 ms | 33.4 ms |
| market heat map resize: missed frames (est., 60 Hz) | 4 | 12 |
| market heat map resize: intervals over 1.5 frames | 4 | 8.5 |
| market heat map resize: frame behind the pointer | 33.32 px | 30.26 px |
| market heat map resize: content behind the pointer | 33.32 px | 30.26 px |
| market heat map resize: frame jump on release | 0 px | 0 px |
| market heat map resize: content jump on release | 0 px | 0 px |
| fear and greed resize: main thread per frame | 10.34 ms | 9.89 ms |
| fear and greed resize: script per frame | 4.52 ms | 4.48 ms |
| fear and greed resize: style and layout per frame | 0.99 ms | 0.98 ms |
| fear and greed resize: React commits | 18 | 20 |
| fear and greed resize: frames per second | 55.1 | 51.26 |
| fear and greed resize: frame time p95 | 33.35 ms | 33.4 ms |
| fear and greed resize: missed frames (est., 60 Hz) | 10 | 12.5 |
| fear and greed resize: intervals over 1.5 frames | 9 | 9.5 |
| fear and greed resize: frame behind the pointer | 41.65 px | 53.13 px |
| fear and greed resize: content behind the pointer | 44.29 px | 55.35 px |
| fear and greed resize: frame jump on release | 0 px | 0 px |
| fear and greed resize: content jump on release | 0 px | 0 px |
| fear and greed resize: chart bitmap scaled by CSS (p95) | 44.3% | 41.88% |
| fear and greed resize: chart bitmap scaled at rest | 0% | 0% |
| dock divider drag: main thread per frame | 7.15 ms | 6.67 ms |
| dock divider drag: script per frame | 2.09 ms | 2.04 ms |
| dock divider drag: style and layout per frame | 1.14 ms | 1.06 ms |
| dock divider drag: React commits | 23.5 | 22 |
| dock divider drag: frames per second | 55.63 | 54.46 |
| dock divider drag: frame time p95 | 25.05 ms | 33.3 ms |
| dock divider drag: missed frames (est., 60 Hz) | 6 | 8 |
| dock divider drag: intervals over 1.5 frames | 4 | 6 |
| dock divider drag: frame behind the pointer | 12.93 px | 27.75 px |
| dock divider drag: content behind the pointer | 12.93 px | 27.75 px |
| dock divider drag: frame jump on release | 0 px | 0 px |
| dock divider drag: content jump on release | 0 px | 0 px |
| dock divider beside a chart: main thread per frame | 7.06 ms | 6.56 ms |
| dock divider beside a chart: script per frame | 2.13 ms | 1.98 ms |
| dock divider beside a chart: style and layout per frame | 1.09 ms | 1.04 ms |
| dock divider beside a chart: React commits | 23 | 23.5 |
| dock divider beside a chart: frames per second | 55.11 | 55.81 |
| dock divider beside a chart: frame time p95 | 33.25 ms | 25 ms |
| dock divider beside a chart: missed frames (est., 60 Hz) | 6 | 5.5 |
| dock divider beside a chart: intervals over 1.5 frames | 6 | 4 |
| dock divider beside a chart: frame behind the pointer | 24.42 px | 18.75 px |
| dock divider beside a chart: content behind the pointer | 0 px | 0 px |
| dock divider beside a chart: frame jump on release | 0 px | 0 px |
| dock divider beside a chart: content jump on release | 0 px | 0 px |
| dock divider beside a chart: chart bitmap scaled by CSS (p95) | 35.95% | 31.7% |
| dock divider beside a chart: chart bitmap scaled at rest | 0% | 0% |
| G layout resize: main thread per frame | 4.54 ms | 4.59 ms |
| G layout resize: script per frame | 1.53 ms | 1.54 ms |
| G layout resize: style and layout per frame | 0.52 ms | 0.51 ms |
| G layout resize: React commits | 25 | 24 |
| G layout resize: frames per second | 57.95 | 57.5 |
| G layout resize: frame time p95 | 16.8 ms | 16.8 ms |
| G layout resize: missed frames (est., 60 Hz) | 2 | 3.5 |
| G layout resize: intervals over 1.5 frames | 2 | 3 |
| G layout resize: frame behind the pointer | 9.53 px | 12.65 px |
| G layout resize: content behind the pointer | 9.53 px | 12.65 px |
| G layout resize: frame jump on release | 0 px | 0 px |
| G layout resize: content jump on release | 0 px | 0 px |
| G layout resize: chart bitmap scaled by CSS (p95) | 28.17% | 28.77% |
| G layout resize: chart bitmap scaled at rest | 0% | 0% |
| chart over a table resize: main thread per frame | 4.79 ms | 4.45 ms |
| chart over a table resize: script per frame | 1.56 ms | 1.54 ms |
| chart over a table resize: style and layout per frame | 0.59 ms | 0.56 ms |
| chart over a table resize: React commits | 35 | 35 |
| chart over a table resize: frames per second | 52.69 | 55.9 |
| chart over a table resize: frame time p95 | 25.1 ms | 25.05 ms |
| chart over a table resize: missed frames (est., 60 Hz) | 10.5 | 5.5 |
| chart over a table resize: intervals over 1.5 frames | 5 | 3.5 |
| chart over a table resize: frame behind the pointer | 16.89 px | 16.3 px |
| chart over a table resize: content behind the pointer | 16.48 px | 14.79 px |
| chart over a table resize: frame jump on release | 0 px | 0 px |
| chart over a table resize: content jump on release | 0 px | 0 px |
| chart over a table resize: chart bitmap scaled by CSS (p95) | 27.72% | 32.82% |
| chart over a table resize: chart bitmap scaled at rest | 0% | 0% |
| chart beside a table resize: main thread per frame | 4.7 ms | 4.68 ms |
| chart beside a table resize: script per frame | 1.71 ms | 1.62 ms |
| chart beside a table resize: style and layout per frame | 0.5 ms | 0.49 ms |
| chart beside a table resize: React commits | 33 | 34.5 |
| chart beside a table resize: frames per second | 53.69 | 57.88 |
| chart beside a table resize: frame time p95 | 33.3 ms | 16.8 ms |
| chart beside a table resize: missed frames (est., 60 Hz) | 9 | 2.5 |
| chart beside a table resize: intervals over 1.5 frames | 6 | 2.5 |
| chart beside a table resize: frame behind the pointer | 10.88 px | 9.62 px |
| chart beside a table resize: content behind the pointer | 10.88 px | 9.62 px |
| chart beside a table resize: frame jump on release | 0 px | 0 px |
| chart beside a table resize: content jump on release | 0 px | 0 px |
| chart beside a table resize: chart bitmap scaled by CSS (p95) | 68.85% | 50.35% |
| chart beside a table resize: chart bitmap scaled at rest | 0% | 0% |
| chart under a toolbar resize: main thread per frame | 4.46 ms | 4.32 ms |
| chart under a toolbar resize: script per frame | 1.58 ms | 1.52 ms |
| chart under a toolbar resize: style and layout per frame | 0.54 ms | 0.52 ms |
| chart under a toolbar resize: React commits | 24 | 23 |
| chart under a toolbar resize: frames per second | 58.48 | 57.55 |
| chart under a toolbar resize: frame time p95 | 16.8 ms | 16.8 ms |
| chart under a toolbar resize: missed frames (est., 60 Hz) | 2 | 3 |
| chart under a toolbar resize: intervals over 1.5 frames | 2 | 2 |
| chart under a toolbar resize: frame behind the pointer | 4.9 px | 14.54 px |
| chart under a toolbar resize: content behind the pointer | 4.9 px | 14.54 px |
| chart under a toolbar resize: frame jump on release | 0 px | 0 px |
| chart under a toolbar resize: content jump on release | 0 px | 0 px |
| chart under a toolbar resize: chart bitmap scaled by CSS (p95) | 27.65% | 29.44% |
| chart under a toolbar resize: chart bitmap scaled at rest | 0% | 0% |
| chart under a table resize: main thread per frame | 4.37 ms | 4.38 ms |
| chart under a table resize: script per frame | 1.32 ms | 1.3 ms |
| chart under a table resize: style and layout per frame | 0.56 ms | 0.56 ms |
| chart under a table resize: React commits | 29 | 30.5 |
| chart under a table resize: frames per second | 56.35 | 56.6 |
| chart under a table resize: frame time p95 | 16.8 ms | 25.05 ms |
| chart under a table resize: missed frames (est., 60 Hz) | 7 | 4 |
| chart under a table resize: intervals over 1.5 frames | 3.5 | 3.5 |
| chart under a table resize: frame behind the pointer | 4.86 px | 13.17 px |
| chart under a table resize: content behind the pointer | 4.86 px | 13.17 px |
| chart under a table resize: frame jump on release | 0 px | 0 px |
| chart under a table resize: content jump on release | 0 px | 0 px |
| chart under a table resize: chart bitmap scaled by CSS (p95) | 20.72% | 20.09% |
| chart under a table resize: chart bitmap scaled at rest | 0% | 0% |
| dock divider beside a G layout: main thread per frame | 7.92 ms | 7.63 ms |
| dock divider beside a G layout: script per frame | 2.49 ms | 2.5 ms |
| dock divider beside a G layout: style and layout per frame | 0.44 ms | 0.43 ms |
| dock divider beside a G layout: React commits | 22 | 22 |
| dock divider beside a G layout: frames per second | 51.96 | 55.71 |
| dock divider beside a G layout: frame time p95 | 33.35 ms | 25 ms |
| dock divider beside a G layout: missed frames (est., 60 Hz) | 11.5 | 5.5 |
| dock divider beside a G layout: intervals over 1.5 frames | 8.5 | 4.5 |
| dock divider beside a G layout: frame behind the pointer | 41.63 px | 32.42 px |
| dock divider beside a G layout: content behind the pointer | 41.63 px | 32.42 px |
| dock divider beside a G layout: frame jump on release | 0 px | 0 px |
| dock divider beside a G layout: content jump on release | 0 px | 0 px |
| dock divider beside a G layout: chart bitmap scaled by CSS (p95) | 35.41% | 31.9% |
| dock divider beside a G layout: chart bitmap scaled at rest | 0% | 0% |
| dock divider beside a chart beside a table: main thread per frame | 7.49 ms | 7.34 ms |
| dock divider beside a chart beside a table: script per frame | 2.5 ms | 2.43 ms |
| dock divider beside a chart beside a table: style and layout per frame | 0.42 ms | 0.44 ms |
| dock divider beside a chart beside a table: React commits | 21.5 | 21.5 |
| dock divider beside a chart beside a table: frames per second | 51.81 | 53.12 |
| dock divider beside a chart beside a table: frame time p95 | 33.4 ms | 33.35 ms |
| dock divider beside a chart beside a table: missed frames (est., 60 Hz) | 12.5 | 11 |
| dock divider beside a chart beside a table: intervals over 1.5 frames | 8 | 7 |
| dock divider beside a chart beside a table: frame behind the pointer | 24.59 px | 31.06 px |
| dock divider beside a chart beside a table: content behind the pointer | 0 px | 0 px |
| dock divider beside a chart beside a table: frame jump on release | 0 px | 0 px |
| dock divider beside a chart beside a table: content jump on release | 0 px | 0 px |
| dock divider beside a chart beside a table: chart bitmap scaled by CSS (p95) | 65.33% | 58.42% |
| dock divider beside a chart beside a table: chart bitmap scaled at rest | 0% | 0% |
| chart composer pan: main thread per frame | 17.95 ms | 17.19 ms |
| chart composer pan: script per frame | 15.08 ms | 14.73 ms |
| chart composer pan: style and layout per frame | 0.75 ms | 0.71 ms |
| chart composer pan: React commits | 41.5 | 40.5 |
| chart composer pan: frames per second | 34.55 | 33.91 |
| chart composer pan: frame time p95 | 83.35 ms | 99.95 ms |
| chart composer pan: missed frames (est., 60 Hz) | 41.5 | 40 |
| chart composer pan: intervals over 1.5 frames | 13 | 13 |
| chat divider drag: main thread per frame | 3.16 ms | 3.17 ms |
| chat divider drag: script per frame | 1.04 ms | 1.06 ms |
| chat divider drag: style and layout per frame | 0.76 ms | 0.78 ms |
| chat divider drag: React commits | 19.5 | 19 |
| chat divider drag: frames per second | 57.21 | 57.31 |
| chat divider drag: frame time p95 | 16.8 ms | 16.8 ms |
| chat divider drag: missed frames (est., 60 Hz) | 4 | 3.5 |
| chat divider drag: intervals over 1.5 frames | 3 | 3 |
| chat divider drag: frame behind the pointer | 9.73 px | 4.68 px |
| chat divider drag: content behind the pointer | 9.73 px | 4.68 px |
| chat divider drag: frame jump on release | 0 px | 0 px |
| chat divider drag: content jump on release | 0 px | 0 px |
| chat divider drag, 500 messages: main thread per frame | 3.33 ms | 3.17 ms |
| chat divider drag, 500 messages: script per frame | 1.05 ms | 0.97 ms |
| chat divider drag, 500 messages: style and layout per frame | 0.85 ms | 0.82 ms |
| chat divider drag, 500 messages: React commits | 20.5 | 19.5 |
| chat divider drag, 500 messages: frames per second | 57.88 | 56.97 |
| chat divider drag, 500 messages: frame time p95 | 16.8 ms | 16.8 ms |
| chat divider drag, 500 messages: missed frames (est., 60 Hz) | 2.5 | 3 |
| chat divider drag, 500 messages: intervals over 1.5 frames | 2 | 3 |
| chat divider drag, 500 messages: frame behind the pointer | 9.93 px | 1.75 px |
| chat divider drag, 500 messages: content behind the pointer | 9.93 px | 1.75 px |
| chat divider drag, 500 messages: frame jump on release | 0 px | 0 px |
| chat divider drag, 500 messages: content jump on release | 0 px | 0 px |
| DES divider drag: main thread per frame | 4.99 ms | 4.75 ms |
| DES divider drag: script per frame | 2.33 ms | 2.32 ms |
| DES divider drag: style and layout per frame | 0.75 ms | 0.73 ms |
| DES divider drag: React commits | 21.5 | 23.5 |
| DES divider drag: frames per second | 53.79 | 54.97 |
| DES divider drag: frame time p95 | 33.35 ms | 33.3 ms |
| DES divider drag: missed frames (est., 60 Hz) | 10.5 | 7.5 |
| DES divider drag: intervals over 1.5 frames | 8.5 | 5.5 |
| DES divider drag: frame behind the pointer | 24.75 px | 14.21 px |
| DES divider drag: content behind the pointer | 24.75 px | 14.21 px |
| DES divider drag: frame jump on release | 0 px | 0 px |
| DES divider drag: content jump on release | 0 px | 0 px |
| DES divider drag, 3x: main thread per frame | 5.34 ms | 5.45 ms |
| DES divider drag, 3x: script per frame | 2.37 ms | 2.39 ms |
| DES divider drag, 3x: style and layout per frame | 0.85 ms | 0.87 ms |
| DES divider drag, 3x: React commits | 22.5 | 25 |
| DES divider drag, 3x: frames per second | 54.38 | 57.74 |
| DES divider drag, 3x: frame time p95 | 33.3 ms | 16.8 ms |
| DES divider drag, 3x: missed frames (est., 60 Hz) | 10.5 | 3 |
| DES divider drag, 3x: intervals over 1.5 frames | 7.5 | 3 |
| DES divider drag, 3x: frame behind the pointer | 15.82 px | 23.8 px |
| DES divider drag, 3x: content behind the pointer | 15.82 px | 23.8 px |
| DES divider drag, 3x: frame jump on release | 0 px | 0 px |
| DES divider drag, 3x: content jump on release | 0 px | 0 px |
| DES divider drag, range bars: main thread per frame | 5.49 ms | 5.63 ms |
| DES divider drag, range bars: script per frame | 2.67 ms | 2.72 ms |
| DES divider drag, range bars: style and layout per frame | 0.83 ms | 0.87 ms |
| DES divider drag, range bars: React commits | 21 | 23 |
| DES divider drag, range bars: frames per second | 54.79 | 57.15 |
| DES divider drag, range bars: frame time p95 | 33.35 ms | 16.8 ms |
| DES divider drag, range bars: missed frames (est., 60 Hz) | 7.5 | 4 |
| DES divider drag, range bars: intervals over 1.5 frames | 5 | 3.5 |
| DES divider drag, range bars: frame behind the pointer | 28.39 px | 11.06 px |
| DES divider drag, range bars: content behind the pointer | 28.39 px | 11.06 px |
| DES divider drag, range bars: frame jump on release | 0 px | 0 px |
| DES divider drag, range bars: content jump on release | 0 px | 0 px |
| DES divider drag, footer hint: main thread per frame | 5.59 ms | 5.74 ms |
| DES divider drag, footer hint: script per frame | 2.54 ms | 2.64 ms |
| DES divider drag, footer hint: style and layout per frame | 0.85 ms | 0.89 ms |
| DES divider drag, footer hint: React commits | 22.5 | 25 |
| DES divider drag, footer hint: frames per second | 55.71 | 58.16 |
| DES divider drag, footer hint: frame time p95 | 25 ms | 16.8 ms |
| DES divider drag, footer hint: missed frames (est., 60 Hz) | 5.5 | 1.5 |
| DES divider drag, footer hint: intervals over 1.5 frames | 4 | 1 |
| DES divider drag, footer hint: frame behind the pointer | 25.29 px | 7.53 px |
| DES divider drag, footer hint: content behind the pointer | 25.29 px | 7.53 px |
| DES divider drag, footer hint: frame jump on release | 0 px | 0 px |
| DES divider drag, footer hint: content jump on release | 0 px | 0 px |
| table column drag: main thread per frame | 3.92 ms | 4.2 ms |
| table column drag: script per frame | 0.67 ms | 0.67 ms |
| table column drag: style and layout per frame | 0.19 ms | 0.19 ms |
| table column drag: React commits | 13 | 13.5 |
| table column drag: frames per second | 57.47 | 58.35 |
| table column drag: frame time p95 | 16.8 ms | 16.75 ms |
| table column drag: missed frames (est., 60 Hz) | 3 | 2.5 |
| table column drag: intervals over 1.5 frames | 2.5 | 2.5 |
| table column drag: frame behind the pointer | 5.04 px | 3.14 px |
| table column drag: content behind the pointer | 5.04 px | 3.14 px |
| table column drag: frame jump on release | 0 px | 0 px |
| table column drag: content jump on release | 0 px | 0 px |

- market heat map resize: main does not follow the pointer (33.3 px behind), so its main thread time and commits set no budget.
- fear and greed resize: main does not follow the pointer (41.6 px behind), so its main thread time and commits set no budget.
- dock divider beside a chart: main does not follow the pointer (24.4 px behind), so its main thread time and commits set no budget.
- dock divider beside a G layout: main does not follow the pointer (41.6 px behind), so its main thread time and commits set no budget.
- dock divider beside a chart beside a table: main does not follow the pointer (24.6 px behind), so its main thread time and commits set no budget.
- DES divider drag: main does not follow the pointer (24.7 px behind), so its main thread time and commits set no budget.
- DES divider drag, range bars: main does not follow the pointer (28.4 px behind), so its main thread time and commits set no budget.
- DES divider drag, footer hint: main does not follow the pointer (25.3 px behind), so its main thread time and commits set no budget.

**Over budget:**

- market heat map resize: the frame fell 30.3 px behind the pointer (limit: 24 px).
- market heat map resize: the content fell 30.3 px behind the pointer (limit: 24 px).
- fear and greed resize: the frame fell 53.1 px behind the pointer (limit: 24 px).
- fear and greed resize: the content fell 55.4 px behind the pointer (limit: 24 px).
- dock divider drag: the frame fell 27.8 px behind the pointer (limit: 24 px).
- dock divider drag: the content fell 27.8 px behind the pointer (limit: 24 px).
- dock divider beside a G layout: the frame fell 32.4 px behind the pointer (limit: 24 px).
- dock divider beside a G layout: the content fell 32.4 px behind the pointer (limit: 24 px).
- dock divider beside a chart beside a table: the frame fell 31.1 px behind the pointer (limit: 24 px).

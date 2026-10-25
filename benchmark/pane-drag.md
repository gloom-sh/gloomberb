### Pane drag and resize frame budget

Middle value of 10 alternating runs per side, 1.5 s drags at 60 moves a second, headless Chrome without a GPU. Frames are animation frames, not GPU-presented frames; missed frames are estimated against a 60 Hz display. Behind the pointer: how far the dragged edge of the frame, and of the content in it, was from where the pointer had it, in px (95th percentile). Jump on release: how far the frame's and the content's edge moved when the pointer let go where it rested.

| | main | this PR |
|---|---|---|
| docked pane drag: main thread per frame | 1.22 ms | 1.22 ms |
| docked pane drag: script per frame | 0.39 ms | 0.4 ms |
| docked pane drag: style and layout per frame | 0.12 ms | 0.13 ms |
| docked pane drag: React commits | 9 | 9 |
| docked pane drag: frames per second | 58.59 | 59.11 |
| docked pane drag: frame time p95 | 16.8 ms | 16.75 ms |
| docked pane drag: missed frames (est., 60 Hz) | 2 | 1 |
| docked pane drag: intervals over 1.5 frames | 2 | 1 |
| floating pane drag: main thread per frame | 1.07 ms | 1.1 ms |
| floating pane drag: script per frame | 0.33 ms | 0.34 ms |
| floating pane drag: style and layout per frame | 0.12 ms | 0.12 ms |
| floating pane drag: React commits | 5 | 5 |
| floating pane drag: frames per second | 57.92 | 57.38 |
| floating pane drag: frame time p95 | 16.8 ms | 16.8 ms |
| floating pane drag: missed frames (est., 60 Hz) | 3 | 4 |
| floating pane drag: intervals over 1.5 frames | 2.5 | 2.5 |
| news table resize: main thread per frame | 5.73 ms | 5.84 ms |
| news table resize: script per frame | 1.19 ms | 1.22 ms |
| news table resize: style and layout per frame | 1.23 ms | 1.28 ms |
| news table resize: React commits | 36 | 34 |
| news table resize: frames per second | 57.26 | 54.79 |
| news table resize: frame time p95 | 16.8 ms | 16.8 ms |
| news table resize: missed frames (est., 60 Hz) | 3.5 | 4.5 |
| news table resize: intervals over 1.5 frames | 3.5 | 2.5 |
| news table resize: frame behind the pointer | 7.98 px | 24.85 px |
| news table resize: content behind the pointer | 7.98 px | 24.85 px |
| news table resize: frame jump on release | 0 px | 0 px |
| news table resize: content jump on release | 0 px | 0 px |
| chart resize: main thread per frame | 5.29 ms | 5.06 ms |
| chart resize: script per frame | 1.87 ms | 1.81 ms |
| chart resize: style and layout per frame | 0.56 ms | 0.55 ms |
| chart resize: React commits | 24 | 24 |
| chart resize: frames per second | 56.2 | 57.45 |
| chart resize: frame time p95 | 25 ms | 25 ms |
| chart resize: missed frames (est., 60 Hz) | 4.5 | 3.5 |
| chart resize: intervals over 1.5 frames | 4 | 3.5 |
| chart resize: frame behind the pointer | 10.68 px | 13.51 px |
| chart resize: content behind the pointer | 10.68 px | 13.51 px |
| chart resize: frame jump on release | 0 px | 0 px |
| chart resize: content jump on release | 0 px | 0 px |
| chart resize: chart bitmap scaled by CSS (p95) | 27.53% | 32.68% |
| chart resize: chart bitmap scaled at rest | 0% | 0% |
| heat map resize: main thread per frame | 4.97 ms | 4.81 ms |
| heat map resize: script per frame | 0.79 ms | 0.76 ms |
| heat map resize: style and layout per frame | 0.9 ms | 0.86 ms |
| heat map resize: React commits | 12.5 | 12 |
| heat map resize: frames per second | 56.04 | 55.65 |
| heat map resize: frame time p95 | 25.05 ms | 16.8 ms |
| heat map resize: missed frames (est., 60 Hz) | 5.5 | 6 |
| heat map resize: intervals over 1.5 frames | 4.5 | 3.5 |
| heat map resize: frame behind the pointer | 15.17 px | 14.16 px |
| heat map resize: content behind the pointer | 15.17 px | 14.16 px |
| heat map resize: frame jump on release | 0 px | 0 px |
| heat map resize: content jump on release | 0 px | 0 px |
| market heat map resize: main thread per frame | 9.28 ms | 9.62 ms |
| market heat map resize: script per frame | 1.24 ms | 1.23 ms |
| market heat map resize: style and layout per frame | 2.04 ms | 2.23 ms |
| market heat map resize: React commits | 17.5 | 16 |
| market heat map resize: frames per second | 54.17 | 52.63 |
| market heat map resize: frame time p95 | 33.3 ms | 33.35 ms |
| market heat map resize: missed frames (est., 60 Hz) | 9 | 12.5 |
| market heat map resize: intervals over 1.5 frames | 7.5 | 5.5 |
| market heat map resize: frame behind the pointer | 23.39 px | 39.65 px |
| market heat map resize: content behind the pointer | 23.39 px | 39.65 px |
| market heat map resize: frame jump on release | 0 px | 0 px |
| market heat map resize: content jump on release | 0 px | 0 px |
| fear and greed resize: main thread per frame | 11.15 ms | 11.06 ms |
| fear and greed resize: script per frame | 4.88 ms | 4.93 ms |
| fear and greed resize: style and layout per frame | 1.11 ms | 1.12 ms |
| fear and greed resize: React commits | 17.5 | 13 |
| fear and greed resize: frames per second | 52.11 | 46.63 |
| fear and greed resize: frame time p95 | 33.35 ms | 41.65 ms |
| fear and greed resize: missed frames (est., 60 Hz) | 11 | 20 |
| fear and greed resize: intervals over 1.5 frames | 9 | 13.5 |
| fear and greed resize: frame behind the pointer | 51.57 px | 98.03 px |
| fear and greed resize: content behind the pointer | 51.25 px | 100.09 px |
| fear and greed resize: frame jump on release | 0 px | 0 px |
| fear and greed resize: content jump on release | 0 px | 0 px |
| fear and greed resize: chart bitmap scaled by CSS (p95) | 44.09% | 54.51% |
| fear and greed resize: chart bitmap scaled at rest | 0% | 0% |
| dock divider drag: main thread per frame | 7.58 ms | 7.76 ms |
| dock divider drag: script per frame | 2.24 ms | 2.33 ms |
| dock divider drag: style and layout per frame | 1.27 ms | 1.25 ms |
| dock divider drag: React commits | 23 | 24 |
| dock divider drag: frames per second | 55.04 | 55.01 |
| dock divider drag: frame time p95 | 25.05 ms | 33.3 ms |
| dock divider drag: missed frames (est., 60 Hz) | 6.5 | 7.5 |
| dock divider drag: intervals over 1.5 frames | 5 | 5 |
| dock divider drag: frame behind the pointer | 17.95 px | 23.54 px |
| dock divider drag: content behind the pointer | 17.95 px | 23.54 px |
| dock divider drag: frame jump on release | 0 px | 0 px |
| dock divider drag: content jump on release | 0 px | 0 px |
| dock divider beside a chart: main thread per frame | 7.56 ms | 7.96 ms |
| dock divider beside a chart: script per frame | 2.14 ms | 2.28 ms |
| dock divider beside a chart: style and layout per frame | 1.25 ms | 1.3 ms |
| dock divider beside a chart: React commits | 23 | 20.5 |
| dock divider beside a chart: frames per second | 57.34 | 50.89 |
| dock divider beside a chart: frame time p95 | 25.05 ms | 41.65 ms |
| dock divider beside a chart: missed frames (est., 60 Hz) | 4.5 | 14.5 |
| dock divider beside a chart: intervals over 1.5 frames | 3.5 | 9.5 |
| dock divider beside a chart: frame behind the pointer | 22.91 px | 32.84 px |
| dock divider beside a chart: content behind the pointer | 0 px | 0 px |
| dock divider beside a chart: frame jump on release | 0 px | 0 px |
| dock divider beside a chart: content jump on release | 0 px | 0 px |
| dock divider beside a chart: chart bitmap scaled by CSS (p95) | 31.18% | 36.47% |
| dock divider beside a chart: chart bitmap scaled at rest | 0% | 0% |
| G layout resize: main thread per frame | 5.13 ms | 5.07 ms |
| G layout resize: script per frame | 1.78 ms | 1.78 ms |
| G layout resize: style and layout per frame | 0.58 ms | 0.56 ms |
| G layout resize: React commits | 23.5 | 21.5 |
| G layout resize: frames per second | 54.9 | 50.74 |
| G layout resize: frame time p95 | 33.3 ms | 41.65 ms |
| G layout resize: missed frames (est., 60 Hz) | 7.5 | 14.5 |
| G layout resize: intervals over 1.5 frames | 5 | 7.5 |
| G layout resize: frame behind the pointer | 22.04 px | 26.81 px |
| G layout resize: content behind the pointer | 22.04 px | 26.81 px |
| G layout resize: frame jump on release | 0 px | 0 px |
| G layout resize: content jump on release | 0 px | 0 px |
| G layout resize: chart bitmap scaled by CSS (p95) | 32.41% | 33.82% |
| G layout resize: chart bitmap scaled at rest | 0% | 0% |
| chart over a table resize: main thread per frame | 5.09 ms | 5.28 ms |
| chart over a table resize: script per frame | 1.66 ms | 1.74 ms |
| chart over a table resize: style and layout per frame | 0.63 ms | 0.65 ms |
| chart over a table resize: React commits | 37 | 33 |
| chart over a table resize: frames per second | 57.24 | 49.87 |
| chart over a table resize: frame time p95 | 16.8 ms | 33.35 ms |
| chart over a table resize: missed frames (est., 60 Hz) | 3.5 | 14.5 |
| chart over a table resize: intervals over 1.5 frames | 2 | 9.5 |
| chart over a table resize: frame behind the pointer | 4.9 px | 28.42 px |
| chart over a table resize: content behind the pointer | 7.93 px | 28.99 px |
| chart over a table resize: frame jump on release | 0 px | 0 px |
| chart over a table resize: content jump on release | 0 px | 0 px |
| chart over a table resize: chart bitmap scaled by CSS (p95) | 27.66% | 36.05% |
| chart over a table resize: chart bitmap scaled at rest | 0% | 0% |
| chart beside a table resize: main thread per frame | 5.22 ms | 5.36 ms |
| chart beside a table resize: script per frame | 1.88 ms | 1.9 ms |
| chart beside a table resize: style and layout per frame | 0.55 ms | 0.57 ms |
| chart beside a table resize: React commits | 32 | 33 |
| chart beside a table resize: frames per second | 56.54 | 57.12 |
| chart beside a table resize: frame time p95 | 25.05 ms | 25.1 ms |
| chart beside a table resize: missed frames (est., 60 Hz) | 5.5 | 5 |
| chart beside a table resize: intervals over 1.5 frames | 5 | 5 |
| chart beside a table resize: frame behind the pointer | 22.07 px | 11.4 px |
| chart beside a table resize: content behind the pointer | 22.07 px | 11.4 px |
| chart beside a table resize: frame jump on release | 0 px | 0 px |
| chart beside a table resize: content jump on release | 0 px | 0 px |
| chart beside a table resize: chart bitmap scaled by CSS (p95) | 56.77% | 60.85% |
| chart beside a table resize: chart bitmap scaled at rest | 0% | 0% |
| chart under a toolbar resize: main thread per frame | 5.11 ms | 5.06 ms |
| chart under a toolbar resize: script per frame | 1.75 ms | 1.77 ms |
| chart under a toolbar resize: style and layout per frame | 0.62 ms | 0.6 ms |
| chart under a toolbar resize: React commits | 22.5 | 22 |
| chart under a toolbar resize: frames per second | 55.84 | 51.75 |
| chart under a toolbar resize: frame time p95 | 16.8 ms | 33.4 ms |
| chart under a toolbar resize: missed frames (est., 60 Hz) | 5 | 12 |
| chart under a toolbar resize: intervals over 1.5 frames | 3 | 7.5 |
| chart under a toolbar resize: frame behind the pointer | 6.01 px | 18.06 px |
| chart under a toolbar resize: content behind the pointer | 6.01 px | 18.06 px |
| chart under a toolbar resize: frame jump on release | 0 px | 0 px |
| chart under a toolbar resize: content jump on release | 0 px | 0 px |
| chart under a toolbar resize: chart bitmap scaled by CSS (p95) | 27.75% | 35.37% |
| chart under a toolbar resize: chart bitmap scaled at rest | 0% | 0% |
| chart under a table resize: main thread per frame | 5.01 ms | 5.04 ms |
| chart under a table resize: script per frame | 1.49 ms | 1.51 ms |
| chart under a table resize: style and layout per frame | 0.67 ms | 0.67 ms |
| chart under a table resize: React commits | 31 | 31.5 |
| chart under a table resize: frames per second | 55.09 | 56.47 |
| chart under a table resize: frame time p95 | 25.05 ms | 16.8 ms |
| chart under a table resize: missed frames (est., 60 Hz) | 7 | 5 |
| chart under a table resize: intervals over 1.5 frames | 4 | 3.5 |
| chart under a table resize: frame behind the pointer | 12.14 px | 16.95 px |
| chart under a table resize: content behind the pointer | 12.14 px | 16.95 px |
| chart under a table resize: frame jump on release | 0 px | 0 px |
| chart under a table resize: content jump on release | 0 px | 0 px |
| chart under a table resize: chart bitmap scaled by CSS (p95) | 20.9% | 21.54% |
| chart under a table resize: chart bitmap scaled at rest | 0% | 0% |
| dock divider beside a G layout: main thread per frame | 8.86 ms | 8.63 ms |
| dock divider beside a G layout: script per frame | 2.83 ms | 2.72 ms |
| dock divider beside a G layout: style and layout per frame | 0.52 ms | 0.52 ms |
| dock divider beside a G layout: React commits | 20.5 | 21.5 |
| dock divider beside a G layout: frames per second | 50.4 | 54.92 |
| dock divider beside a G layout: frame time p95 | 33.3 ms | 25.05 ms |
| dock divider beside a G layout: missed frames (est., 60 Hz) | 14 | 7 |
| dock divider beside a G layout: intervals over 1.5 frames | 7 | 6 |
| dock divider beside a G layout: frame behind the pointer | 35.29 px | 39.33 px |
| dock divider beside a G layout: content behind the pointer | 35.29 px | 39.33 px |
| dock divider beside a G layout: frame jump on release | 0 px | 0 px |
| dock divider beside a G layout: content jump on release | 0 px | 0 px |
| dock divider beside a G layout: chart bitmap scaled by CSS (p95) | 33.36% | 31.41% |
| dock divider beside a G layout: chart bitmap scaled at rest | 0% | 0% |
| dock divider beside a chart beside a table: main thread per frame | 8.64 ms | 8.87 ms |
| dock divider beside a chart beside a table: script per frame | 2.8 ms | 2.78 ms |
| dock divider beside a chart beside a table: style and layout per frame | 0.49 ms | 0.52 ms |
| dock divider beside a chart beside a table: React commits | 19.5 | 21.5 |
| dock divider beside a chart beside a table: frames per second | 45.94 | 53.4 |
| dock divider beside a chart beside a table: frame time p95 | 50 ms | 33.35 ms |
| dock divider beside a chart beside a table: missed frames (est., 60 Hz) | 21 | 10 |
| dock divider beside a chart beside a table: intervals over 1.5 frames | 11.5 | 8.5 |
| dock divider beside a chart beside a table: frame behind the pointer | 39.5 px | 38.2 px |
| dock divider beside a chart beside a table: content behind the pointer | 0 px | 0 px |
| dock divider beside a chart beside a table: frame jump on release | 0 px | 0 px |
| dock divider beside a chart beside a table: content jump on release | 0 px | 0 px |
| dock divider beside a chart beside a table: chart bitmap scaled by CSS (p95) | 81.03% | 82.37% |
| dock divider beside a chart beside a table: chart bitmap scaled at rest | 0% | 0% |
| chart composer pan: main thread per frame | 18.81 ms | 18.1 ms |
| chart composer pan: script per frame | 15.4 ms | 15.31 ms |
| chart composer pan: style and layout per frame | 0.85 ms | 0.78 ms |
| chart composer pan: React commits | 47.5 | 47 |
| chart composer pan: frames per second | 36.62 | 37.85 |
| chart composer pan: frame time p95 | 83.3 ms | 75.05 ms |
| chart composer pan: missed frames (est., 60 Hz) | 38.5 | 35 |
| chart composer pan: intervals over 1.5 frames | 13.5 | 14 |
| chat divider drag: main thread per frame | 3.77 ms | 3.79 ms |
| chat divider drag: script per frame | 1.26 ms | 1.21 ms |
| chat divider drag: style and layout per frame | 0.92 ms | 0.94 ms |
| chat divider drag: React commits | 19.5 | 19 |
| chat divider drag: frames per second | 57.14 | 57.86 |
| chat divider drag: frame time p95 | 16.8 ms | 16.8 ms |
| chat divider drag: missed frames (est., 60 Hz) | 4.5 | 2 |
| chat divider drag: intervals over 1.5 frames | 2.5 | 2 |
| chat divider drag: frame behind the pointer | 4.96 px | 14.71 px |
| chat divider drag: content behind the pointer | 4.96 px | 14.71 px |
| chat divider drag: frame jump on release | 0 px | 0 px |
| chat divider drag: content jump on release | 0 px | 0 px |
| chat divider drag, 500 messages: main thread per frame | 3.76 ms | 3.71 ms |
| chat divider drag, 500 messages: script per frame | 1.18 ms | 1.2 ms |
| chat divider drag, 500 messages: style and layout per frame | 0.92 ms | 0.94 ms |
| chat divider drag, 500 messages: React commits | 20 | 19 |
| chat divider drag, 500 messages: frames per second | 55.65 | 54.13 |
| chat divider drag, 500 messages: frame time p95 | 25.05 ms | 25.05 ms |
| chat divider drag, 500 messages: missed frames (est., 60 Hz) | 5.5 | 7.5 |
| chat divider drag, 500 messages: intervals over 1.5 frames | 5 | 5 |
| chat divider drag, 500 messages: frame behind the pointer | 0.25 px | 7.89 px |
| chat divider drag, 500 messages: content behind the pointer | 0.25 px | 7.89 px |
| chat divider drag, 500 messages: frame jump on release | 0 px | 0 px |
| chat divider drag, 500 messages: content jump on release | 0 px | 0 px |
| DES divider drag: main thread per frame | 5.69 ms | 5.63 ms |
| DES divider drag: script per frame | 2.66 ms | 2.63 ms |
| DES divider drag: style and layout per frame | 0.88 ms | 0.84 ms |
| DES divider drag: React commits | 25 | 22 |
| DES divider drag: frames per second | 56.38 | 55.99 |
| DES divider drag: frame time p95 | 25.05 ms | 33.25 ms |
| DES divider drag: missed frames (est., 60 Hz) | 5 | 5.5 |
| DES divider drag: intervals over 1.5 frames | 4 | 5 |
| DES divider drag: frame behind the pointer | 14.81 px | 20.03 px |
| DES divider drag: content behind the pointer | 14.81 px | 20.03 px |
| DES divider drag: frame jump on release | 0 px | 0 px |
| DES divider drag: content jump on release | 0 px | 0 px |
| DES divider drag, 3x: main thread per frame | 6.29 ms | 6.3 ms |
| DES divider drag, 3x: script per frame | 2.73 ms | 2.72 ms |
| DES divider drag, 3x: style and layout per frame | 0.99 ms | 1.01 ms |
| DES divider drag, 3x: React commits | 24 | 24.5 |
| DES divider drag, 3x: frames per second | 56.12 | 55.47 |
| DES divider drag, 3x: frame time p95 | 16.8 ms | 25.05 ms |
| DES divider drag, 3x: missed frames (est., 60 Hz) | 5 | 6 |
| DES divider drag, 3x: intervals over 1.5 frames | 3.5 | 3.5 |
| DES divider drag, 3x: frame behind the pointer | 17.53 px | 22.33 px |
| DES divider drag, 3x: content behind the pointer | 17.53 px | 22.33 px |
| DES divider drag, 3x: frame jump on release | 0 px | 0 px |
| DES divider drag, 3x: content jump on release | 0 px | 0 px |
| DES divider drag, range bars: main thread per frame | 6.48 ms | 6.53 ms |
| DES divider drag, range bars: script per frame | 3.12 ms | 3.1 ms |
| DES divider drag, range bars: style and layout per frame | 0.96 ms | 1.01 ms |
| DES divider drag, range bars: React commits | 21.5 | 23.5 |
| DES divider drag, range bars: frames per second | 52.51 | 57.81 |
| DES divider drag, range bars: frame time p95 | 33.3 ms | 16.8 ms |
| DES divider drag, range bars: missed frames (est., 60 Hz) | 10.5 | 2.5 |
| DES divider drag, range bars: intervals over 1.5 frames | 7 | 1 |
| DES divider drag, range bars: frame behind the pointer | 20.22 px | 15.71 px |
| DES divider drag, range bars: content behind the pointer | 20.22 px | 15.71 px |
| DES divider drag, range bars: frame jump on release | 0 px | 0 px |
| DES divider drag, range bars: content jump on release | 0 px | 0 px |
| DES divider drag, footer hint: main thread per frame | 6.49 ms | 6.59 ms |
| DES divider drag, footer hint: script per frame | 3.12 ms | 3 ms |
| DES divider drag, footer hint: style and layout per frame | 0.93 ms | 1.02 ms |
| DES divider drag, footer hint: React commits | 21 | 23.5 |
| DES divider drag, footer hint: frames per second | 48.82 | 56.91 |
| DES divider drag, footer hint: frame time p95 | 41.65 ms | 16.8 ms |
| DES divider drag, footer hint: missed frames (est., 60 Hz) | 13 | 4.5 |
| DES divider drag, footer hint: intervals over 1.5 frames | 8 | 3.5 |
| DES divider drag, footer hint: frame behind the pointer | 22.16 px | 22.43 px |
| DES divider drag, footer hint: content behind the pointer | 22.16 px | 22.43 px |
| DES divider drag, footer hint: frame jump on release | 0 px | 0 px |
| DES divider drag, footer hint: content jump on release | 0 px | 0 px |
| table column drag: main thread per frame | 4.54 ms | 4.52 ms |
| table column drag: script per frame | 0.74 ms | 0.76 ms |
| table column drag: style and layout per frame | 0.22 ms | 0.21 ms |
| table column drag: React commits | 13.5 | 13 |
| table column drag: frames per second | 58.37 | 55.92 |
| table column drag: frame time p95 | 16.8 ms | 25.05 ms |
| table column drag: missed frames (est., 60 Hz) | 2.5 | 6 |
| table column drag: intervals over 1.5 frames | 1.5 | 3.5 |
| table column drag: frame behind the pointer | 0.02 px | 9.3 px |
| table column drag: content behind the pointer | 0.02 px | 9.3 px |
| table column drag: frame jump on release | 0 px | 0 px |
| table column drag: content jump on release | 0 px | 0 px |

- fear and greed resize: main does not follow the pointer (51.6 px behind), so its main thread time and commits set no budget.
- dock divider beside a G layout: main does not follow the pointer (35.3 px behind), so its main thread time and commits set no budget.
- dock divider beside a chart beside a table: main does not follow the pointer (39.5 px behind), so its main thread time and commits set no budget.

**Over budget:**

- news table resize: the frame fell 24.8 px behind the pointer (limit: 24 px).
- news table resize: the content fell 24.8 px behind the pointer (limit: 24 px).
- market heat map resize: the frame fell 39.6 px behind the pointer (limit: 24 px).
- market heat map resize: the content fell 39.6 px behind the pointer (limit: 24 px).
- fear and greed resize: the frame fell 98 px behind the pointer (limit: 24 px).
- fear and greed resize: the content fell 100.1 px behind the pointer (limit: 24 px).
- dock divider beside a chart: the frame fell 32.8 px behind the pointer (limit: 24 px).
- G layout resize: the frame fell 26.8 px behind the pointer (limit: 24 px).
- G layout resize: the content fell 26.8 px behind the pointer (limit: 24 px).
- chart over a table resize: the frame fell 28.4 px behind the pointer (limit: 24 px).
- chart over a table resize: the content fell 29 px behind the pointer (limit: 24 px).
- dock divider beside a G layout: the frame fell 39.3 px behind the pointer (limit: 24 px).
- dock divider beside a G layout: the content fell 39.3 px behind the pointer (limit: 24 px).
- dock divider beside a chart beside a table: the frame fell 38.2 px behind the pointer (limit: 24 px).

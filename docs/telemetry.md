# Crash reports and usage counts

[Back to README](../README.md) · [User guide](usage.md)

Gloom sends crash reports and usage counts unless you turn them off. Run `Crash Reports` or `Usage Counts` from the command bar, or:

```bash
gloom config set telemetry.crashReports false
gloom config set telemetry.usage false
```

`GLOOMBERB_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` in the environment turns all of it off, Attention Counts included. The browser app also honours Do Not Track and Global Privacy Control.

Neither crash reports nor usage counts carry anything from your workspace: no tickers, arguments, portfolios, watchlists, layouts, settings or queries. Both carry a random install id, stored in `install-id` in the data folder (`~/.gloomberb` by default; in the browser, local storage).

## Crash reports

**Errors.** An uncaught error, a render crash or a plugin that fails to load is sent to Gloom's API (`api.gloom.sh`), which forwards it to error tracking. A report holds the error type, message and stack trace, the app version, the operating system, the surface (terminal, desktop or web) and, when a plugin failed, its id. Your home directory is replaced with `~`. A report is tied to your account only when you are signed in.

**Failed updates.** A failed update of the terminal binary or the desktop app is reported without the error's text: the step that failed (check, download, verify, install or restart), a fixed reason such as `offline` or `interrupted`, the installed and target versions, the release channel, the platform and architecture, and how the app was installed (for example from Applications, a disk image or a package manager). The same failure is sent at most once a day per app version. At the next launch it also reports an update that did not take, and one the app was quit without restarting into.

**Freezes.** When the app freezes, it writes a line to `stall-log.txt` in the data folder, which never leaves your machine: when, which process (the window, the desktop app's main process or the terminal app), for how long, the last measured step before it, whether the process was still starting and how long it had run, for the desktop app's main process whether the app was in front with a window on screen, and, where the system can tell, how much of the freeze the process spent computing and how busy its other threads were. A desktop window counts only while it is in front with focus, and time asleep never counts.

A freeze of a second or more is also reported, like a failed update:

- its length bucket (such as `2-5s`), the process, how many such freezes there were and the longest
- the fixed name of the last step, cut after the name, and how long before the freeze it ended (a bucket, or that it ended during it)
- the app version, platform and architecture, whether the process was still starting, and an uptime bucket (such as `2-10m`)
- for the desktop app's main process, whether the app was in front and a window was on screen
- where known, the share of the freeze spent computing and how busy the other threads were, in steps of ten percent
- when the last step was a database statement, its fixed name (such as `touch cached resource`), how many tries it took and whether it waited for another program's lock

The same kind of freeze is sent at most once a day per app version. Repeats are counted into the next report, and each report says how many freezes of a second or more the process had in the last 24 hours.

## Usage counts

**Functions.** The app counts how often you open each function (from the command bar, a menu or a link in another pane) and which functions are on screen when a workspace is restored at launch. It sends each function's mnemonic (such as `DES` or `GP`) with those two counts, the surface, the app version and the operating system: a minute after the first count, then every 15 minutes, and when you quit. Functions from plugins other than the official gloom-sh ones are sent as `plugin`, so their names never leave your machine. The server adds your plan (signed out, Free or Pro); the counts are never tied to your account.

The usage setting also covers:

- **Command bar searches.** When you are signed in, a search you finish in the command bar (you pause typing or run something, never each keystroke) is stored with your account to improve search: its text, the AI suggestions it got and the result you picked. Searches are deleted with your account.
- **Research milestones**, such as opening research, viewing a tab, saving a ticker, onboarding steps and upgrade actions. Signed-in activity is linked to your account. The browser uses an anonymous visitor id, and the desktop app can continue an id passed by the website. Events include feature, tab and onboarding desk ids, prompt interactions (in the browser, also whether the Google sign-in prompt was asked for, shown, closed or used, with the reason Google gave), campaign attribution, referrer URLs and experiment assignments, but not the ticker you saved or the contents of your research.

## Attention Counts

Attention Counts are separate and on by default. While you are signed in with a verified account, the app sends Gloom the tickers you open in DES, charts, quotes and options, and add to watchlists, for Gloom Trending.

- They are published only as hourly totals of at least 20 people per stock, rounded and delayed, never per person.
- Nothing is counted for an account until the app has shown it a one-time notice, which has a Turn off button.
- No holdings, watchlist names, queries or install id are sent.
- Run `Attention Counts` in the command bar to switch it off and discard unsent counts. While you are signed in, the off reaches your other signed-in devices when they next sync. With Gloom closed, `gloom config set telemetry.attention false` does the same on this device. Totals already published can't be withdrawn.

The [attention privacy review](attention-privacy.md) covers the collection boundary, how the off syncs, retention, aggregation and remaining risks.

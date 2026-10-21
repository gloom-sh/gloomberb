# Crash reports and usage counts

[Back to README](../README.md) · [User guide](usage.md)

When the app hits an uncaught error, a render crash, or a plugin that fails to load, it sends a crash report to Gloom's API (`api.gloom.sh`), which forwards it to error tracking. A report contains the error type, message and stack trace, the app version, the operating system, and which surface it came from (terminal, desktop or web); when a plugin failed, its id. Your home directory is replaced with `~` before sending. Reports are tied to your account only when you are signed in.

A failed app update (terminal binary or desktop app) is reported the same way, without the error's text: which step failed (check, download, verify, install or restart), a fixed reason such as `offline` or `interrupted`, the installed and the target version, the release channel, the platform and architecture, and how the app was installed (for example from Applications, a disk image, or a package manager). The same failure is sent at most once a day per app version. At the next launch it also reports an update that did not take, and one the app was quit without restarting into.

The app also counts how often you open each function, from the command bar, a menu or a link in another pane, and which functions are on screen when a workspace is restored at launch. It sends each function's mnemonic (such as `DES` or `GP`) with those two counts, the surface, the app version and the operating system, a minute after the first count, then every 15 minutes, and when you quit. Functions from plugins other than the official gloom-sh ones are sent as `plugin`, so their names never leave your machine. The server adds your plan (signed out, Free or Pro); the counts are never tied to your account.

Neither contains anything from your workspace: no tickers, arguments, portfolios, watchlists, layouts, settings or queries. Both carry a random install id stored in `install-id` in the data folder, `~/.gloomberb` by default (in the browser, in local storage).

The usage setting also covers command bar searches. When you are signed in, a search you finish in the command bar (you pause typing or run something, never each keystroke) is stored with your account to improve search: its text, the AI suggestions it got and the result you picked. Searches are deleted with your account.

The usage setting also covers research milestones, such as opening research, viewing a tab, saving a ticker, onboarding steps, upgrade actions, and on a first visit to the web app that you took a first action (not which one). Signed-in activity is linked to your account. The browser uses an anonymous visitor ID; the desktop app can continue an ID passed by the website. Events include feature, tab and onboarding desk IDs, prompt interactions, campaign attribution, referrer URLs and experiment assignments, but not the ticker you saved or the contents of your research.

To turn either off, run `Crash Reports` or `Usage Counts` from the command bar, or:

```bash
gloomberb config set telemetry.crashReports false
gloomberb config set telemetry.usage false
```

Setting `GLOOMBERB_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` in the environment turns all of it off. The browser app also honours Do Not Track and Global Privacy Control.

**Attention Counts are separate and off by default.** Run `Attention Counts` in the command bar and review the consent dialog to share ticker research counts for Gloom Trending. This sends ticker symbols and the kind of explicit research action only while signed in with a verified account. It does not send holdings, watchlist names, queries or an install id. Consent stays on this device; cloud sync cannot enable it elsewhere. Turn the setting off to discard unsent counts, or run `gloomberb config set telemetry.attention false`. The environment and browser opt-outs above also disable Attention Counts. See the [attention privacy review](attention-privacy.md) for the authenticated collection boundary, retention, aggregation and remaining risks.

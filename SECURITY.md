# Security policy

## Reporting a vulnerability

Report security issues privately through GitHub: open the repository's
[Security tab](https://github.com/gloom-sh/gloomberb/security) and choose
**Report a vulnerability**. Please do not open a public issue, pull request or
discussion for a vulnerability.

A useful report includes:

- the output of `gloomberb version`, or the version the desktop app shows, and
  where you saw the problem (terminal, desktop app, or term.gloom.sh)
- the steps to reproduce it, or a proof of concept
- what an attacker gains, and what they need first

The maintainers reply in the private advisory, work on the fix there with you,
and credit you in the published advisory unless you would rather not be named.

## Supported versions

Only the latest release gets security fixes. Before reporting, check that the
problem still happens there; the [installation guide](docs/installation.md)
covers updating.

## Scope

In scope: everything in this repository, including the terminal app, the
desktop app, the web app at term.gloom.sh and its Worker, share links, the
local remote-control endpoint, and how plugins are installed, updated and
loaded. Issues with the Gloom Cloud service behind the app can be reported here
too.

Plugins run with the same permissions as the app, by design. A plugin you
chose to install misbehaving is not a vulnerability in Gloomberb, but a way to
get plugin code installed or loaded without that choice is. A vulnerability in
a plugin that lives in its own repository belongs to that repository.

Gloomberb keeps broker connections and settings on your device, in
`~/.gloomberb` (or `GLOOMBERB_HOME`). Anything that exposes that data to another
user of the machine, a web page, or the network is in scope.

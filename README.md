# Helm Code

Helm Code is an "agent harness control surface": a server that drives coding-agent CLIs on your machine, plus web, desktop, and mobile clients to control them.

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, and OpenCode. If they're set up on your computer, Helm Code can control them.

> [!NOTE]
> This is [buluma](https://github.com/buluma)'s fork of T3 Code. It ships its own desktop builds from [GitHub Releases](https://github.com/buluma/helmcode/releases); it does not publish to the App Store, Play Store, or any hosted web app — those belong to the upstream project. Web and mobile clients here are source you build and run yourself; see [docs/internals/overview.md](./docs/internals/overview.md).

## "Wait, what are you selling me?"

Nothing. Helm Code exists because its authors wanted the best possible development experience with agents. They were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met the bar.

The goal was something performant, remote-ready, and truly open — open enough that if it ever goes the wrong direction, you have everything you need to fork it and build the editor you want. This repo is exactly that: a fork.

## Installation

> [!WARNING]
> Helm Code currently supports Codex, Claude, Cursor, Grok Build and OpenCode. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`

### Desktop app

This fork publishes raw desktop binaries (dmg/exe/AppImage) to [GitHub Releases](https://github.com/buluma/helmcode/releases). Download the latest one for your platform there.

### CLI / npm

The server-only path is published to npm as [`helmcode`](https://www.npmjs.com/package/helmcode):

```bash
npx helmcode@nightly
```

Nightly builds publish under the `nightly` dist-tag on a ~3-hour cadence; `latest` isn't claimed by a stable release yet, so pin `@nightly` explicitly. `npm install -g helmcode@nightly` works the same way if you want it on `PATH` instead of re-fetching via `npx` each time.

Package-registry installs (`winget`, Homebrew, AUR) are still not set up on this fork — those need separate submissions to each registry, none of which exist here yet. Run from source instead if you want to skip npm entirely; see the contributing section below.

## Some notes

This is early and forked. Expect bugs, and expect it to drift from upstream over time.

Not actively accepting contributions right now — small, focused fixes may still be considered. See [CONTRIBUTING.md](./CONTRIBUTING.md) before opening an issue or PR.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Customize a project icon](./docs/user/project-settings.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- Linux: [run Helm Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## Building from source

### Install `vp`

Helm Code uses Vite+ so you'll need to install the global `vp` command-line tool.

macOS / Linux:

```bash
curl -fsSL https://vite.plus | bash
```

Windows:

```bash
irm https://vite.plus/ps1 | iex
```

See their getting-started guide for more: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

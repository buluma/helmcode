# helmcode

Server-only CLI for [Helm Code](https://github.com/buluma/helmcode) — an agent harness control surface that drives coding-agent CLIs (Claude Code, Codex, Cursor, Grok Build, OpenCode) on your machine, controllable from a web, desktop, or mobile client.

This package ships just the server. For the desktop app, see [GitHub Releases](https://github.com/buluma/helmcode/releases).

## Install

```bash
npx helmcode@nightly
```

Nightly builds publish on a ~3-hour cadence under the `nightly` dist-tag. Stable releases publish under `latest`; see the [releases page](https://github.com/buluma/helmcode/releases) for what's current on each channel.

To keep it on `PATH` instead of re-fetching via `npx` each time:

```bash
npm install -g helmcode@nightly
```

## Requirements

Node.js `^22.16 || ^23.11 || >=24.10`, and at least one provider CLI installed and authenticated — see [Providers](https://github.com/buluma/helmcode/blob/main/docs/user/install.md#providers).

## Usage

```bash
npx helmcode serve            # start the server
npx helmcode pair             # pair a client (web/desktop/mobile)
npx helmcode service install  # run as a background service (Linux/systemd)
```

Full command reference and setup docs: [docs/user/install.md](https://github.com/buluma/helmcode/blob/main/docs/user/install.md).

## Links

- [Source](https://github.com/buluma/helmcode)
- [Docs](https://github.com/buluma/helmcode/tree/main/docs)
- [Issues](https://github.com/buluma/helmcode/issues)

## License

MIT

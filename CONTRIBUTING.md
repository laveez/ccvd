# Contributing to ccvd

Thanks for helping. Bug reports, ideas and pull requests are all welcome. For anything bigger than a small fix, open an issue first so we can agree on the approach before you spend time on it.

## Set up

You need Node.js 22.18 or newer (`.nvmrc` has the version CI builds with) and a Chromium-based browser: Google Chrome, or Playwright's Chromium.

```bash
git clone https://github.com/laveez/ccvd.git
cd ccvd
npm ci
npx playwright-core install chromium
git config core.hooksPath .githooks
```

The last line enables the pre-push hook, which runs `npm run check`.

## Run it

```bash
npm run build
node dist/bin/ccvd.js demo
```

`demo` serves the two versions of the site in `examples/demo` and opens the compare view on them. Any change to `src/` or `ui/` needs a new `npm run build` before it shows up.

## Checks

| Command | What it does |
|---|---|
| `npm run lint` | Biome lint and format check (`npm run format` fixes what it can) |
| `npm run typecheck` | TypeScript for the Node code, the tests, the scripts and the browser UI |
| `npm run versions` | The package, plugin, marketplace and skill versions match |
| `npm run build` | Compiles to `dist/` |
| `npm test` | Unit and end-to-end tests (`test:unit`, `test:e2e`) |
| `npm run check` | All of the above, as CI runs them |

The end-to-end tests start a real Chromium. They use Playwright's Chromium when it is installed and Google Chrome otherwise.

`test/e2e/baselines.test.ts` checks ccvd against the calibration pages in `test/baselines`. After a change to capturing or to the diff image, redraw their images with `npm run baselines` and look at each one before committing.

## Project layout

| Path | What it holds |
|---|---|
| `src/bin/ccvd.ts` | The `ccvd` command |
| `src/cli.ts` | Argument parsing and the help text |
| `src/side.ts` | One compared page: its browser context, input, scroll reports and captures |
| `src/session.ts` | The two sides together: leader and scroll sync, linked input, settle and diff |
| `src/server.ts` | The local HTTP and WebSocket server, its token and header checks, and exports |
| `src/protocol.ts` | Message types shared by the server and the UI |
| `src/ui/app.ts`, `ui/` | The compare view in the browser |
| `src/shot.ts` | `ccvd shot` |
| `src/png.ts`, `src/diff.ts`, `src/compose.ts` | PNG reading and writing, the pixel diff, composite images |
| `plugins/ccvd/`, `.claude-plugin/` | The Claude Code plugin, its skill and the marketplace entry |
| `examples/demo/` | The demo site, in a before and an after version |
| `test/baselines/` | Calibration pages with known diffs, their reference images and expectations (`cases.ts`) |

## Code style

- Biome formats and lints everything except Markdown. Run `npm run format` before you commit.
- TypeScript runs straight from source in the tests, so use only syntax Node can strip (no enums, namespaces or parameter properties) and import relative files with their `.ts` extension.
- Comment only what the code cannot say: a workaround and what breaks without it, surprising API behaviour, coupling to another file. Prefer a clearer name to a comment.
- ccvd has two runtime dependencies, `playwright-core` and `ws`. Open an issue before adding another.

## Commit messages

```
<Type>: <Short description>

- <Detail 1>
- <Detail 2>
```

Types: `Feature`, `Fix`, `Refactor`, `Docs`, `Test`, `Chore`. The GitHub release notes list the `Feature:` and `Fix:` subjects, so write those for users.

## Pull requests

- One concern per pull request.
- Fill in the template: Overview, Technical Details, Testing Instructions.
- For a visible change to the compare view, add a before and after image.
- CI must pass: Lint, Typecheck, Versions, Build, and Test on Linux and macOS with Node 22 and 26.

## Releasing

Maintainers release from `main`:

1. `npm run set-version -- 0.2.0` moves the package, plugin, marketplace and skill to the new version.
2. Commit it as `Chore: Release 0.2.0` and get it onto `main`.
3. Tag and push: `git tag v0.2.0 && git push origin v0.2.0`.

The Release workflow runs CI on the tag, checks the tag against `package.json`, publishes to npm with provenance and publishes the GitHub release, with notes listing the `Feature:` and `Fix:` subjects since the previous tag.

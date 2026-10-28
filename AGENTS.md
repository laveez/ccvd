# Agent instructions for ccvd

ccvd (Claude Code Visual Diff) shows two versions of a site side by side with an exact pixel diff between them. A Node CLI drives one headless Chromium (playwright-core) that renders both sides, serves a compare view on `127.0.0.1`, and writes before, after and diff PNGs with `ccvd shot`. The repository is also a Claude Code plugin marketplace whose skill teaches Claude to use ccvd.

Read CONTRIBUTING.md for setup, the project layout and the commit format. This file adds what an agent needs on top of it.

## Commands

- Setup: `npm ci`, then `npx playwright-core install chromium` if Google Chrome is not installed.
- Before saying a change is done: `npm run check`. It runs lint, typecheck, the version check, the build and every test, as CI does.
- Fix formatting with `npm run format`.
- See the UI: `npm run build && node dist/bin/ccvd.js demo --no-open`, then open the printed address. Check any UI change in a browser yourself before handing it over.

## Invariants

- **The diff is exact.** Equal RGBA bytes are unchanged; anything else is red (`#FF0000`). No thresholds and no anti-aliasing tolerance. Both sides render in the same Chromium at the same size and pixel ratio, which is what makes equal pages come out with zero changed pixels. Keep it that way.
- **Exports are pixel copies.** `compose.ts` copies captures into the composite in Node; only the label strips come from the browser.
- **Security checks stay.** The server binds `127.0.0.1`; the WebSocket and `/export.png` need the token; requests need an allowed `Host`, the WebSocket an allowed `Origin`; pages navigate to http(s) only; `parseClientMessage` validates every message from the UI. Do not loosen any of these.
- **Versions move together.** `package.json`, `plugins/ccvd/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and every `@laveez/ccvd@<version>` in `plugins/ccvd/skills/ccvd/SKILL.md`. Use `npm run set-version -- <version>`; `npm run versions` checks them.
- **`src/protocol.ts` is shared** by the server build and the UI build. Keep it types only: the UI is served as a single module, `dist/ui/app.js`, and cannot import runtime values from other files.
- **No personal data** in the repository: no real names, email addresses or private sites. Examples use `examples/demo` or `localhost`.

## Code

- TypeScript in erasable syntax only (no enums, namespaces or parameter properties), with `.ts` extensions on relative imports. Tests run the sources directly with `node --test`.
- Code that runs inside the compared pages lives as strings in `src/page-script.ts`, since the Node build has no DOM types.
- Input goes to the pages as raw CDP events without waiting for each reply. Keys outside Playwright's US layout (`ä`) go as raw key events with their text.
- Comments only for what the code cannot say. No new runtime dependencies without an issue.

## Tests

- `test/unit` covers the PNG codec, the diff, addresses, sizes and argument parsing. `test/e2e` drives real Chromium against `examples/demo`.
- In live tests, a side the user touched leads scrolling for 1.5 seconds. A test that scrolls pages directly within that window will see the other side follow. Focus or scroll both pages explicitly, or wait for the window to pass.
- Navigate with a fresh query string when the page is already open, so that waiting for its path also waits for the reload.

## Pull requests

One concern per pull request, the template's three sections, `Type: Short description` commits. Visible UI changes come with a before and after image; `ccvd shot` makes them.

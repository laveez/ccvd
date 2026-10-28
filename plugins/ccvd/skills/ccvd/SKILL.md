---
name: ccvd
description: Use when comparing how a web page or site looks before and after a change (two commits, branches, deployments or URLs), when making before and after screenshots for a pull request, or when checking a UI change or refactor for visual regressions.
---

# ccvd: Claude Code Visual Diff

ccvd renders two versions of a site in one hidden Chromium and compares them pixel by pixel. Changed pixels are red; everything else is shown faded. It has two modes:

- **Live view**, for the user: before, diff and after side by side in their browser, with scrolling, clicks, typing and links mirrored to both sides.
- **shot**, for you: before, after, diff and composite PNGs per page and size, with the count of changed pixels.

Run it as `npx -y ccvd@0.1.0`. It needs Google Chrome, or the Chromium from `npx -y playwright-core install chromium`.

## 1. Get two addresses

ccvd compares two running sites. Use deployed URLs as they are (production against a local dev server works too). To compare two git versions of the project:

1. Check out each version into its own folder outside the working tree: `git worktree add --detach <dir> <ref>`, or `git archive <ref> | tar -x -C <dir>` when the build does not need git.
2. Install dependencies in each folder if the project needs them.
3. Start the project's own dev server in each folder, in the background, on two different free ports. Find the command in the README, `package.json` scripts or similar. Examples: `npm run dev -- --port 8101`, `php -S 127.0.0.1:8101`, `python3 -m http.server 8101 --directory <dir>`.
4. Wait until both servers answer before running ccvd.

## 2. Live view for the user

Run in the background; it keeps running until stopped:

```bash
npx -y ccvd@0.1.0 http://127.0.0.1:8101/ http://127.0.0.1:8102/
```

It opens the view in the user's browser and prints its address (`Open http://127.0.0.1:2283/?t=…`). Give the user that address. Add `--no-open` when the user is on another machine. Useful options: `--size desktop|laptop|tablet|phone|WIDTHxHEIGHT`, `--reduced-motion` for pages that keep animating.

## 3. Images for a PR, or to check your own work

```bash
npx -y ccvd@0.1.0 shot http://127.0.0.1:8101/ http://127.0.0.1:8102/ --path / --path pricing --size desktop --size phone --out <dir> --json
```

- `--path` resolves against the before address the way a link would; the after side gets the same page.
- Each page and size gets `-before`, `-after`, `-diff`, `-pair` (before and after) and `-triple` (before, diff and after) PNGs. Full page by default; `--viewport` for the visible part only.
- The JSON lists `changed` and `total` pixels and each side's HTTP `status` and `error`.

Then, before reporting:

- Open every `-diff.png` and say what the red areas are, and whether each change was intended.
- `changed: 0` means the pages are pixel-identical, which proves a refactor changed nothing visible.
- A side with `status` 400 or higher, or an `error`, did not load. Fix the server and run again; a diff against an error page means nothing.
- A layout shift turns everything below it red. Find where the red starts.

## 4. Clean up

Stop ccvd and the servers you started, and remove the folders (`git worktree remove <dir>`).

## Common mistakes

| Mistake                                     | Fix                                    |
| ------------------------------------------- | -------------------------------------- |
| Diffing while a dev server still compiles   | Wait for its ready line, then run ccvd |
| Both servers on one port                    | One free port each                     |
| Animated page, the diff never settles       | `--reduced-motion`                     |
| Reporting the image count, not what changed | Describe the red areas in each diff    |

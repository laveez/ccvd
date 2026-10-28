# Calibration baselines

Before and after pages with a known diff, from one changed pixel to a layout shift. Each folder holds the two pages and the before, diff and after images ccvd made of them, and `test/e2e/baselines.test.ts` checks every case on each test run.

Shapes draw the same on every machine, so their cases have exact counts, and the tests also check that the same pixels are red as in the diff here. Text draws a little differently from machine to machine (fonts, GPU or CPU drawing), so the case where text changes is checked by where its red is.

| Case | Expected | Before | Diff | After |
|---|---|---|---|---|
| [Nothing changes](identical/) | exactly 0 changed pixels | ![Nothing changes, before](identical/before.png) | ![Nothing changes, diff](identical/diff.png) | ![Nothing changes, after](identical/after.png) |
| [One pixel turns one shade bluer](one-pixel/) | exactly 1 changed pixel, all inside x 300, y 260 | ![One pixel turns one shade bluer, before](one-pixel/before.png) | ![One pixel turns one shade bluer, diff](one-pixel/diff.png) | ![One pixel turns one shade bluer, after](one-pixel/after.png) |
| [A 200×100 box changes colour](color-block/) | exactly 20,000 changed pixels, all inside x 140–339, y 140–239 | ![A 200×100 box changes colour, before](color-block/before.png) | ![A 200×100 box changes colour, diff](color-block/diff.png) | ![A 200×100 box changes colour, after](color-block/after.png) |
| [The box moves 10 px to the right](moved-block/) | exactly 2,000 changed pixels, all inside x 140–349, y 140–239 | ![The box moves 10 px to the right, before](moved-block/before.png) | ![The box moves 10 px to the right, diff](moved-block/diff.png) | ![The box moves 10 px to the right, after](moved-block/after.png) |
| [One word changes](text/) | some changed pixels, all inside x 90–249, y 56–87 | ![One word changes, before](text/before.png) | ![One word changes, diff](text/diff.png) | ![One word changes, after](text/after.png) |
| [A banner pushes the content down](layout-shift/) | some changed pixels, on rows 40–339 | ![A banner pushes the content down, before](layout-shift/before.png) | ![A banner pushes the content down, diff](layout-shift/diff.png) | ![A banner pushes the content down, after](layout-shift/after.png) |
| [The after page is 60 px taller](taller/) | exactly 28,800 changed pixels, on rows 300–359 | ![The after page is 60 px taller, before](taller/before.png) | ![The after page is 60 px taller, diff](taller/diff.png) | ![The after page is 60 px taller, after](taller/after.png) |

Drawn by `npm run baselines` at 480×300, full page, with Chromium 156.0.8078.47 on Linux. Run it again after a change to capturing or to the diff image, and look at every image before committing them.

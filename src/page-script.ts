// These run inside the compared pages, so they are plain JavaScript strings rather than typed functions.

export const SCROLL_BINDING = '__ccvdScroll';

// Full-page captures stop at this height, so endless feeds end and images stay within memory.
export const MAX_FULL_PAGE_CSS_PX = 16_384;

// Reports window scroll once per frame, and skips the report for a scroll ccvd applied itself so the
// two sides do not echo each other's positions back and forth.
export const PAGE_SCRIPT = `(() => {
  if (window.top !== window || window.__ccvdApplyScroll) return;
  let applied = null;
  let pending = 0;
  window.__ccvdApplyScroll = (x, y) => {
    applied = [x, y];
    window.scrollTo({ left: x, top: y, behavior: 'instant' });
  };
  addEventListener('scroll', () => {
    if (pending) return;
    pending = requestAnimationFrame(() => {
      pending = 0;
      const x = Math.round(window.scrollX);
      const y = Math.round(window.scrollY);
      const echo = applied && applied[0] === x && applied[1] === y;
      applied = null;
      if (!echo && window.${SCROLL_BINDING}) window.${SCROLL_BINDING}(x, y);
    });
  }, { passive: true });
})();`;

export const SCROLL_POSITION = '[Math.round(window.scrollX), Math.round(window.scrollY)]';

// Finished animations jump to their end state and endless ones go back to their start, as
// Playwright's screenshot option animations: 'disabled' does; media stops so frames match.
export const FREEZE = `(() => {
  for (const animation of document.getAnimations()) {
    const timing = animation.effect && animation.effect.getComputedTiming();
    if (timing && Number.isFinite(timing.endTime)) animation.finish();
    else animation.cancel();
  }
  for (const media of document.querySelectorAll('video, audio')) media.pause();
  const style = document.createElement('style');
  style.textContent = '*, *::before, *::after { caret-color: transparent !important; }';
  document.documentElement.append(style);
})()`;

// Scrolls down a screen at a time so lazy images and scroll-triggered content load before a
// full-page capture, stopping at the capture height or after 8 seconds on pages that keep growing.
export const STEP_THROUGH = `(async () => {
  const step = Math.max(200, window.innerHeight);
  const started = performance.now();
  for (let y = 0; y < Math.min(document.documentElement.scrollHeight, ${MAX_FULL_PAGE_CSS_PX}); y += step) {
    if (performance.now() - started > 8000) break;
    window.scrollTo({ left: 0, top: y, behavior: 'instant' });
    await new Promise(resolve => setTimeout(resolve, 60));
  }
  window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
})()`;

export const FONTS_READY = 'document.fonts ? document.fonts.ready.then(() => true) : true';

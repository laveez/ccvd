import { EventEmitter } from 'node:events';
import type { Browser, BrowserContext, CDPSession, Page, Request } from 'playwright-core';
import {
  FONTS_READY,
  FREEZE,
  MAX_FULL_PAGE_CSS_PX,
  PAGE_SCRIPT,
  SCROLL_BINDING,
  SCROLL_POSITION,
  STEP_THROUGH,
} from './page-script.ts';
import { blankImage, blit, decodePng, type RgbaImage } from './png.ts';
import type { KeyInput, MouseInput, SideName, SideState, ViewSize, WheelInput } from './protocol.ts';
import { withTimeout } from './timeout.ts';
import { displayPath } from './urls.ts';

export interface ScreencastFrame {
  jpeg: Buffer;
}

interface SideEvents {
  frame: [ScreencastFrame];
  scroll: [{ x: number; y: number }];
  navigating: [];
  navigated: [url: string, own: boolean];
  state: [];
}

type PageWithScroll = typeof globalThis & { __ccvdApplyScroll?: (x: number, y: number) => void };

const MOUSE_EVENT = { move: 'mouseMoved', down: 'mousePressed', up: 'mouseReleased' } as const;

// Chromium wraps captures taller than its 16384 px texture limit, so full pages are taken in slices.
const MAX_SLICE_DEVICE_PX = 8192;
const MAX_SCROLL = 10_000_000;
const PREPARE_STEP_MS = 10_000;

export class Side extends EventEmitter<SideEvents> {
  readonly name: SideName;
  readonly base: URL;
  readonly page: Page;
  readonly state: SideState;
  size: ViewSize;
  navigatingTo: string | undefined;
  private readonly context: BrowserContext;
  private readonly cdp: CDPSession;
  private keyQueue: Promise<void> = Promise.resolve();
  private screencasting = false;
  private ownNavigation = false;

  private constructor(name: SideName, base: URL, page: Page, context: BrowserContext, cdp: CDPSession, size: ViewSize) {
    super();
    this.name = name;
    this.base = base;
    this.page = page;
    this.context = context;
    this.cdp = cdp;
    this.size = size;
    this.state = { base: base.href, url: 'about:blank', path: '', title: '', loading: false };
  }

  static async open(
    browser: Browser,
    name: SideName,
    base: URL,
    size: ViewSize,
    reducedMotion: boolean,
  ): Promise<Side> {
    const context = await browser.newContext({
      viewport: null,
      acceptDownloads: false,
      reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
    });
    let side: Side | undefined;
    // Every frame of every page, cross-origin iframes included, can call the binding with any values,
    // so only numbers from the main frame count.
    await context.exposeBinding(SCROLL_BINDING, (source, x: unknown, y: unknown) => {
      if (!side || source.page !== side.page || source.frame !== side.page.mainFrame()) return;
      if (!isScroll(x) || !isScroll(y)) return;
      side.emit('scroll', { x: Math.round(x), y: Math.round(y) });
    });
    await context.addInitScript(PAGE_SCRIPT);
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    side = new Side(name, base, page, context, cdp, size);
    side.listen();
    await side.setSize(size);
    return side;
  }

  async startScreencast(): Promise<void> {
    if (this.screencasting) return;
    this.screencasting = true;
    await this.cdp.send('Page.startScreencast', { format: 'jpeg', quality: 80 });
  }

  async stopScreencast(): Promise<void> {
    if (!this.screencasting) return;
    this.screencasting = false;
    await this.cdp.send('Page.stopScreencast').catch(() => {});
  }

  async capturePng(): Promise<Buffer> {
    const { data } = await this.cdp.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
    return Buffer.from(data, 'base64');
  }

  async captureFullPage(): Promise<RgbaImage> {
    await this.scrollTo(0, 0);
    const { cssContentSize } = await this.cdp.send('Page.getLayoutMetrics');
    const { width, dpr } = this.size;
    const height = Math.min(MAX_FULL_PAGE_CSS_PX, Math.max(this.size.height, Math.ceil(cssContentSize.height)));
    const image = blankImage(width * dpr, height * dpr);
    const slice = Math.floor(MAX_SLICE_DEVICE_PX / dpr);
    for (let top = 0; top < height; top += slice) {
      const { data } = await this.cdp.send('Page.captureScreenshot', {
        format: 'png',
        optimizeForSpeed: true,
        captureBeyondViewport: true,
        clip: { x: 0, y: top, width, height: Math.min(slice, height - top), scale: 1 },
      });
      blit(image, decodePng(Buffer.from(data, 'base64')), 0, top * dpr);
    }
    return image;
  }

  mouse(input: MouseInput): void {
    void this.cdp
      .send('Input.dispatchMouseEvent', {
        type: MOUSE_EVENT[input.action],
        x: input.x,
        y: input.y,
        button: input.button,
        buttons: input.buttons,
        clickCount: input.clickCount,
        modifiers: input.modifiers,
      })
      .catch(() => {});
  }

  wheel(input: WheelInput): void {
    void this.cdp
      .send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: input.x,
        y: input.y,
        deltaX: input.deltaX,
        deltaY: input.deltaY,
        modifiers: input.modifiers,
      })
      .catch(() => {});
  }

  key(input: KeyInput): void {
    this.keyQueue = this.keyQueue.then(() => this.dispatchKey(input)).catch(() => {});
  }

  async scrollTo(x: number, y: number): Promise<void> {
    await this.page
      .evaluate(([left, top]) => (globalThis as PageWithScroll).__ccvdApplyScroll?.(left, top), [x, y] as const)
      .catch(() => {});
  }

  async scrollPosition(): Promise<[number, number]> {
    return this.page.evaluate<[number, number]>(SCROLL_POSITION);
  }

  // `own` marks a navigation ccvd starts itself, which the other side must not mirror back.
  async goto(url: string, own = true): Promise<void> {
    if (!/^https?:/i.test(url)) throw new Error(`Only http and https addresses are supported: ${url}`);
    this.navigatingTo = url;
    this.ownNavigation = own;
    await this.page.goto(url, { waitUntil: 'commit' }).catch(error => this.navigationFailed(error));
  }

  async back(): Promise<void> {
    this.ownNavigation = true;
    const response = await this.page.goBack({ waitUntil: 'commit' }).catch(error => this.navigationFailed(error));
    if (response === null) this.ownNavigation = false;
  }

  async forward(): Promise<void> {
    this.ownNavigation = true;
    const response = await this.page.goForward({ waitUntil: 'commit' }).catch(error => this.navigationFailed(error));
    if (response === null) this.ownNavigation = false;
  }

  async reload(): Promise<void> {
    this.ownNavigation = true;
    await this.page.reload({ waitUntil: 'commit' }).catch(error => this.navigationFailed(error));
  }

  async setSize(size: ViewSize): Promise<void> {
    this.size = size;
    await this.cdp.send('Emulation.setDeviceMetricsOverride', {
      width: size.width,
      height: size.height,
      deviceScaleFactor: size.dpr,
      mobile: false,
    });
  }

  async setReducedMotion(reduced: boolean): Promise<void> {
    await this.page.emulateMedia({ reducedMotion: reduced ? 'reduce' : 'no-preference' });
  }

  async prepareForCapture(fullPage: boolean, wait: number): Promise<void> {
    const { page } = this;
    const step = (task: Promise<unknown>, what: string) => withTimeout(task, PREPARE_STEP_MS, what).catch(() => {});
    await step(page.waitForLoadState('load'), 'Loading');
    await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
    await step(page.evaluate(FONTS_READY), 'Loading fonts');
    if (fullPage) {
      await step(page.evaluate(STEP_THROUGH), 'Scrolling through the page');
      await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    }
    if (wait > 0) await page.waitForTimeout(wait);
    await step(page.evaluate(FREEZE), 'Freezing animations');
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => {});
  }

  private listen(): void {
    const { page, cdp } = this;
    // Dismissing a beforeunload prompt means staying on the page, which would cancel ccvd's navigation.
    page.on('dialog', dialog => {
      void (dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss()).catch(() => {});
    });
    page.on('crash', () => this.update({ loading: false, error: 'The page crashed. Reload to try again.' }));
    this.context.on('page', popup => void this.adoptPopup(popup));
    page.on('request', request => {
      if (!this.isMainNavigation(request)) return;
      this.navigatingTo = request.url();
      this.update({ loading: true, status: undefined, error: undefined });
      this.emit('navigating');
    });
    page.on('response', response => {
      if (this.isMainNavigation(response.request())) this.update({ status: response.status() });
    });
    page.on('requestfailed', request => {
      if (!this.isMainNavigation(request)) return;
      const reason = request.failure()?.errorText ?? 'failed';
      if (reason.includes('ERR_ABORTED')) return;
      this.navigatingTo = undefined;
      this.update({ loading: false, error: `${reason} (${request.url()})` });
    });
    page.on('framenavigated', frame => {
      if (frame !== page.mainFrame()) return;
      this.navigatingTo = undefined;
      const own = this.ownNavigation;
      this.ownNavigation = false;
      const url = frame.url();
      this.update({ url, path: /^https?:/.test(url) ? displayPath(new URL(url)) : url });
      this.emit('navigated', url, own);
    });
    page.on('domcontentloaded', () => void this.refreshTitle());
    page.on('load', () => {
      void this.refreshTitle();
      this.update({ loading: false });
    });
    cdp.on('Page.screencastFrame', ({ data, sessionId }) => {
      void cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
      this.emit('frame', { jpeg: Buffer.from(data, 'base64') });
    });
  }

  private isMainNavigation(request: Request): boolean {
    try {
      return request.isNavigationRequest() && request.frame() === this.page.mainFrame();
    } catch {
      return false;
    }
  }

  private update(changes: Partial<SideState>): void {
    Object.assign(this.state, changes);
    this.emit('state');
  }

  private async refreshTitle(): Promise<void> {
    const title = await this.page.title().catch(() => this.state.title);
    if (title !== this.state.title) this.update({ title });
  }

  private navigationFailed(error: unknown): void {
    this.ownNavigation = false;
    const message = error instanceof Error ? error.message.split('\n')[0] : String(error);
    if (/ERR_ABORTED|interrupted by another navigation|Target .*closed/i.test(message)) return;
    this.update({ loading: false, error: message.replace(/^page\.\w+: /, '') });
  }

  private async adoptPopup(popup: Page): Promise<void> {
    if (popup === this.page) return;
    try {
      await popup.waitForURL(url => url.protocol !== 'about:', { timeout: 5000, waitUntil: 'commit' });
      const url = popup.url();
      await popup.close();
      if (/^https?:/i.test(url)) await this.goto(url, false);
    } catch {
      await popup.close().catch(() => {});
    }
  }

  private async dispatchKey({ action, key }: KeyInput): Promise<void> {
    // Playwright's keyboard knows the US layout only and rejects other characters ("Unknown key: ä"),
    // so those go to Chromium as raw key events with their text.
    const outsideLayout = [...key].length === 1 && (key.codePointAt(0) ?? 0) > 126;
    if (outsideLayout) {
      await this.cdp.send(
        'Input.dispatchKeyEvent',
        action === 'down' ? { type: 'keyDown', key, text: key, unmodifiedText: key } : { type: 'keyUp', key },
      );
      return;
    }
    if (action === 'down') await this.page.keyboard.down(key);
    else await this.page.keyboard.up(key);
  }
}

function isScroll(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= MAX_SCROLL;
}

import { EventEmitter } from 'node:events';
import type { Browser } from 'playwright-core';
import { firstLine } from './browser.ts';
import { type DiffResult, diffImages } from './diff.ts';
import { decodePng, encodePng, type RgbaImage } from './png.ts';
import type {
  Channel,
  ClientMessage,
  FrameHeader,
  KeyInput,
  MouseInput,
  NavigateRequest,
  ServerMessage,
  StateMessage,
  ViewSize,
  WheelInput,
} from './protocol.ts';
import { type ScreencastFrame, Side } from './side.ts';
import { MAX_SIDE, MIN_SIDE, PRESETS } from './sizes.ts';
import { TimeoutError, withTimeout } from './timeout.ts';
import { mapUrl, resolvePath } from './urls.ts';
import { VERSION } from './version.ts';

export interface Capture {
  id: number;
  before: RgbaImage;
  after: RgbaImage;
  diff: DiffResult;
  beforePath: string;
  afterPath: string;
  beforeUrl: string;
  size: ViewSize;
}

interface SessionEvents {
  message: [ServerMessage];
  frame: [FrameHeader, Buffer];
}

export interface SessionOptions {
  before: URL;
  after: URL;
  size: ViewSize;
  fit: boolean;
  reducedMotion: boolean;
}

const TICK_MS = 50;
const QUIET_MS = 150;
const MAX_STALE_MS = 750;
const LEAD_MS = 1500;
const LEAD_EXTEND_MS = 300;
const MAX_LEAD_MS = 5000;
// A capture makes Chromium send one more, identical frame about 10 ms after it ends.
const ECHO_MS = 150;
const CAPTURE_TIMEOUT_MS = 15_000;
const CTRL = 2;

export class Session extends EventEmitter<SessionEvents> {
  readonly before: Side;
  readonly after: Side;
  size: ViewSize;
  fit: boolean;
  linked = true;
  reducedMotion: boolean;
  latest: Capture | undefined;
  readonly exactFrames = new Map<Channel, [FrameHeader, Buffer]>();
  private leader: Side | undefined;
  private leadStartedAt = 0;
  private leaderUntil = 0;
  private dirtySince = 0;
  private lastFrameAt = 0;
  private capturing = false;
  private lastCaptureEnd = 0;
  private captureStalled = false;
  private captures = 0;
  private viewers = 0;
  private timer: NodeJS.Timeout | undefined;
  private statePending = false;
  private closed = false;
  private lastPngs: [Buffer, Buffer] | undefined;
  private readonly lastJpeg = new Map<Side, Buffer>();
  private readonly userNavigation = new Map<Side, boolean>();

  private constructor(before: Side, after: Side, options: SessionOptions) {
    super();
    this.before = before;
    this.after = after;
    this.size = options.size;
    this.fit = options.fit;
    this.reducedMotion = options.reducedMotion;
  }

  static async create(browser: Browser, options: SessionOptions): Promise<Session> {
    const { before, after, size, reducedMotion } = options;
    const [beforeSide, afterSide] = await Promise.all([
      Side.open(browser, 'before', before, size, reducedMotion),
      Side.open(browser, 'after', after, size, reducedMotion),
    ]);
    const session = new Session(beforeSide, afterSide, options);
    session.wire();
    await Promise.all([beforeSide.goto(before.href), afterSide.goto(after.href)]);
    return session;
  }

  attach(): void {
    if (this.viewers++ === 0) {
      this.run(this.before.startScreencast());
      this.run(this.after.startScreencast());
    }
    this.markDirty();
  }

  detach(): void {
    if (--this.viewers > 0) return;
    void this.before.stopScreencast();
    void this.after.stopScreencast();
  }

  state(): StateMessage {
    return {
      type: 'state',
      version: VERSION,
      before: this.before.state,
      after: this.after.state,
      size: this.size,
      fit: this.fit,
      linked: this.linked,
      reducedMotion: this.reducedMotion,
      presets: PRESETS,
    };
  }

  handle(message: ClientMessage): void {
    switch (message.type) {
      case 'mouse':
        this.mirror(message, (side, input) => side.mouse(input), message.action === 'down');
        break;
      case 'key':
        this.mirror(message, (side, input) => side.key(input), true);
        break;
      case 'wheel':
        this.wheel(message);
        break;
      case 'navigate':
        this.run(this.navigate(message));
        break;
      case 'size':
        this.fit = message.fit;
        this.queueState();
        this.run(this.resize(message));
        break;
      case 'linked':
        this.linked = message.value;
        this.queueState();
        break;
      case 'reducedMotion':
        this.run(this.setReducedMotion(message.value));
        break;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.timer);
    await Promise.all([this.before.close(), this.after.close()]);
  }

  private wire(): void {
    for (const side of [this.before, this.after]) {
      side.on('frame', frame => this.onFrame(side, frame));
      side.on('scroll', ({ x, y }) => this.onScroll(side, x, y));
      side.on('navigating', () => this.userNavigation.set(side, this.leads(side)));
      side.on('navigated', (url, own) => this.onNavigated(side, url, own));
      side.on('state', () => this.queueState());
    }
  }

  private run(task: Promise<unknown>): void {
    task.catch(error => this.report(firstLine(error)));
  }

  private report(message: string): void {
    if (!this.closed) this.emit('message', { type: 'error', message });
  }

  private other(side: Side): Side {
    return side === this.before ? this.after : this.before;
  }

  private sideFor(channel: Channel): Side {
    return channel === 'after' ? this.after : this.before;
  }

  private lead(side: Side): void {
    const now = Date.now();
    this.leader = side;
    this.leadStartedAt = now;
    this.leaderUntil = now + LEAD_MS;
  }

  private leads(side: Side): boolean {
    return side === this.leader && Date.now() <= this.leaderUntil;
  }

  private mirror<T extends MouseInput | KeyInput>(
    input: T,
    send: (side: Side, input: T) => void,
    leads: boolean,
  ): void {
    const side = this.sideFor(input.side);
    if (leads) this.lead(side);
    send(side, input);
    if (this.linked) send(this.other(side), input);
  }

  // Only the side under the pointer scrolls from the wheel; the other follows its window scroll in
  // onScroll, which keeps the two at the same offset even where their pages differ in height.
  private wheel(input: WheelInput): void {
    if (input.modifiers & CTRL) return;
    const side = this.sideFor(input.side);
    this.lead(side);
    side.wheel(input);
  }

  private onScroll(side: Side, x: number, y: number): void {
    if (!this.leads(side)) return;
    const now = Date.now();
    this.leaderUntil = Math.min(this.leadStartedAt + MAX_LEAD_MS, Math.max(this.leaderUntil, now + LEAD_EXTEND_MS));
    void this.other(side).scrollTo(x, y);
  }

  // Only navigations the user started on the leading side are followed. Navigations ccvd starts
  // itself, and the other side's reaction to a followed one, are not mirrored back, so differing
  // redirects, query strings or base folders cannot bounce the two sides between each other.
  private onNavigated(side: Side, url: string, own: boolean): void {
    this.markDirty();
    const user = this.userNavigation.get(side) ?? this.leads(side);
    this.userNavigation.delete(side);
    if (own || !user || !this.linked || !/^https?:/i.test(url)) return;
    const other = this.other(side);
    const target = mapUrl(url, side.base, other.base);
    if (other.page.url() === target || other.navigatingTo === target) return;
    this.run(other.goto(target));
  }

  private async navigate(request: NavigateRequest): Promise<void> {
    if (request.action !== 'goto') {
      await Promise.all([this.before[request.action](), this.after[request.action]()]);
      return;
    }
    const target = (side: Side) => (request.path === '' ? side.base : resolvePath(side.base, request.path));
    let urls: [URL, URL];
    try {
      urls = [target(this.before), target(this.after)];
    } catch (error) {
      this.report(firstLine(error));
      return;
    }
    await Promise.all([this.before.goto(urls[0].href), this.after.goto(urls[1].href)]);
  }

  private async resize(request: ViewSize): Promise<void> {
    const size: ViewSize = {
      width: clamp(Math.round(request.width), MIN_SIDE, MAX_SIDE),
      height: clamp(Math.round(request.height), MIN_SIDE, MAX_SIDE),
      dpr: request.dpr === 2 ? 2 : 1,
    };
    if (size.width === this.size.width && size.height === this.size.height && size.dpr === this.size.dpr) return;
    this.size = size;
    await Promise.all([this.before.setSize(size), this.after.setSize(size)]);
    this.queueState();
    this.markDirty();
  }

  private async setReducedMotion(reduced: boolean): Promise<void> {
    this.reducedMotion = reduced;
    await Promise.all([this.before.setReducedMotion(reduced), this.after.setReducedMotion(reduced)]);
    this.queueState();
    this.markDirty();
  }

  private onFrame(side: Side, frame: ScreencastFrame): void {
    // Lossy JPEG frames can be identical before and after a small change, so an identical frame
    // still counts as a change, unless it is the echo of a capture that just finished.
    const previous = this.lastJpeg.get(side);
    this.lastJpeg.set(side, frame.jpeg);
    const echo = previous?.equals(frame.jpeg) && (this.capturing || Date.now() - this.lastCaptureEnd < ECHO_MS);
    if (echo) return;
    this.markChanged();
    const header: FrameHeader = {
      channel: side.name,
      format: 'jpeg',
      exact: false,
      width: this.size.width,
      height: this.size.height,
    };
    this.emit('frame', header, frame.jpeg);
  }

  private markChanged(): void {
    this.lastFrameAt = Date.now();
    this.dirtySince ||= this.lastFrameAt;
    this.schedule();
  }

  private markDirty(): void {
    this.dirtySince ||= Date.now();
    this.lastFrameAt = 0;
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.closed || this.viewers === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.tick();
    }, TICK_MS);
  }

  private tick(): void {
    if (!this.dirtySince) return;
    const now = Date.now();
    const quiet = now - this.lastFrameAt >= QUIET_MS;
    const overdue = now - this.dirtySince >= MAX_STALE_MS;
    if (!this.capturing && (quiet || overdue)) void this.capture();
    else this.schedule();
  }

  private async capture(): Promise<void> {
    this.capturing = true;
    this.dirtySince = 0;
    const paths = {
      beforePath: this.before.state.path,
      afterPath: this.after.state.path,
      beforeUrl: this.before.state.url,
    };
    try {
      const [beforePng, afterPng] = await withTimeout(
        Promise.all([this.before.capturePng(), this.after.capturePng()]),
        CAPTURE_TIMEOUT_MS,
        'Capturing the pages',
      );
      this.captureStalled = false;
      if (this.closed) return;
      if (this.lastPngs?.[0].equals(beforePng) && this.lastPngs[1].equals(afterPng) && this.latest) {
        this.latest = { ...this.latest, ...paths };
        this.emit('message', { type: 'settled' });
        return;
      }
      this.lastPngs = [beforePng, afterPng];
      const before = decodePng(beforePng);
      const after = decodePng(afterPng);
      const diff = diffImages(before, after);
      const id = ++this.captures;
      this.latest = { id, before, after, diff, ...paths, size: this.size };
      const header = {
        format: 'png',
        exact: true,
        width: this.size.width,
        height: this.size.height,
        capture: id,
      } as const;
      this.publish({ ...header, channel: 'before' }, beforePng);
      this.publish({ ...header, channel: 'after' }, afterPng);
      this.publish({ ...header, channel: 'diff', changed: diff.changed, total: diff.total }, encodePng(diff.image));
    } catch (error) {
      // A side that is mid-navigation cannot be captured; its next frame schedules another try.
      if (error instanceof TimeoutError && !this.captureStalled) {
        this.captureStalled = true;
        this.report('A page stopped responding, so the diff is not up to date. It updates when the page recovers.');
        this.dirtySince ||= Date.now();
      }
    } finally {
      this.capturing = false;
      this.lastCaptureEnd = Date.now();
      if (this.dirtySince) this.schedule();
    }
  }

  private publish(header: FrameHeader, bytes: Buffer): void {
    this.exactFrames.set(header.channel, [header, bytes]);
    this.emit('frame', header, bytes);
  }

  private queueState(): void {
    if (this.statePending) return;
    this.statePending = true;
    setImmediate(() => {
      this.statePending = false;
      if (!this.closed) this.emit('message', this.state());
    });
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

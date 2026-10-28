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
  seq: [number, number];
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
// While a page keeps animating, forced captures start every 750 ms and back off to every 4 s,
// since each capture briefly stalls the page's rendering.
const MIN_FORCED_MS = 750;
const MAX_FORCED_MS = 4000;
// No forced captures while the viewer scrolls, clicks or types: they would stall the pages mid-gesture.
const USER_BUSY_MS = 1000;
const LEAD_MS = 1500;
// A page that keeps moving its own scroll back gets this many corrections before ccvd lets it be.
const MAX_CORRECTIONS = 5;
// No captures until scroll reports have stopped for this long, and until the sides' offsets agree;
// after the grace period a side that cannot scroll as far (a shorter page) no longer holds them up.
const SCROLL_QUIET_MS = 300;
const UNSYNCED_GRACE_MS = 1500;
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
  diffVisible = true;
  reducedMotion: boolean;
  latest: Capture | undefined;
  readonly exactFrames = new Map<Channel, [FrameHeader, Buffer]>();
  private leader: Side | undefined;
  private scrollAnchor: Side | undefined;
  private lastScrollAt = 0;
  private corrections = 0;
  private readonly reported = new Map<Side, [number, number]>();
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
  private forcedMs = MIN_FORCED_MS;
  private lastCaptureStart = 0;
  private userActedAt = 0;
  private shownCapture = 0;
  private inFlight: Promise<void> | undefined;
  private readonly lastJpeg = new Map<Side, Buffer>();
  private readonly liveSeq = new Map<Side, number>();
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
    this.userActed();
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
    if (message.type !== 'mouse' || message.action !== 'move') this.userActed();
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
      case 'diff':
        this.diffVisible = message.value;
        break;
    }
  }

  // Exports must show what the panes show, so a capture older than the latest frames is retaken.
  async currentCapture(): Promise<Capture | undefined> {
    await this.inFlight;
    if (!this.latest || !this.isCurrent(this.latest.seq)) await this.capture();
    return this.latest;
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
    this.leader = side;
    this.leaderUntil = Date.now() + LEAD_MS;
    this.scrollAnchor = side;
    this.corrections = 0;
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

  // The side the user last touched is the scroll anchor, with no time limit: under load its reports
  // can arrive late, and they still count. The other side follows every report, and when it moves
  // on its own (scroll anchoring as content loads above, a page script) it is put back.
  private onScroll(side: Side, x: number, y: number): void {
    const now = Date.now();
    this.lastScrollAt = now;
    this.reported.set(side, [x, y]);
    const anchor = this.scrollAnchor ?? this.before;
    if (side === anchor) {
      // A scroll still running from the viewer's input counts as their activity.
      if (now - this.userActedAt < USER_BUSY_MS * 2) this.userActedAt = now;
      void this.other(side).scrollTo(x, y);
      return;
    }
    const target = this.reported.get(anchor);
    if (!target || (target[0] === x && target[1] === y) || this.corrections >= MAX_CORRECTIONS) return;
    this.corrections++;
    void side.scrollTo(target[0], target[1]);
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
    const seq = (this.liveSeq.get(side) ?? 0) + 1;
    this.liveSeq.set(side, seq);
    this.markChanged();
    const header: FrameHeader = {
      channel: side.name,
      format: 'jpeg',
      exact: false,
      width: this.size.width,
      height: this.size.height,
      seq,
    };
    this.emit('frame', header, frame.jpeg);
  }

  private markChanged(): void {
    this.lastFrameAt = Date.now();
    this.dirtySince ||= this.lastFrameAt;
    this.schedule();
  }

  // Input from the viewer earns a quick capture once the pages hold still; activity a page makes on
  // its own (an animation) only gets captures spaced by the back-off.
  private userActed(): void {
    this.userActedAt = Date.now();
    this.forcedMs = MIN_FORCED_MS;
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
    const userSinceCapture = this.userActedAt > this.lastCaptureStart;
    const spaced = userSinceCapture || now - this.lastCaptureStart >= this.forcedMs;
    const quiet = now - this.lastFrameAt >= QUIET_MS && now - this.lastScrollAt >= SCROLL_QUIET_MS;
    const userBusy = now - this.userActedAt < USER_BUSY_MS;
    const forced = this.diffVisible && !userBusy && now - this.dirtySince >= this.forcedMs && spaced;
    if (this.capturing || !((quiet && spaced) || forced)) {
      this.schedule();
      return;
    }
    if (!userSinceCapture) this.forcedMs = Math.min(MAX_FORCED_MS, this.forcedMs * 2);
    void this.capture();
  }

  private async offsetsAgree(): Promise<boolean> {
    if (Date.now() - this.lastScrollAt >= UNSYNCED_GRACE_MS) return true;
    try {
      const [before, after] = await Promise.all([this.before.scrollPosition(), this.after.scrollPosition()]);
      return before[0] === after[0] && before[1] === after[1];
    } catch {
      return true;
    }
  }

  private isCurrent(seq: [number, number]): boolean {
    return seq[0] === (this.liveSeq.get(this.before) ?? 0) && seq[1] === (this.liveSeq.get(this.after) ?? 0);
  }

  private capture(): Promise<void> {
    this.inFlight = this.takeCapture().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async takeCapture(): Promise<void> {
    this.capturing = true;
    this.dirtySince = 0;
    if (!(await this.offsetsAgree())) {
      this.capturing = false;
      this.dirtySince ||= Date.now();
      this.schedule();
      return;
    }
    if (this.lastScrollAt > this.lastCaptureStart) {
      await Promise.all([this.before.refreshScrollEffects(), this.after.refreshScrollEffects()]);
    }
    this.lastCaptureStart = Date.now();
    const seq: [number, number] = [this.liveSeq.get(this.before) ?? 0, this.liveSeq.get(this.after) ?? 0];
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
      const current = this.isCurrent(seq);
      if (this.lastPngs?.[0].equals(beforePng) && this.lastPngs[1].equals(afterPng) && this.latest) {
        this.latest = { ...this.latest, ...paths, seq };
        if (current) {
          this.forcedMs = MIN_FORCED_MS;
          this.settle(this.latest.id);
        }
        return;
      }
      this.lastPngs = [beforePng, afterPng];
      const before = decodePng(beforePng);
      const after = decodePng(afterPng);
      const diff = diffImages(before, after);
      const id = ++this.captures;
      this.latest = { id, before, after, diff, ...paths, size: this.size, seq };
      const header = {
        format: 'png',
        exact: true,
        width: this.size.width,
        height: this.size.height,
        capture: id,
      } as const;
      // A page that moved on while it was captured already shows newer live frames; drawing the
      // older capture over them would make the pane jump back and forth.
      this.publish({ ...header, channel: 'before' }, beforePng, current);
      this.publish({ ...header, channel: 'after' }, afterPng, current);
      if (current) this.shownCapture = id;
      const diffHeader: FrameHeader = { ...header, channel: 'diff', changed: diff.changed, total: diff.total, current };
      this.publish(diffHeader, encodePng(diff.image), true);
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

  // The pages stopped moving: show the exact frames of the last capture if they were held back,
  // and clear the stale mark on the diff.
  private settle(id: number): void {
    if (this.shownCapture !== id) {
      this.shownCapture = id;
      for (const channel of ['before', 'after'] as const) {
        const frame = this.exactFrames.get(channel);
        if (frame) this.emit('frame', ...frame);
      }
    }
    this.emit('message', { type: 'settled' });
  }

  private publish(header: FrameHeader, bytes: Buffer, show: boolean): void {
    this.exactFrames.set(header.channel, [header, bytes]);
    if (show) this.emit('frame', header, bytes);
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

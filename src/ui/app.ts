import type {
  Channel,
  ClientMessage,
  FrameHeader,
  MouseButton,
  ServerMessage,
  SideState,
  StateMessage,
  ViewSize,
} from '../protocol.ts';

interface Pane {
  channel: Channel;
  root: HTMLElement;
  view: HTMLElement;
  canvas: HTMLCanvasElement;
  context: CanvasRenderingContext2D;
  message: HTMLElement;
  frame: FrameHeader | undefined;
  scale: number;
  received: number;
  drawn: number;
}

const MODIFIER = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;
const BUTTON: MouseButton[] = ['left', 'middle', 'right'];
const LINE_PX = 40;
const DOUBLE_CLICK_MS = 500;
const FIT_DEBOUNCE_MS = 150;
const ANIMATING_WINDOW_MS = 3500;
const ANIMATING_DIFFS = 4;

const token = new URLSearchParams(location.search).get('t') ?? '';
const element = <T extends HTMLElement>(selector: string, root: ParentNode = document) => {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`Missing ${selector}`);
  return found;
};

const panes = new Map<Channel, Pane>(
  [...document.querySelectorAll<HTMLElement>('.pane')].map(root => {
    const canvas = element<HTMLCanvasElement>('canvas', root);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas 2D is not available');
    const channel = root.dataset.channel as Channel;
    return [
      channel,
      {
        channel,
        root,
        view: element('.view', root),
        canvas,
        context,
        message: element('.message', root),
        frame: undefined,
        scale: 1,
        received: 0,
        drawn: 0,
      },
    ];
  }),
);
const pane = (channel: Channel) => panes.get(channel) as Pane;

const ui = {
  path: element<HTMLInputElement>('#path'),
  size: element<HTMLSelectElement>('#size'),
  dpr: [...document.querySelectorAll<HTMLButtonElement>('[data-dpr]')],
  linked: element<HTMLInputElement>('#linked'),
  motion: element<HTMLInputElement>('#motion'),
  hint: element('#hint'),
  exports: [...document.querySelectorAll<HTMLButtonElement>('[data-layout]')],
  diffDetail: element('.diff .detail'),
  spinner: element('.diff .spinner'),
  overlay: element('#overlay'),
  toast: element('#toast'),
};

let state: StateMessage | undefined;
let socket: WebSocket | undefined;
let firstState = true;
const diffTimes: number[] = [];

if (!token) {
  showOverlay('Open the address ccvd printed', 'It includes an access token, for example http://127.0.0.1:2283/?t=…');
} else {
  connect();
  wireToolbar();
  for (const item of panes.values()) wirePane(item);
  new ResizeObserver(() => {
    for (const item of panes.values()) layout(item);
    scheduleFit();
  }).observe(pane('before').view);
}

function connect(): void {
  socket = new WebSocket(`ws://${location.host}/ws?t=${encodeURIComponent(token)}`);
  socket.binaryType = 'arraybuffer';
  socket.addEventListener('message', event => {
    if (typeof event.data === 'string') onMessage(JSON.parse(event.data) as ServerMessage);
    else void onFrame(event.data as ArrayBuffer);
  });
  socket.addEventListener('close', () =>
    showOverlay('ccvd stopped', 'Start ccvd again, then open the address it prints.'),
  );
}

function send(message: ClientMessage): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

function onMessage(message: ServerMessage): void {
  if (message.type === 'error') {
    showToast(message.message);
    return;
  }
  state = message;
  renderState(message);
  if (firstState) {
    firstState = false;
    if (message.fit) sendFit(window.devicePixelRatio >= 1.5 ? 2 : 1);
  }
}

async function onFrame(buffer: ArrayBuffer): Promise<void> {
  const length = new DataView(buffer).getUint32(0);
  const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length))) as FrameHeader;
  const target = pane(header.channel);
  const sequence = ++target.received;
  const bitmap = await createImageBitmap(
    new Blob([new Uint8Array(buffer, 4 + length)], { type: `image/${header.format}` }),
  );
  if (sequence < target.drawn) {
    bitmap.close();
    return;
  }
  target.drawn = sequence;
  if (target.canvas.width !== bitmap.width || target.canvas.height !== bitmap.height) {
    target.canvas.width = bitmap.width;
    target.canvas.height = bitmap.height;
  }
  target.context.drawImage(bitmap, 0, 0);
  bitmap.close();
  target.frame = header;
  layout(target);

  if (header.channel === 'diff') onDiff(header);
  else if (!header.exact) setStale(true);
}

function onDiff(header: FrameHeader): void {
  setStale(false);
  const changed = header.changed ?? 0;
  const total = header.total ?? 1;
  ui.diffDetail.textContent =
    changed === 0 ? 'No changed pixels' : `${changed.toLocaleString()} px changed (${percent(changed, total)})`;
  ui.diffDetail.className = `detail ${changed === 0 ? 'unchanged' : 'changed'}`;
  for (const button of ui.exports) button.disabled = false;

  const now = performance.now();
  diffTimes.push(now);
  while (diffTimes.length > 0 && now - diffTimes[0] > ANIMATING_WINDOW_MS) diffTimes.shift();
  ui.hint.hidden = !!state?.reducedMotion || diffTimes.length < ANIMATING_DIFFS;
}

function setStale(stale: boolean): void {
  pane('diff').root.classList.toggle('stale', stale);
  ui.spinner.hidden = !stale;
}

function percent(changed: number, total: number): string {
  const share = (changed / total) * 100;
  if (share < 0.01) return '<0.01%';
  return `${share.toFixed(share < 1 ? 2 : 1)}%`;
}

function layout(target: Pane): void {
  const frame = target.frame;
  if (!frame) return;
  const scale = Math.min(1, target.view.clientWidth / frame.width, target.view.clientHeight / frame.height);
  target.scale = scale > 0 ? scale : 1;
  target.canvas.style.width = `${frame.width * target.scale}px`;
  target.canvas.style.height = `${frame.height * target.scale}px`;
}

function renderState(message: StateMessage): void {
  if (document.activeElement !== ui.path) ui.path.value = message.before.path;
  document.title = `${message.before.path || '/'} · ccvd`;
  renderSide('before', message.before);
  renderSide('after', message.after);
  renderSizes(message);
  for (const button of ui.dpr)
    button.setAttribute('aria-pressed', String(Number(button.dataset.dpr) === message.size.dpr));
  ui.linked.checked = message.linked;
  ui.motion.checked = message.reducedMotion;
  if (message.reducedMotion) ui.hint.hidden = true;
}

function renderSide(channel: 'before' | 'after', side: SideState): void {
  const root = pane(channel).root;
  element('.host', root).textContent = new URL(side.base).host;
  element('.host', root).title = side.url;
  const status = element('.status', root);
  status.textContent = side.loading ? 'Loading' : side.status ? String(side.status) : '';
  status.className = `status ${side.loading ? 'loading' : side.status && side.status < 400 ? 'ok' : 'bad'}`;
  const message = pane(channel).message;
  message.textContent = side.error ?? '';
  message.hidden = !side.error;
}

function renderSizes(message: StateMessage): void {
  const { width, height } = message.size;
  const preset = message.presets.find(item => item.width === width && item.height === height);
  const value = message.fit ? 'fit' : (preset?.id ?? 'custom');
  const options = [
    ['fit', 'Fit to pane'],
    ...message.presets.map(item => [item.id, `${item.label} ${item.width}×${item.height}`]),
    ...(value === 'custom' ? [['custom', `Custom ${width}×${height}`]] : []),
  ];
  const signature = options.map(([id, label]) => `${id}:${label}`).join('|');
  if (ui.size.dataset.signature !== signature) {
    ui.size.replaceChildren(...options.map(([id, label]) => new Option(label, id)));
    ui.size.dataset.signature = signature;
  }
  ui.size.value = value;
}

function wireToolbar(): void {
  element('#back').addEventListener('click', () => send({ type: 'navigate', action: 'back' }));
  element('#forward').addEventListener('click', () => send({ type: 'navigate', action: 'forward' }));
  element('#reload').addEventListener('click', () => send({ type: 'navigate', action: 'reload' }));
  element<HTMLFormElement>('#go').addEventListener('submit', event => {
    event.preventDefault();
    send({ type: 'navigate', action: 'goto', path: ui.path.value.trim() });
    ui.path.blur();
  });
  ui.size.addEventListener('change', () => {
    const dpr = state?.size.dpr ?? 1;
    if (ui.size.value === 'fit') return sendFit(dpr);
    const preset = state?.presets.find(item => item.id === ui.size.value);
    if (preset) send({ type: 'size', width: preset.width, height: preset.height, dpr, fit: false });
  });
  for (const button of ui.dpr) {
    button.addEventListener('click', () => {
      if (!state) return;
      const dpr = Number(button.dataset.dpr) as ViewSize['dpr'];
      if (state.fit) sendFit(dpr);
      else send({ type: 'size', width: state.size.width, height: state.size.height, dpr, fit: false });
    });
  }
  ui.linked.addEventListener('change', () => send({ type: 'linked', value: ui.linked.checked }));
  ui.motion.addEventListener('change', () => send({ type: 'reducedMotion', value: ui.motion.checked }));
  for (const button of ui.exports) {
    button.addEventListener('click', () =>
      exportImage(button.dataset.layout ?? 'triple', button.dataset.mode === 'download'),
    );
  }
}

function exportImage(layout: string, download: boolean): void {
  const url = `/export.png?layout=${layout}&t=${encodeURIComponent(token)}${download ? '&download=1' : ''}`;
  if (!download) {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const link = document.createElement('a');
  link.href = url;
  link.download = '';
  link.click();
}

let fitTimer: number | undefined;

function scheduleFit(): void {
  if (!state?.fit) return;
  clearTimeout(fitTimer);
  fitTimer = window.setTimeout(() => sendFit(state?.size.dpr ?? 1), FIT_DEBOUNCE_MS);
}

function sendFit(dpr: ViewSize['dpr']): void {
  const view = pane('before').view;
  const width = Math.floor(view.clientWidth);
  const height = Math.floor(view.clientHeight);
  if (width > 0 && height > 0) send({ type: 'size', width, height, dpr, fit: true });
}

function wirePane(target: Pane): void {
  const { canvas, view, channel } = target;
  let lastDown = { time: 0, x: 0, y: 0, count: 0 };
  let pendingMove: PointerEvent | undefined;
  let wheel = { x: 0, y: 0, deltaX: 0, deltaY: 0, modifiers: 0 };
  let wheelPending = false;
  const pressedKeys = new Map<string, string>();

  const point = (event: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: (event.clientX - rect.left) / target.scale, y: (event.clientY - rect.top) / target.scale };
  };
  const mouse = (action: 'move' | 'down' | 'up', event: PointerEvent, clickCount: number) => {
    const { x, y } = point(event);
    const button = action === 'move' ? 'none' : (BUTTON[event.button] ?? 'left');
    send({
      type: 'mouse',
      side: channel,
      action,
      x,
      y,
      button,
      buttons: event.buttons,
      clickCount,
      modifiers: modifiers(event),
    });
  };

  canvas.addEventListener('pointerdown', event => {
    event.preventDefault();
    view.focus({ preventScroll: true });
    canvas.setPointerCapture(event.pointerId);
    const { x, y } = point(event);
    const repeat = event.timeStamp - lastDown.time < DOUBLE_CLICK_MS && Math.hypot(x - lastDown.x, y - lastDown.y) < 5;
    lastDown = { time: event.timeStamp, x, y, count: repeat ? lastDown.count + 1 : 1 };
    mouse('down', event, lastDown.count);
  });
  canvas.addEventListener('pointerup', event => mouse('up', event, lastDown.count));
  canvas.addEventListener('pointermove', event => {
    const flush = !pendingMove;
    pendingMove = event;
    if (flush) {
      requestAnimationFrame(() => {
        if (pendingMove) mouse('move', pendingMove, 0);
        pendingMove = undefined;
      });
    }
  });
  canvas.addEventListener('contextmenu', event => event.preventDefault());
  canvas.addEventListener(
    'wheel',
    event => {
      if (event.ctrlKey) return;
      event.preventDefault();
      const unit = event.deltaMode === 1 ? LINE_PX : event.deltaMode === 2 ? (target.frame?.height ?? 800) : 1;
      const { x, y } = point(event);
      wheel = {
        x,
        y,
        deltaX: wheel.deltaX + (event.deltaX * unit) / target.scale,
        deltaY: wheel.deltaY + (event.deltaY * unit) / target.scale,
        modifiers: modifiers(event),
      };
      if (wheelPending) return;
      wheelPending = true;
      requestAnimationFrame(() => {
        send({ type: 'wheel', side: channel, ...wheel });
        wheel = { x: 0, y: 0, deltaX: 0, deltaY: 0, modifiers: 0 };
        wheelPending = false;
      });
    },
    { passive: false },
  );

  view.addEventListener('keydown', event => {
    if (event.isComposing) return;
    event.preventDefault();
    pressedKeys.set(event.code || event.key, event.key);
    send({ type: 'key', side: channel, action: 'down', key: event.key, code: event.code, modifiers: modifiers(event) });
  });
  view.addEventListener('keyup', event => {
    if (event.isComposing) return;
    event.preventDefault();
    const id = event.code || event.key;
    const key = pressedKeys.get(id) ?? event.key;
    pressedKeys.delete(id);
    send({ type: 'key', side: channel, action: 'up', key, code: event.code, modifiers: modifiers(event) });
  });
  view.addEventListener('blur', () => {
    for (const [code, key] of pressedKeys) send({ type: 'key', side: channel, action: 'up', key, code, modifiers: 0 });
    pressedKeys.clear();
  });
}

function modifiers(event: MouseEvent | KeyboardEvent): number {
  return (
    (event.altKey ? MODIFIER.alt : 0) |
    (event.ctrlKey ? MODIFIER.ctrl : 0) |
    (event.metaKey ? MODIFIER.meta : 0) |
    (event.shiftKey ? MODIFIER.shift : 0)
  );
}

function showOverlay(title: string, text: string): void {
  element('h2', ui.overlay).textContent = title;
  element('p', ui.overlay).textContent = text;
  ui.overlay.hidden = false;
}

let toastTimer: number | undefined;

function showToast(text: string): void {
  ui.toast.textContent = text;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    ui.toast.hidden = true;
  }, 5000);
}

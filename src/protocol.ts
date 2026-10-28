// Messages between the ccvd server and its browser UI. Types only, shared by both builds.

export type SideName = 'before' | 'after';
export type Channel = SideName | 'diff';
export type MouseButton = 'none' | 'left' | 'middle' | 'right';

export interface ViewSize {
  width: number;
  height: number;
  dpr: 1 | 2;
}

export interface MouseInput {
  type: 'mouse';
  side: Channel;
  action: 'move' | 'down' | 'up';
  x: number;
  y: number;
  button: MouseButton;
  buttons: number;
  clickCount: number;
  modifiers: number;
}

export interface WheelInput {
  type: 'wheel';
  side: Channel;
  x: number;
  y: number;
  deltaX: number;
  deltaY: number;
  modifiers: number;
}

export interface KeyInput {
  type: 'key';
  side: Channel;
  action: 'down' | 'up';
  key: string;
  code: string;
  modifiers: number;
}

export type NavigateRequest =
  | { type: 'navigate'; action: 'goto'; path: string }
  | { type: 'navigate'; action: 'back' | 'forward' | 'reload' };

export interface SizeRequest extends ViewSize {
  type: 'size';
  fit: boolean;
}

export interface ToggleRequest {
  type: 'linked' | 'reducedMotion';
  value: boolean;
}

export type ClientMessage = MouseInput | WheelInput | KeyInput | NavigateRequest | SizeRequest | ToggleRequest;

export interface SideState {
  base: string;
  url: string;
  path: string;
  title: string;
  loading: boolean;
  status?: number;
  error?: string;
}

export interface Preset {
  id: string;
  label: string;
  width: number;
  height: number;
}

export interface StateMessage {
  type: 'state';
  version: string;
  before: SideState;
  after: SideState;
  size: ViewSize;
  fit: boolean;
  linked: boolean;
  reducedMotion: boolean;
  presets: readonly Preset[];
}

// settled: a new capture matched the last one, so the diff on screen is current again.
export type ServerMessage = StateMessage | { type: 'error'; message: string } | { type: 'settled' };

// Binary WebSocket messages carry an image: a 4-byte big-endian header length, this header as
// JSON, then the JPEG or PNG bytes.
export interface FrameHeader {
  channel: Channel;
  format: 'jpeg' | 'png';
  exact: boolean;
  width: number;
  height: number;
  capture?: number;
  changed?: number;
  total?: number;
}

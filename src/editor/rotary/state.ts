import { signal } from '@preact/signals';
import type { RotaryMaze } from '@core/rotary/model';
import { parseRotaryMaze } from '@core/rotary/model';
import { THREE_PATH_JSON } from '@core/rotary/sampleThreePath';
import { HARD_JSON } from '@core/rotary/sampleHard';
import { ANGULAR_JSON } from '@core/rotary/sampleAngular';

/** Mazes bundled with the app. */
export const BUNDLED: readonly { readonly label: string; readonly json: string }[] = [
  { label: 'Angular rings (v4): one very hard maze', json: ANGULAR_JSON },
  { label: 'Hard (v3): traps, 9 dial positions', json: HARD_JSON },
  { label: 'Three paths (v2)', json: THREE_PATH_JSON },
];

export interface RotaryStatus {
  readonly position: number;
  readonly turning: boolean;
  readonly clicks: number;
  readonly wasted: number;
  readonly elapsed: number;
  readonly phase: 'playing' | 'goal' | 'home' | 'trapped';
  /** Times the ball has dropped into a trap since the last reset. */
  readonly traps: number;
  readonly jammed: boolean;
  /** Demo playback only. */
  readonly demoText: string;
  readonly wrong: boolean;
}

export interface RotarySettings {
  readonly maxTiltDeg: number;
  readonly speed: number;
  /** Tilt the drawn board with the input (purely visual). */
  readonly showTilt: boolean;
}

export const rotaryMaze = signal<RotaryMaze>(parseRotaryMaze(ANGULAR_JSON));
export const rotaryStatus = signal<RotaryStatus | null>(null);
export const rotarySettings = signal<RotarySettings>({ maxTiltDeg: 10, speed: 1, showTilt: true });
/** Index into maze.demos while a demo is playing, else -1. */
export const demoIndex = signal(-1);
export const rotaryError = signal('');

/** One-shot commands for the viewer (it owns the simulation). */
export type RotaryCommand =
  | { readonly kind: 'turn'; readonly delta: number }
  | { readonly kind: 'reset'; readonly dial?: number }
  | { readonly kind: 'top' };
export const rotaryCommand = signal<{ readonly id: number; readonly cmd: RotaryCommand } | null>(null);
let cmdId = 0;
export function send(cmd: RotaryCommand): void { rotaryCommand.value = { id: ++cmdId, cmd }; }

export function loadRotaryJson(text: string): void {
  try {
    rotaryMaze.value = parseRotaryMaze(text);
    demoIndex.value = -1;
    rotaryError.value = '';
  } catch (e) {
    rotaryError.value = e instanceof Error ? e.message : String(e);
  }
}

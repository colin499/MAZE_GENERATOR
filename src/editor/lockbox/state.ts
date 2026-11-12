import { signal } from '@preact/signals';
import type { LockBox } from '@core/lockbox/model';
import { parseLockBox } from '@core/lockbox/model';
import type { BallPhase } from '@core/lockbox/sim';
import type { LockBoxDemoKind } from '@core/lockbox/autopilot';
import { LOCKBOX_V1_JSON } from '@core/lockbox/sampleV1';

export interface LockBoxStatus {
  readonly phase: BallPhase;
  readonly capA: number;
  readonly ringA: number;
  readonly locked: boolean;
  readonly lidZ: number;
  readonly open: boolean;
  readonly atStop: boolean;
  /** A lift was refused in the last moment. */
  readonly refused: boolean;
  readonly elapsed: number;
  /** Demo playback only. */
  readonly demoText: string;
}

export interface LockBoxSettings {
  readonly maxTiltDeg: number;
  readonly speed: number;
  /** Tilt the drawn box with the input (purely visual). */
  readonly showTilt: boolean;
  readonly seeThroughBody: boolean;
  readonly seeThroughCap: boolean;
}

export const lockBox = signal<LockBox>(parseLockBox(LOCKBOX_V1_JSON));
export const lockBoxStatus = signal<LockBoxStatus | null>(null);
export const lockBoxSettings = signal<LockBoxSettings>({ maxTiltDeg: 10, speed: 1, showTilt: true, seeThroughBody: true, seeThroughCap: false });
/** Demo that is playing, or null for live play. */
export const lockBoxDemo = signal<LockBoxDemoKind | null>(null);
export const lockBoxError = signal('');

/** One-shot commands for the viewer (it owns the simulation). */
export type LockBoxCommand =
  | { readonly kind: 'resetBall' }
  | { readonly kind: 'resetAll' }
  | { readonly kind: 'lift' }
  | { readonly kind: 'view'; readonly view: 'top' | 'side' };
export const lockBoxCommand = signal<{ readonly id: number; readonly cmd: LockBoxCommand } | null>(null);
let cmdId = 0;
export function send(cmd: LockBoxCommand): void { lockBoxCommand.value = { id: ++cmdId, cmd }; }

/** Cap turn input from held header buttons (-1, 0, 1); keys are handled in the viewport. */
export const buttonTurn = signal(0);

export function loadLockBoxJson(text: string): void {
  try {
    lockBox.value = parseLockBox(text);
    lockBoxDemo.value = null;
    lockBoxError.value = '';
  } catch (e) {
    lockBoxError.value = e instanceof Error ? e.message : String(e);
  }
}

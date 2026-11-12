import { describe, expect, it } from 'vitest';
import { clutchBacklash, parseLockBox } from '@core/lockbox/model';
import { LockBoxSim } from '@core/lockbox/sim';
import { LockBoxAutopilot } from '@core/lockbox/autopilot';
import { LOCKBOX_V1_JSON } from '@core/lockbox/sampleV1';

describe('maze lock box v1', () => {
  const box = parseLockBox(LOCKBOX_V1_JSON);
  const run = (sim: LockBoxSim, seconds: number, each?: () => void): string[] => {
    const events: string[] = [];
    for (let i = 0; i < seconds * 120; i++) { each?.(); for (const e of sim.step(1 / 120)) events.push(e); }
    return events;
  };

  it('rejects other files', () => {
    expect(() => parseLockBox('{"format":"rotary-maze/1"}')).toThrow(/lock box/);
  });

  it('the autopilot solves the maze, engages the clutch, unlocks and lifts the lid', () => {
    const sim = new LockBoxSim(box);
    const pilot = new LockBoxAutopilot(sim, 'solve');
    const events: string[] = [];
    let worst = -Infinity;
    for (let i = 0; i < 120 * 120 && !pilot.done; i++) {
      pilot.update(1 / 120);
      for (const e of sim.step(1 / 120)) events.push(e);
      if (sim.state.phase === 'maze') worst = Math.max(worst, sim.penetration());
    }
    expect(pilot.done).toBe(true);
    expect(events.filter((e) => e !== 'stop')).toEqual(['goal', 'click', 'open']);
    expect(events).toContain('stop');
    expect(worst).toBeLessThan(0.05);                       // the ball never went through a wall
    expect(sim.state.ringA).toBeCloseTo(box.openTurn, 6);
    expect(sim.locked).toBe(false);
    expect(sim.state.open).toBe(true);
    expect(sim.state.elapsed).toBeLessThan(60);
  });

  it('without the ball in the goal the cap spins, the ring stays and the lid is locked', () => {
    const sim = new LockBoxSim(box);
    sim.turn = 1;
    run(sim, 10);
    expect(Math.abs(sim.state.capA)).toBeGreaterThan(360);
    expect(sim.state.ringA).toBe(0);
    sim.turn = 0;
    sim.lift(true);
    const events = run(sim, 2);
    expect(events).toEqual(['locked']);
    expect(sim.state.open).toBe(false);
    expect(sim.state.lidZ).toBe(0);                          // it dropped back after the rattle
    const pilot = new LockBoxAutopilot(sim, 'cheat');
    const ev2: string[] = [];
    for (let i = 0; i < 60 * 120 && !pilot.done; i++) { pilot.update(1 / 120); for (const e of sim.step(1 / 120)) ev2.push(e); }
    expect(pilot.done).toBe(true);
    expect(ev2).toEqual(['locked']);
  });

  it('a ball riding on the ring between pockets does not drive it; in a pocket it does, with backlash, between the stops', () => {
    const sim = new LockBoxSim(box);
    const s = sim.state;
    // put the ball in the goal hole with the hole midway between two pockets
    const goalA = Math.atan2(box.goal[1], box.goal[0]) * 180 / Math.PI;
    s.capA = box.pocketA0 + 180 / box.pockets - goalA;
    s.x = box.goal[0]; s.y = box.goal[1];
    expect(run(sim, 0.5)).toEqual(['goal']);
    expect(s.phase).toBe('riding');
    sim.turn = -1;                                           // clockwise: finds a pocket, then pushes the ring into the locked stop
    const ev = run(sim, 3);
    expect(ev).toEqual(['click', 'stop']);
    expect(s.ringA).toBe(0);
    const capAtLockStop = s.capA;
    sim.turn = 1;
    run(sim, 0.05);
    expect(s.ringA).toBe(0);                                 // still inside the backlash
    const ev2 = run(sim, 3);
    expect(ev2).toEqual(['stop']);
    expect(s.ringA).toBeCloseTo(box.openTurn, 6);
    expect(s.capA - capAtLockStop).toBeCloseTo(box.openTurn + 2 * clutchBacklash(box), 4);
    // half way back the bayonet holds again
    sim.turn = -1;
    run(sim, 0.4);
    sim.turn = 0;
    expect(s.ringA).toBeGreaterThan(0);
    expect(s.ringA).toBeLessThan(box.clearAt);
    sim.lift(true);
    expect(run(sim, 1)).toEqual(['locked']);
    // picking the ball out leaves the ring where it is
    sim.resetBall();
    const ringA = s.ringA;
    sim.turn = 1;
    run(sim, 2);
    expect(s.ringA).toBe(ringA);
  });

  it('an open lid goes back on and relocks with the ball still in the clutch', () => {
    const sim = new LockBoxSim(box);
    const pilot = new LockBoxAutopilot(sim, 'solve');
    for (let i = 0; i < 120 * 120 && !pilot.done; i++) { pilot.update(1 / 120); sim.step(1 / 120); }
    const capUp = sim.state.capA;
    sim.turn = -1;
    run(sim, 0.5);
    expect(sim.state.capA).toBe(capUp);                      // no turning against the bayonet while the lid is off
    sim.lift(false);
    expect(run(sim, 2)).toContain('close');
    run(sim, 3);
    expect(sim.state.ringA).toBe(0);
    expect(sim.locked).toBe(true);
  });
});

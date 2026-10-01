import { describe, expect, it } from 'vitest';
import { type FlagCar, type FlagState, flagState, lineFlag, postSignals } from '../src/core/flags.ts';
import type { YellowZone } from '../src/core/race/sim.ts';
import { car, start } from './raceFixture.ts';

// A 5 km lap of 1000 stations, with a post every 500 m.
const N = 1000;
const posts = Array.from({ length: 10 }, (_, i) => ({ station: i * 100 }));

function state(changes: Partial<FlagState> = {}): FlagState {
  return {
    t: 600, n: N, ds: 5, phase: 'green', safetyCar: null, yellows: [], neutral: [], lapTime: 90, chequered: false, rollingStart: false, cars: [],
    ...changes,
  };
}

/** A yellow zone from 300 m before the incident at station `at` to 60 m after it. */
function yellow(at: number, double = false): YellowZone {
  return { from: (at - 60 + N) % N, to: (at + 12) % N, at, double, until: 1e9 };
}

const flagsAt = (s: FlagState) => postSignals(s, posts).map((p) => p.flags.join('+') || '-');

describe('flags', () => {
  it('shows nothing while racing on a clear track', () => {
    expect(flagsAt(state())).toEqual(Array(10).fill('-'));
    expect(lineFlag(state())).toBeNull();
  });

  it('waves yellow before an incident and through its zone, two where the track is blocked, and green at the post after', () => {
    const one = flagsAt(state({ yellows: [yellow(330)] }));
    expect(one[3]).toBe('yellow');
    expect(one[4]).toBe('green');
    expect(one.filter((f) => f !== '-')).toHaveLength(2);
    expect(flagsAt(state({ yellows: [yellow(330, true)] }))[3]).toBe('yellow+yellow');
    // No post inside the zone: the one before the incident still shows it.
    const gap = flagsAt(state({ yellows: [{ from: 410, to: 482, at: 470, double: false, until: 1e9 }] }));
    expect(gap[4]).toBe('yellow');
    expect(gap[5]).toBe('green');
  });

  it('puts out waved yellows and the SC board at every post under the safety car, and green flags once it is in', () => {
    for (const sc of [{ in: false }, { in: true }]) {
      for (const p of postSignals(state({ phase: 'sc', safetyCar: sc }), posts)) {
        expect(p.flags).toEqual(['yellow']);
        expect(p.board).toBe('SC');
      }
    }
    const released = state({ phase: 'sc', safetyCar: null });
    for (const p of postSignals(released, posts)) expect(p).toEqual({ flags: ['green'], board: null });
    expect(lineFlag(released)).toBe('green');
  });

  it('shows a single yellow and the VSC or FCY board everywhere, keeping the double yellow before the incident', () => {
    const vsc = postSignals(state({ phase: 'vsc', yellows: [yellow(330, true)] }), posts);
    expect(vsc[3]).toEqual({ flags: ['yellow', 'yellow'], board: 'VSC' });
    expect(vsc[7]).toEqual({ flags: ['yellow'], board: 'VSC' });
    // No green flag after the incident while the whole track is neutralised.
    expect(vsc[4].flags).toEqual(['yellow']);
    expect(postSignals(state({ phase: 'fcy' }), posts)[0].board).toBe('FCY');
  });

  it('keeps green flags out for a lap after a neutralisation ends', () => {
    const neutral = [{ kind: 'vsc' as const, from: 100, to: 200, reason: '' }];
    expect(flagsAt(state({ neutral, t: 250 }))).toEqual(Array(10).fill('green'));
    expect(flagsAt(state({ neutral, t: 300 }))).toEqual(Array(10).fill('-'));
    // A yellow still out wins over the green.
    expect(flagsAt(state({ neutral, t: 250, yellows: [yellow(330)] }))[3]).toBe('yellow');
  });

  it('shows the blue flag at the post ahead of a car about to be lapped, or caught by a faster class', () => {
    const at = (u: number, classIndex = 0, pace = 90): FlagCar => ({ u, running: true, pace, classIndex });
    // A lap up and 50 m behind on track: blue at the next post.
    expect(flagsAt(state({ cars: [at(3150), at(4140)] }))[2]).toBe('blue');
    // 200 m back is not close enough, and a car on the same lap is a fight, not a blue flag.
    expect(flagsAt(state({ cars: [at(3150), at(4110)] })).every((f) => f === '-')).toBe(true);
    expect(flagsAt(state({ cars: [at(3150), at(3140)] })).every((f) => f === '-')).toBe(true);
    // A faster class closing in on the same lap.
    expect(flagsAt(state({ cars: [at(3150, 1, 100), at(3140, 0, 90)] }))[2]).toBe('blue');
    // Not where a yellow is out, and not under a safety car.
    expect(flagsAt(state({ cars: [at(3150), at(4140)], yellows: [yellow(230)] }))[2]).toBe('yellow');
    expect(postSignals(state({ cars: [at(3150), at(4140)], phase: 'sc', safetyCar: { in: false } }), posts)[2].flags).toEqual(['yellow']);
  });

  it('waves the chequered flag at the line once the winner has finished, and green for a rolling start', () => {
    expect(lineFlag(state({ chequered: true }))).toBe('chequered');
    expect(lineFlag(state({ rollingStart: true, t: 3 }))).toBe('green');
    expect(lineFlag(state({ rollingStart: true, t: 30 }))).toBeNull();
    expect(lineFlag(state({ rollingStart: false, t: 3 }))).toBeNull();
  });

  it('reads the race', () => {
    const sim = start(car('f1'), { cars: 6 });
    for (let i = 0; i < 50; i++) sim.step();
    const s = flagState(sim);
    expect(s.n).toBe(sim.model.n);
    expect(s.phase).toBe('green');
    expect(s.cars).toHaveLength(6);
    expect(s.cars.every((c) => c.running && c.u > -sim.model.n)).toBe(true);
    expect(postSignals(s, posts)).toHaveLength(posts.length);
  });
});

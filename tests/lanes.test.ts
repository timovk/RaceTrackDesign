import { describe, expect, it } from 'vitest';
import { BODIES, buildCar } from '../src/core/carBodies.ts';
import { LEFT, RIGHT, SIDE_GAP, bodySize, laneLines } from '../src/core/race/lanes.ts';
import { DT, type RaceCar, type RaceSim, mod } from '../src/core/race/sim.ts';
import { LINE_MARGIN } from '../src/core/racingLine.ts';
import { VEHICLES } from '../src/core/vehicles.ts';
import { circuitRace, trialRace } from '../scripts/raceTrial.ts';
import { calm, car, model, multiClass, start, track } from './raceFixture.ts';

/** Calm rules without pit stops, so a short race is about the cars on the road alone. */
function noStops(id: string) {
  const base = calm(car(id));
  return { ...base, pit: { ...base.pit, stops: false, minStops: 0 } };
}

/** How far `a` is ahead of `b` along the lap, metres (negative: behind). */
function apart(sim: RaceSim, a: RaceCar, b: RaceCar): number {
  const n = sim.model.n;
  const d = mod(a.u - b.u, n);
  return (d > n / 2 ? d - n : d) * sim.model.track.ds;
}

/** Whether two cars' bodies overlap by more than a touch, both on the road. */
function overlapping(sim: RaceSim, a: RaceCar, b: RaceCar): boolean {
  if (a.offTrack || b.offTrack || a.exitUntilU > a.u || b.exitUntilU > b.u) return false;
  return Math.abs(apart(sim, a, b)) < (a.cls.length + b.cls.length) / 2 - 0.5 && Math.abs(a.lateral - b.lateral) < a.cls.half + b.cls.half - 0.3;
}

/** Runs a race and adds up what the cars did across the road. */
function watch(sim: RaceSim, each?: (cars: RaceCar[]) => void) {
  const { line, track: road } = sim.model;
  let overlap = 0;
  let sideBySide = 0;
  let offRoad = 0;
  while (!sim.finished) {
    sim.step();
    const cars = sim.cars.filter((c) => c.status === 'running');
    for (const c of cars) {
      const k = mod(Math.floor(c.u), sim.model.n);
      offRoad = Math.max(offRoad, Math.abs(c.lateral + line.offset[k]) - (road.width[k] / 2 - c.cls.half));
    }
    for (let i = 0; i < cars.length; i++) {
      for (let j = i + 1; j < cars.length; j++) {
        const a = cars[i];
        const b = cars[j];
        if (overlapping(sim, a, b)) overlap += DT;
        if (Math.abs(apart(sim, a, b)) < (a.cls.length + b.cls.length) / 2 && Math.abs(a.lateral - b.lateral) >= a.cls.half + b.cls.half + 0.4) sideBySide += DT;
      }
    }
    each?.(cars);
  }
  return { overlap, sideBySide, offRoad };
}

describe('lanes', () => {
  it('gives every car class the size of the car that is drawn', () => {
    for (const v of VEHICLES) {
      if (v.kind !== 'car' || !(BODIES as readonly string[]).includes(v.id)) continue;
      const drawn = buildCar(v.id);
      const size = bodySize(v);
      expect(Math.abs(size.length - drawn.length), v.id).toBeLessThan(0.06);
      expect(Math.abs(size.width - drawn.width), v.id).toBeLessThan(0.06);
    }
  });

  it('keeps each lane line in its own half of the track', () => {
    const [left, right] = laneLines(track);
    for (let k = 0; k < track.n; k++) {
      const edge = track.width[k] / 2 - LINE_MARGIN;
      expect(left.offset[k]).toBeGreaterThanOrEqual(1 + SIDE_GAP / 2 - 1e-6);
      expect(left.offset[k]).toBeLessThanOrEqual(edge + 1e-6);
      expect(right.offset[k]).toBeLessThanOrEqual(-1 - SIDE_GAP / 2 + 1e-6);
      expect(right.offset[k]).toBeGreaterThanOrEqual(-edge - 1e-6);
    }
  });

  it('makes a lane cost time through the corners and none on the straights', () => {
    const m = model(car('f1'));
    for (const lane of [LEFT, RIGHT]) {
      let least = 1;
      let free = 0;
      for (let k = 0; k < m.n; k++) {
        expect(m.laneCap[lane][k]).toBeLessThanOrEqual(1);
        expect(m.laneCap[lane][k]).toBeGreaterThan(0.3);
        least = Math.min(least, m.laneCap[lane][k]);
        if (m.laneCap[lane][k] === 1) free++;
      }
      expect(least).toBeLessThan(0.95);
      // The four straights are most of the lap.
      expect(free / m.n).toBeGreaterThan(0.6);
    }
  });

  it('charges a lane one figure for each corner', () => {
    const m = model(car('f1'));
    for (const lane of [LEFT, RIGHT]) {
      // Each stretch a corner holds the lane has one value from end to end, and there are only so many corners.
      const values = new Set<number>();
      let changes = 0;
      for (let k = 0; k < m.n; k++) {
        const here = m.laneCap[lane][k];
        const next = m.laneCap[lane][(k + 1) % m.n];
        if (here < 1) values.add(here);
        if (here !== next) {
          changes++;
          expect(here === 1 || next === 1).toBe(true);
        }
      }
      expect(values.size).toBeGreaterThan(0);
      expect(values.size).toBeLessThanOrEqual(8);
      expect(changes).toBe(2 * values.size);
    }
  });

  it('knows for every braking zone how much speed it takes and which side is the inside', () => {
    const m = model(car('gt3'));
    expect(m.zones.length).toBeGreaterThanOrEqual(4);
    for (const z of m.zones) {
      expect(mod(z.apex - z.station, m.n)).toBeGreaterThan(0);
      expect(mod(z.apex - z.station, m.n) * m.track.ds).toBeLessThan(600);
      expect(z.drop).toBeGreaterThan(0.1);
      expect(z.drop).toBeLessThan(1);
      // Positive curvature is a right-hander: its inside is the right.
      expect(z.inside).toBe(m.line.curvature[z.apex] > 0 ? -1 : 1);
    }
  });

  it('races cars in lanes and bikes in one line', () => {
    expect(start(car('gt3'), { cars: 4 }).lanes).toBe(true);
    expect(start(car('motogp'), { cars: 4 }).lanes).toBe(false);
  });

  it('keeps a car alone on the racing line, once it has left its place on the grid', () => {
    const sim = start(car('gt4'), { kind: 'laps', laps: 4, cars: 1 }, noStops('gt4'));
    const only = sim.cars[0];
    let off = 0;
    while (!sim.finished) {
      sim.step();
      if (only.lapsDone >= 1 && only.status === 'running') off = Math.max(off, Math.abs(only.lateral));
    }
    expect(only.lapsDone).toBe(4);
    expect(off).toBeLessThan(1e-9);
  });

  it('runs cars side by side without their bodies overlapping, all on the road', () => {
    for (const seed of ['11', '5']) {
      const sim = start(car('f1'), { kind: 'laps', laps: 12, cars: 14, seed }, calm(car('f1')));
      const seen = watch(sim);
      expect(sim.lanes).toBe(true);
      // Plenty of running side by side, and next to none of it through each other (contact comes later).
      expect(seen.sideBySide).toBeGreaterThan(60);
      expect(seen.overlap).toBeLessThan(2);
      expect(seen.offRoad).toBeLessThan(0.05);
    }
  });

  it('lets a quicker car pass a slower one on the road, beside it on the way', () => {
    for (const id of ['gt3', 'f1']) {
      const sim = start(car(id), { kind: 'laps', laps: 8, cars: 2 }, noStops(id));
      const [front, back] = sim.order;
      // Three per cent is a couple of seconds a lap: it counts from the second lap.
      front.entrant.carPace += 0.03;
      let beside = 0;
      const seen = watch(sim, () => {
        if (Math.abs(apart(sim, front, back)) < (front.cls.length + back.cls.length) / 2 && Math.abs(front.lateral - back.lateral) >= front.cls.half + back.cls.half + 0.4) beside += DT;
      });
      const passes = sim.events.filter((e) => e.kind === 'overtake');
      expect(passes, id).toHaveLength(1);
      expect(passes[0].car).toBe(back.id);
      expect(passes[0].other).toBe(front.id);
      expect(sim.order[0]).toBe(back);
      expect(beside, id).toBeGreaterThan(0.5);
      expect(seen.overlap, id).toBeLessThan(0.5);
    }
  });

  it('moves a car over for one of its own class that laps it, and counts no pass for it', () => {
    const sim = start(car('gt3'), { kind: 'laps', laps: 14, cars: 2 }, noStops('gt3'));
    const [quick, slow] = sim.order;
    slow.entrant.carPace += 0.2;
    let gaveWay = 0;
    watch(sim, () => {
      if (slow.giveWay !== 0 && slow.giveWayTo === quick) gaveWay += DT;
      expect(quick.giveWay).toBe(0);
    });
    expect(quick.lapsDone - slow.lapsDone).toBeGreaterThanOrEqual(1);
    expect(gaveWay).toBeGreaterThan(1);
    expect(sim.events.filter((e) => e.kind === 'overtake')).toHaveLength(0);
  });

  it('has a slower class hold its line: the faster class finds its own way by', () => {
    const sim = multiClass(
      [{ vehicle: car('hypercar'), cars: 2, rules: calm(car('hypercar')) }, { vehicle: car('gt3'), cars: 6, rules: calm(car('gt3')) }],
      { kind: 'time', minutes: 25 },
    );
    const seen = watch(sim, (cars) => {
      for (const c of cars) if (c.giveWayTo) expect(c.giveWayTo.cls).toBe(c.cls);
    });
    const best = (label: string) => Math.max(...sim.cars.filter((c) => c.cls.label === label).map((c) => c.lapsDone));
    const [fast, slowClass] = sim.classes.map((c) => best(c.label));
    // The hypercars lapped the GT field on the way, without driving through it.
    expect(fast).toBeGreaterThan(slowClass);
    expect(seen.overlap).toBeLessThan(2);
  });

  it('shuffles the field on the first lap without turning it over', () => {
    for (const seed of ['11', '5', '9']) {
      const sim = start(car('f1'), { kind: 'laps', laps: 3, cars: 20, seed }, calm(car('f1')));
      const grid = new Map(sim.order.map((c, i) => [c.id, i]));
      while (sim.order.some((c) => c.status === 'running' && c.lapsDone < 1)) sim.step();
      const gains = sim.order.map((c, i) => grid.get(c.id)! - i);
      expect(gains.some((g) => g !== 0)).toBe(true);
      expect(Math.max(...gains)).toBeLessThanOrEqual(9);
      expect(-Math.min(...gains)).toBeLessThanOrEqual(9);
    }
  });

  it('gives the same race for the same seed', () => {
    const run = () => {
      const sim = start(car('gt3'), { kind: 'laps', laps: 6, cars: 12, seed: '21' }, calm(car('gt3')));
      while (!sim.finished) sim.step();
      return `${sim.order.map((c) => c.id).join(',')} ${sim.events.length} ${sim.t.toFixed(1)}`;
    };
    expect(run()).toBe(run());
  });
});

/** The first lap of a race: what the field did from the grid to the line. */
function firstLap(sim: RaceSim) {
  const m = sim.model;
  const zone = m.zones[0];
  const grid = sim.order.map((c) => c.id);
  // The slowest the racing line gets on the way into the first corner.
  let apexSpeed = Infinity;
  for (let k = zone.station; k !== zone.apex; k = (k + 1) % m.n) apexSpeed = Math.min(apexSpeed, m.v[k]);
  let first = -1;
  let last = -1;
  let slowest = Infinity;
  let three = 0;
  let overlap = 0;
  let abreast = 1;
  let before: number[] | null = null;
  const through = new Set<number>();
  while (sim.order.some((c) => c.status === 'running' && c.lapsDone < 1)) {
    sim.step();
    if (!before && sim.order[0].u >= zone.station) before = sim.order.map((c) => c.id);
    const cars = sim.cars.filter((c) => c.status === 'running' && c.lapsDone === 0);
    for (const c of cars) {
      if (!through.has(c.id) && c.u >= zone.apex) {
        through.add(c.id);
        if (first < 0) first = sim.t;
        last = sim.t;
      }
      if (c.u >= zone.station && c.u <= zone.apex) {
        slowest = Math.min(slowest, c.ground / apexSpeed);
        if (c.flank === 3) three += DT;
      } else if (c.u > 0 && c.u < zone.station && c.flank) abreast = Math.max(abreast, c.flank === 3 ? 3 : 2);
    }
    for (let i = 0; i < cars.length; i++) for (let j = i + 1; j < cars.length; j++) if (overlapping(sim, cars[i], cars[j])) overlap += DT;
  }
  const moved = (order: number[]) => order.reduce((sum, id, i) => sum + Math.abs(grid.indexOf(id) - i), 0);
  const gains = sim.order.map((c, i) => grid.indexOf(c.id) - i);
  return {
    /** Seconds from the first car to the last past the slowest point of the first corner. */
    through: last - first,
    /** The slowest any car went in the first corner, as a share of the racing line's slowest there. */
    slowest,
    /** Car-seconds in the middle of three abreast between the braking point and there. */
    three,
    overlap,
    abreast,
    /** Places changed (summed over the cars) by the first braking point, and the most one car gained or lost by the end of the lap. */
    movedBefore: moved(before ?? grid),
    gained: Math.max(...gains),
    lost: -Math.min(...gains),
  };
}

describe('the start in lanes', () => {
  it('leaves the grid in files, fans out and goes through the first corner without a jam', () => {
    for (const seed of ['11', '5']) {
      const lap = firstLap(start(car('f1'), { kind: 'laps', laps: 3, cars: 20, seed }, calm(car('f1'))));
      // Side by side on the way down, and places changing as the starts go.
      expect(lap.abreast).toBeGreaterThanOrEqual(2);
      expect(lap.movedBefore).toBeGreaterThan(4);
      // The whole field is through within seconds, nobody near a standstill, no bodies through each other.
      expect(lap.through).toBeLessThan(6);
      expect(lap.slowest).toBeGreaterThan(0.25);
      expect(lap.overlap).toBeLessThan(0.5);
      // A corner takes two abreast: a third is on its way out of the row, not through the corner in it.
      expect(lap.three).toBeLessThan(6);
      expect(lap.gained).toBeLessThanOrEqual(9);
      expect(lap.lost).toBeLessThanOrEqual(9);
    }
  });

  it('gets a full grid round a real hairpin at the end of a short run: Sakhir', () => {
    // The racing line's stations are under half a metre long at this apex and over two metres just after it: cars
    // following each other by stations and not by road stood still here. (Without incidents: the start alone.)
    const m = circuitRace('Sakhir', car('f1'), calm(car('f1')));
    for (const seed of ['lap1-0', 'lap1-1']) {
      const lap = firstLap(trialRace(m, seed));
      expect(lap.through).toBeLessThan(8);
      expect(lap.slowest).toBeGreaterThan(0.2);
      expect(lap.overlap).toBeLessThan(1);
      expect(lap.gained).toBeLessThanOrEqual(8);
      expect(lap.lost).toBeLessThanOrEqual(8);
    }
  });

  it('keeps a rolling start in formation to the first corner, more or less', () => {
    const rolling = firstLap(start(car('gt3'), { kind: 'laps', laps: 3, cars: 30, seed: '11' }, calm(car('gt3'))));
    const standing = firstLap(start(car('tcr'), { kind: 'laps', laps: 3, cars: 30, seed: '11' }, calm(car('tcr'))));
    // Thirty cars each: from a standstill the starts shuffle the order far more than from formation.
    expect(rolling.movedBefore).toBeLessThan(standing.movedBefore);
    expect(rolling.overlap).toBeLessThan(0.5);
    expect(rolling.slowest).toBeGreaterThan(0.25);
  });

  it('settles into one line within the first lap when nobody goes for a pass', () => {
    const base = calm(car('gt4'));
    const rules = { ...base, pace: { ...base.pace, overtaking: 0 }, pit: { ...base.pit, stops: false, minStops: 0 } };
    const sim = start(car('gt4'), { kind: 'laps', laps: 4, cars: 24 }, rules);
    const offLine: number[] = [];
    while (!sim.finished) {
      sim.step();
      for (const c of sim.cars) if (c.status === 'running' && Math.abs(c.lateral) > 0.3) offLine[c.lapsDone] = (offLine[c.lapsDone] ?? 0) + DT;
    }
    // Two files off the grid: a good part of the first lap beside the racing line, then next to none of it.
    expect(offLine[0]).toBeGreaterThan(30);
    expect(offLine[2] ?? 0).toBeLessThan(5);
    expect(offLine[3] ?? 0).toBeLessThan(5);
  });
});

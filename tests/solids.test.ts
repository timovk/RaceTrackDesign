import { describe, expect, it } from 'vitest';
import { type Solid, Solids } from '../src/core/solids.ts';

const asIs = (z: number) => z;
const flat = () => 0;
/** A block 20 m square and 10 m high, 100 m east of the origin. */
const block: Solid = { kind: 'grandstand', x: [90, 110, 110, 90], y: [-10, -10, 10, 10], anchor: 0, lo: 0, hi: 10 };
/** A beam over a road: 6 to 8 m up. */
const beam: Solid = { kind: 'gantry', x: [49, 51, 51, 49], y: [-15, -15, 15, 15], anchor: 0, lo: 6, hi: 8 };

describe('the ground in the way', () => {
  it('blocks a line that goes through a hill, and not one over it', () => {
    const hill = new Solids((x) => (Math.abs(x - 100) < 20 ? 30 : 0), asIs);
    expect(hill.between([0, 0, 10], [200, 0, 1])).toBe('ground');
    expect(hill.between([0, 0, 60], [200, 0, 40])).toBeNull();
    expect(new Solids(flat, asIs).between([0, 0, 10], [200, 0, 1])).toBeNull();
  });

  it('finds a bank right beside the camera, which a look every 25 m would step over', () => {
    // A bank 4 m high from 3 to 9 m in front of a camera 2 m up.
    const bank = new Solids((x) => (x > 3 && x < 9 ? 4 : 0), asIs);
    expect(bank.between([0, 0, 2], [300, 0, 1])).toBe('ground');
  });

  it('lets a line end on the track it looks at', () => {
    // The last metres are not looked at: the car stands on a road cut into the ground, or in front of its garage.
    const cutting = new Solids((x) => (x > 150 ? 6 : 0), asIs);
    expect(cutting.between([0, 0, 10], [200, 0, 1], 60)).toBeNull();
    expect(cutting.between([0, 0, 10], [200, 0, 1], 6)).toBe('ground');
  });

  it('goes by the height the ground is drawn at', () => {
    const rise = (x: number) => (Math.abs(x - 100) < 20 ? 3 : 0);
    expect(new Solids(rise, asIs).between([0, 0, 8], [200, 0, 4])).toBeNull();
    expect(new Solids(rise, (z) => 3 * z).between([0, 0, 8], [200, 0, 4])).toBe('ground');
  });
});

describe('what is built in the way', () => {
  const solids = new Solids(flat, asIs, [block, beam]);

  it('blocks a line through a building, whichever way its outline was given', () => {
    expect(solids.between([0, 0, 5], [200, 0, 5])).toBe('grandstand');
    const turned = new Solids(flat, asIs, [{ ...block, x: [...block.x].reverse(), y: [...block.y].reverse() }]);
    expect(turned.between([0, 0, 5], [200, 0, 5])).toBe('grandstand');
    // Past its corner, and over its roof.
    expect(solids.between([0, 30, 5], [200, 30, 5])).toBeNull();
    expect(solids.between([0, 0, 30], [200, 0, 20])).toBeNull();
  });

  it('lets a camera look under a beam, and not through it', () => {
    // From low down the car beyond the gantry is seen under the beam; from high up the beam is in the way.
    expect(solids.between([0, 0, 2], [80, 0, 1])).toBeNull();
    expect(solids.between([0, 0, 13], [80, 0, 3])).toBe('gantry');
  });

  it('names the first thing in the way', () => {
    expect(solids.between([0, 0, 7], [200, 0, 7])).toBe('gantry');
    const hill = new Solids((x) => (x > 20 && x < 30 ? 20 : 0), asIs, [block]);
    expect(hill.between([0, 0, 5], [200, 0, 5])).toBe('ground');
  });

  it('keeps a building its real size on ground drawn taller', () => {
    // On ground at 50 m drawn three times as tall, the block still ends 10 m above it.
    const high: Solid = { ...block, anchor: 50 };
    const drawn = new Solids(() => 50, (z) => 3 * z, [high]);
    expect(drawn.between([0, 0, 155], [200, 0, 155])).toBe('grandstand');
    expect(drawn.between([0, 0, 162], [200, 0, 162])).toBeNull();
  });

  it('wants a clear picture, not only a clear line: nothing built beside it either', () => {
    // The line passes 4 m clear of the building's corner: the car is seen, but half the picture would be wall.
    expect(solids.between([0, 14, 5], [200, 14, 5])).toBeNull();
    expect(solids.framed([0, 14, 5], [200, 14, 5], 8)).toBe(false);
    expect(solids.framed([0, 40, 5], [200, 40, 5], 8)).toBe(true);
    expect(solids.builtBetween([0, 0, 5], [200, 0, 5])).toBe('grandstand');
  });
});

describe('where a camera may stand', () => {
  const solids = new Solids((x) => (x > 300 ? (x - 300) * 2 : 0), asIs, [block, beam]);

  it('is not in a building, nor on a tower that would go through one', () => {
    expect(solids.standing(100, 0, 5)).toBe('grandstand');
    expect(solids.standing(100, 0, 14)).toBe('grandstand');
    // On a platform on its roof it may.
    expect(solids.standing(100, 0, 11.7, 2, true)).toBeNull();
    expect(solids.standing(100, 0, 5, 2, true)).toBe('grandstand');
    // Nor right beside it; well clear of it, it may.
    expect(solids.standing(111, 0, 5)).toBe('grandstand');
    expect(solids.standing(130, 0, 5)).toBeNull();
  });

  it('may be under a beam, not in it', () => {
    expect(solids.standing(50, 0, 2)).toBeNull();
    expect(solids.standing(50, 0, 7)).toBe('gantry');
  });

  it('is not under the ground, nor against a hillside', () => {
    expect(solids.standing(0, 0, -1)).toBe('ground');
    // At the foot of a slope of 200%: 4 m up at the spot, but the ground 2 m on is level with the lens.
    expect(solids.standing(301, 0, 5)).toBe('ground');
    expect(solids.standing(200, 0, 4)).toBeNull();
  });

  it('knows how high things reach round a place', () => {
    expect(solids.topWithin(0, 0, 20)).toBeCloseTo(0, 6);
    expect(solids.topWithin(100, 0, 5)).toBeCloseTo(10, 6);
    expect(solids.topWithin(130, 0, 25)).toBeCloseTo(10, 6);
    expect(solids.topWithin(320, 0, 30)).toBeGreaterThan(90);
  });
});

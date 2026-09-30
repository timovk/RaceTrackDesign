import { describe, expect, it } from 'vitest';
import { newProject, parseProject, serializeProject } from '../src/core/project.ts';

describe('project files', () => {
  it('round-trips a project', () => {
    const p = newProject('4242', 'hilly');
    p.name = 'Test Ring';
    p.track.points = [{ x: 100.123, y: 200.456, width: 14 }, { x: 300, y: 200, width: 12 }, { x: 200, y: 400, width: 12 }];
    p.track.grading.smoothing = 90;
    const back = parseProject(serializeProject(p));
    expect(back.name).toBe('Test Ring');
    expect(back.terrain).toEqual(p.terrain);
    expect(back.track.grading.smoothing).toBe(90);
    expect(back.track.points[0]).toEqual({ x: 100.12, y: 200.46, width: 14 });
  });

  it('fills defaults for a minimal file', () => {
    const p = parseProject('{"terrain":{"seed":99}}');
    expect(p.terrain.seed).toBe('99');
    expect(p.terrain.preset).toBe('rolling');
    expect(p.track.points).toEqual([]);
    expect(p.track.defaultWidth).toBe(12);
  });

  it('rejects broken or future files', () => {
    expect(() => parseProject('not json')).toThrow(/JSON/);
    expect(() => parseProject('[]')).toThrow();
    expect(() => parseProject('{"version": 99}')).toThrow(/newer/);
    expect(() => parseProject('{"track":{"points":[{"x":1}]}}')).toThrow(/coordinates/);
  });
});

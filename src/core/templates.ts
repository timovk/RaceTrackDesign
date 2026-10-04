/**
 * Circuits shipped with the app as ready-made projects (data/templates), to
 * open from the Templates menu and change like any other design. A template
 * of a real circuit sits on surveyed ground (core/survey.ts).
 */
import bremgarten from '../../data/templates/bremgarten.json' with { type: 'json' };
import { type Project, readProject } from './project.ts';

export interface Template {
  id: string;
  name: string;
  /** One or two lines for the menu: what it is and what to expect. */
  summary: string;
  /** The project as stored; `templateProject` checks it. */
  file: unknown;
}

export const TEMPLATES: readonly Template[] = [
  {
    id: 'bremgarten',
    name: 'Bremgarten 1954',
    summary: 'The Swiss Grand Prix road circuit in the forest north of Bern: 7.28 km of fast bends and no real straight, on its real ground.',
    file: bremgarten,
  },
];

/** A fresh copy of a template's project. */
export function templateProject(t: Template): Project {
  return readProject(structuredClone(t.file));
}

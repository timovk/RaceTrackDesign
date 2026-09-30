/**
 * The entry list: fictional teams and drivers drawn from the race seed. Each
 * team has a car pace and each driver a pace, consistency, tyre management,
 * racecraft, error rate and start reaction. Car and driver pace add up to a
 * lap-time multiplier around 1, with the spread set per class.
 */
import type { RaceRules } from './rules.ts';

export interface Entrant {
  index: number;
  number: number;
  /** "A. Lindqvist" */
  name: string;
  /** Three letters for the timing tower. */
  code: string;
  team: string;
  teamIndex: number;
  color: string;
  /** Lap-time multiplier from car and driver (below 1 is faster). */
  pace: number;
  /** Lap-to-lap scatter as a lap-time fraction (standard deviation). */
  consistency: number;
  /** Tyre wear multiplier. */
  tyreWear: number;
  /** 0..1: skill in wheel-to-wheel fights. */
  racecraft: number;
  /** Multiplier on the class's mistake and crash rates. */
  errorRate: number;
  /** 0..1: quality of the getaway at the start. */
  launch: number;
  /** Multiplier on the class's technical retirement rate. */
  reliability: number;
}

const SURNAMES = [
  'Aalto', 'Abara', 'Achterberg', 'Adeyemi', 'Almeida', 'Andersen', 'Arslan', 'Asante', 'Bakker', 'Balogun',
  'Barros', 'Becker', 'Bergstrom', 'Brandt', 'Castell', 'Castillo', 'Cerny', 'Chen', 'Costa', 'Dahl',
  'Delgado', 'Dimitrov', 'Dlamini', 'Dubois', 'Engel', 'Eriksen', 'Esposito', 'Falk', 'Farkas', 'Ferreira',
  'Fischer', 'Fontaine', 'Gallo', 'Garnier', 'Gomez', 'Haddad', 'Halvorsen', 'Hartmann', 'Holm', 'Horvat',
  'Ibarra', 'Ito', 'Iversen', 'Jansen', 'Jovanovic', 'Kaya', 'Keller', 'Kim', 'Kovacs', 'Kowalski',
  'Kruger', 'Laine', 'Lambert', 'Larsen', 'Lindqvist', 'Lopes', 'Lorentz', 'Lund', 'Maalouf', 'Marchetti',
  'Mensah', 'Meyer', 'Moreau', 'Moretti', 'Mori', 'Nakamura', 'Navarro', 'Nkosi', 'Novak', 'Nyberg',
  'Okafor', 'Okonkwo', 'Ortega', 'Oyelaran', 'Paredes', 'Park', 'Pavlov', 'Peeters', 'Quintero', 'Quist',
  'Rahman', 'Rautio', 'Reyes', 'Ricci', 'Rocha', 'Romano', 'Rousseau', 'Saarinen', 'Salo', 'Sandoval',
  'Santos', 'Schmid', 'Sokolov', 'Svensson', 'Takahashi', 'Tanaka', 'Teixeira', 'Thorsen', 'Toth', 'Tran',
  'Ueda', 'Valdez', 'Varga', 'Vasquez', 'Vogel', 'Volkov', 'Wagner', 'Walsh', 'Weber', 'Winter',
  'Xu', 'Yamada', 'Yilmaz', 'Yoon', 'Zamora', 'Zeller', 'Zielinski', 'Zimmermann',
];
const INITIALS = 'ABCDEFGHIJKLMNOPRSTVWY';
const TEAM_WORDS = [
  'Altair', 'Boreal', 'Cinder', 'Driftwood', 'Ember', 'Fjord', 'Granite', 'Harbor', 'Indigo', 'Juniper',
  'Kestrel', 'Lumen', 'Marlin', 'Nimbus', 'Quarry', 'Riverside', 'Sable', 'Tundra', 'Vireo', 'Willow',
];
const TEAM_SUFFIXES = ['Racing', 'Motorsport', 'Racing', 'GP', 'Racing Team'];
const TEAM_COLORS = [
  '#e5484d', '#3fb6ff', '#f5a524', '#30c46c', '#a78bfa', '#f472b6', '#2dd4bf', '#facc15', '#fb7c3c', '#6f8bff',
  '#a3e635', '#e879f9', '#cbd5e1', '#ff8fa3', '#0ea5e9', '#c08457', '#84cc16', '#d946ef', '#fde68a', '#94a3b8',
];

/** A standard normal draw from four uniforms (Irwin-Hall), avoiding log and trigonometry so every engine agrees. */
export function gauss(rng: () => number): number {
  return (rng() + rng() + rng() + rng() - 2) * 1.7320508075688772;
}

export function generateField(rules: RaceRules, count: number, rng: () => number): Entrant[] {
  const perTeam = Math.max(1, rules.field.perTeam);
  const teams = Math.ceil(count / perTeam);
  const words = shuffle([...TEAM_WORDS], rng);
  const colors = shuffle([...TEAM_COLORS], rng);
  const teamPace: number[] = [];
  const teamReliability: number[] = [];
  const teamNames: string[] = [];
  for (let i = 0; i < teams; i++) {
    teamPace.push(clamp(gauss(rng), -2.5, 2.5) * rules.field.carSpread);
    teamReliability.push(0.6 + 0.8 * rng());
    const word = words[i % words.length];
    teamNames.push(`${word} ${TEAM_SUFFIXES[Math.floor(rng() * TEAM_SUFFIXES.length)]}${i >= words.length ? ` ${Math.floor(i / words.length) + 1}` : ''}`);
  }

  const names = shuffle([...SURNAMES], rng);
  const numbers = shuffle(Array.from({ length: 98 }, (_, i) => i + 2), rng);
  const codes = new Set<string>();
  const out: Entrant[] = [];
  for (let i = 0; i < count; i++) {
    const team = Math.floor(i / perTeam);
    const surname = names[i % names.length];
    const initial = INITIALS[Math.floor(rng() * INITIALS.length)];
    out.push({
      index: i,
      number: numbers[i % numbers.length] + (i >= numbers.length ? 100 : 0),
      name: `${initial}. ${surname}`,
      code: uniqueCode(surname, codes),
      team: teamNames[team],
      teamIndex: team,
      color: colors[team % colors.length],
      pace: 1 + teamPace[team] + clamp(gauss(rng), -2.5, 2.5) * rules.field.driverSpread,
      consistency: rules.pace.consistency * (0.7 + 0.6 * rng()),
      tyreWear: clamp(1 + 0.06 * gauss(rng), 0.85, 1.15),
      racecraft: clamp(0.5 + 0.2 * gauss(rng), 0.05, 0.95),
      errorRate: 0.6 + 0.8 * rng(),
      launch: rng(),
      reliability: teamReliability[team],
    });
  }
  return out;
}

function uniqueCode(surname: string, used: Set<string>): string {
  const letters = surname.toUpperCase().replace(/[^A-Z]/g, '');
  const candidates = [letters.slice(0, 3)];
  for (let i = 3; i < letters.length; i++) candidates.push(letters.slice(0, 2) + letters[i]);
  for (let i = 2; i < letters.length; i++) candidates.push(letters[0] + letters[i] + (letters[i + 1] ?? 'X'));
  for (const c of candidates) {
    if (c.length === 3 && !used.has(c)) {
      used.add(c);
      return c;
    }
  }
  for (let d = 1; ; d++) {
    const c = `${letters.slice(0, 2)}${d}`;
    if (!used.has(c)) {
      used.add(c);
      return c;
    }
  }
}

export function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

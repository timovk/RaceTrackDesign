/**
 * Vehicle classes for the lap-time model. The data lives in
 * data/vehicles.json in human units (kW, km/h); this module checks it and
 * converts it to SI units.
 */
import data from '../../data/vehicles.json' with { type: 'json' };

export interface VehicleClass {
  id: string;
  name: string;
  /** Which generation or series the numbers describe, e.g. "2025" or "WEC". */
  spec: string;
  kind: 'car' | 'bike';
  color: string;
  /** kg, with driver and qualifying fuel. */
  mass: number;
  /** W at the wheels. */
  power: number;
  /** Drag and downforce areas (m2) at the low- and high-downforce ends of the aero trim range. */
  cdA: [number, number];
  clA: [number, number];
  /** Tyre friction coefficient at static load. */
  grip: number;
  /** Relative grip lost per extra car weight of normal load. */
  loadSensitivity: number;
  /** Share of the normal load on the driven wheels. */
  driveShare: number;
  rollingResistance: number;
  /** Acceleration and braking limits in g beyond tyre grip (wheelie and stoppie for bikes); null when none. */
  maxAccelG: number | null;
  maxBrakeG: number | null;
  /** Share of drag removed by an opened rear wing (DRS) on long straights; 0 without DRS. */
  drs: number;
  /** m/s, set by gearing. */
  topSpeed: number;
  gears: number;
  /** m/s at the top of first gear. */
  firstGearSpeed: number;
  /** How well the class matched real laps when it was last calibrated; null if never. */
  calibration: Calibration | null;
}

export interface Calibration {
  /** Number of real laps fitted against. */
  laps: number;
  /** Root-mean-square relative error over those laps. */
  rmsError: number;
}

/** The raw JSON form, in the units a person edits. */
export interface VehicleSpec {
  id: string;
  name: string;
  spec: string;
  kind: 'car' | 'bike';
  color: string;
  mass: number;
  powerKw: number;
  cdA: number | [number, number];
  clA: number | [number, number];
  grip: number;
  loadSensitivity: number;
  driveShare: number;
  rollingResistance: number;
  maxAccelG?: number | null;
  maxBrakeG?: number | null;
  drs?: number;
  topSpeedKmh: number;
  gears: number;
  firstGearKmh: number;
  calibration?: Calibration;
}

export interface VehicleFile {
  version: number;
  notes?: string;
  classes: VehicleSpec[];
}

export function parseVehicleFile(file: unknown): VehicleClass[] {
  if (!isObject(file) || !Array.isArray(file.classes)) throw new Error('Vehicle file needs a "classes" list.');
  const seen = new Set<string>();
  return file.classes.map((raw, i) => {
    const v = parseVehicleSpec(raw, i);
    if (seen.has(v.id)) throw new Error(`Duplicate vehicle id "${v.id}".`);
    seen.add(v.id);
    return v;
  });
}

export function parseVehicleSpec(raw: unknown, index = 0): VehicleClass {
  if (!isObject(raw)) throw new Error(`Vehicle ${index + 1} is not an object.`);
  const where = typeof raw.id === 'string' ? `"${raw.id}"` : `${index + 1}`;
  const num = (key: string, min: number, max: number): number => {
    const v = raw[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) {
      throw new Error(`Vehicle ${where}: "${key}" must be a number between ${min} and ${max}.`);
    }
    return v;
  };
  const range = (key: string, max: number): [number, number] => {
    const v = raw[key];
    if (typeof v === 'number' && v >= 0 && v <= max) return [v, v];
    if (Array.isArray(v) && v.length === 2 && v.every((x) => typeof x === 'number' && x >= 0 && x <= max)) return [v[0], v[1]];
    throw new Error(`Vehicle ${where}: "${key}" must be a number or a [low, high] pair between 0 and ${max}.`);
  };
  const optionalG = (key: string): number | null => {
    const v = raw[key];
    if (v === undefined || v === null) return null;
    return num(key, 0.1, 5);
  };
  const str = (key: string): string => {
    const v = raw[key];
    if (typeof v !== 'string' || !v.trim()) throw new Error(`Vehicle ${where}: "${key}" must be a text value.`);
    return v;
  };
  const kind = raw.kind === 'bike' ? 'bike' : 'car';
  const cal = raw.calibration;
  const calibration = isObject(cal) && typeof cal.laps === 'number' && typeof cal.rmsError === 'number'
    ? { laps: cal.laps, rmsError: cal.rmsError }
    : null;
  return {
    id: str('id'),
    name: str('name'),
    spec: typeof raw.spec === 'string' ? raw.spec : '',
    kind,
    color: typeof raw.color === 'string' ? raw.color : '#cccccc',
    mass: num('mass', 50, 5000),
    power: num('powerKw', 1, 3000) * 1000,
    cdA: range('cdA', 5),
    clA: range('clA', 10),
    grip: num('grip', 0.3, 4),
    loadSensitivity: num('loadSensitivity', 0, 0.5),
    driveShare: num('driveShare', 0.1, 1),
    rollingResistance: num('rollingResistance', 0, 0.1),
    maxAccelG: optionalG('maxAccelG'),
    maxBrakeG: optionalG('maxBrakeG'),
    drs: raw.drs === undefined ? 0 : num('drs', 0, 0.6),
    topSpeed: num('topSpeedKmh', 20, 600) / 3.6,
    gears: Math.round(num('gears', 1, 12)),
    firstGearSpeed: num('firstGearKmh', 5, 600) / 3.6,
    calibration,
  };
}

/** The built-in classes from data/vehicles.json. */
export const VEHICLES: VehicleClass[] = parseVehicleFile(data);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

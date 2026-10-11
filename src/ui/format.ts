/** Number formatting for the UI. */

export function km(metres: number, digits = 2): string {
  return `${(metres / 1000).toFixed(digits)} km`;
}

export function metres(m: number, digits = 0): string {
  return `${m.toFixed(digits)} m`;
}

/** A distance that switches from metres to kilometres above 1 km. */
export function distance(m: number): string {
  return m >= 1000 ? km(m) : metres(m);
}

export function elevation(m: number): string {
  return `${Math.round(m)} m`;
}

/** Gradient fraction as a signed percentage: 0.052 -> "+5.2%". */
export function gradient(g: number): string {
  const p = g * 100;
  return `${p > 0.05 ? '+' : ''}${p.toFixed(1)}%`;
}

export function radius(r: number): string {
  if (!Number.isFinite(r) || r > 99999) return '—';
  return `${Math.round(r)} m`;
}

export function volume(m3: number): string {
  if (m3 >= 1e6) return `${(m3 / 1e6).toFixed(2)} M m³`;
  if (m3 >= 1e3) return `${(m3 / 1e3).toFixed(0)} k m³`;
  return `${Math.round(m3)} m³`;
}

/** Metres per second as km/h. */
export function speed(v: number): string {
  return `${Math.round(v * 3.6)} km/h`;
}

export function percent(f: number): string {
  return `${Math.round(f * 100)}%`;
}

/** What the share of a lap at the limit of the driven tyres is called: a car spins its wheels, a bike may lift its front one first. */
export function tractionLabel(kind: 'car' | 'bike'): string {
  return kind === 'bike' ? 'at the limit of grip or a wheelie' : 'at the limit of wheelspin';
}

export const TRACTION_HINT = 'Pulling away with all the drive the tyres take: more throttle would only spin the wheels. It is not counted as full throttle.';

export function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function degrees(d: number): string {
  return `${Math.round(d)}°`;
}

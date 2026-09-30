// Loads the real circuits and reference laps from data/ for the calibration script and tests (Node only).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type CircuitModel, type ReferenceLap, parseReferenceFile } from '../src/core/calibration.ts';
import { circuitDesign, parseCircuitCsv } from '../src/core/circuits.ts';
import { computeRacingLine } from '../src/core/racingLine.ts';
import { buildTrack } from '../src/core/track.ts';

export const DATA_DIR = fileURLToPath(new URL('../data/', import.meta.url));

export function circuitNames(): string[] {
  return readdirSync(`${DATA_DIR}circuits`).filter((f) => f.endsWith('.csv')).map((f) => f.replace(/\.csv$/, '')).sort();
}

/** Builds a flat track and its racing line for a circuit in data/circuits. */
export function loadCircuit(name: string): CircuitModel {
  const rows = parseCircuitCsv(readFileSync(`${DATA_DIR}circuits/${name}.csv`, 'utf8'));
  const track = buildTrack(circuitDesign(rows), () => 0);
  if (!track) throw new Error(`Circuit ${name} could not be built.`);
  return { name, track, line: computeRacingLine(track) };
}

export function loadCircuits(names: Iterable<string>): Map<string, CircuitModel> {
  const out = new Map<string, CircuitModel>();
  for (const name of names) out.set(name, loadCircuit(name));
  return out;
}

export function loadReferenceLaps(): ReferenceLap[] {
  return parseReferenceFile(JSON.parse(readFileSync(`${DATA_DIR}reference-laps.json`, 'utf8')));
}

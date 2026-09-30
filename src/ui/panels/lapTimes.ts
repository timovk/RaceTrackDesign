/** Lap times for every class, and a detail card for the selected one. */
import { formatLapTime } from '../../core/calibration.ts';
import { sectorTimes } from '../../core/performance.ts';
import { section } from '../controls.ts';
import { h } from '../dom.ts';
import * as fmt from '../format.ts';
import type { Store } from '../store.ts';

export function lapTimesSection(store: Store): HTMLElement {
  const perf = store.performance;
  const pending = store.performancePending;
  const title = h('span', null, 'Lap times', pending ? h('span', { class: 'badge' }, 'updating') : null);
  if (!perf) {
    return section('Lap times', h('p', { class: 'muted small' }, pending ? 'Calculating…' : 'Lap times appear once the track is a closed loop.'));
  }

  const rows = [...perf.laps].sort((a, b) => a.time - b.time);
  const best = rows[0]?.time ?? 0;
  const table = h('table', { class: `table laps${pending ? ' stale' : ''}` },
    h('thead', null, h('tr', null,
      h('th', null, 'Class'), h('th', { class: 'num' }, 'Lap'), h('th', { class: 'num' }, 'Gap'), h('th', { class: 'num' }, 'Top'))),
    h('tbody', null, ...rows.map((lap) => {
      const car = store.vehicles.find((v) => v.id === lap.vehicleId)!;
      return h('tr', {
        class: lap.vehicleId === store.vehicleId ? 'focused' : '',
        title: `Show ${car.name} on the map and in the speed trace`,
        onclick: () => store.selectVehicle(lap.vehicleId),
      },
      h('td', null, h('span', { class: 'dot', style: `background:${car.color}` }), car.name),
      h('td', { class: 'num strong' }, formatLapTime(lap.time)),
      h('td', { class: 'num muted' }, lap.time === best ? '' : `+${(lap.time - best).toFixed(3)}`),
      h('td', { class: 'num' }, `${Math.round(lap.topSpeed * 3.6)}`));
    })),
  );

  return h('section', { class: 'panel-section' },
    h('h3', null, title),
    table,
    h('p', { class: 'hint' }, 'Flying laps from the start point on the racing line, with qualifying fuel. Top speed in km/h. Click a class for its details.'),
    detailCard(store),
  );
}

function detailCard(store: Store): HTMLElement | null {
  const perf = store.performance;
  const lap = store.lap;
  if (!perf || !lap) return null;
  const car = store.vehicle;
  const [s1, s2, s3] = sectorTimes(lap, perf.sectors);
  const row = (label: string, value: string) => [h('dt', null, label), h('dd', null, value)];
  const aero = car.cdA[0] === car.cdA[1] && car.clA[0] === car.clA[1];
  const trim = lap.trim <= 0.2 ? 'low' : lap.trim >= 0.8 ? 'high' : 'medium';
  const cal = car.calibration;
  return h('div', { class: 'card detail' },
    h('h3', null, h('span', { class: 'dot', style: `background:${car.color}` }), `${car.name} `, h('span', { class: 'muted' }, car.spec)),
    h('div', { class: 'sectors' },
      ...[s1, s2, s3].map((t, i) => h('div', { class: 'sector' }, h('span', { class: 'sector-label' }, `S${i + 1}`), h('span', { class: 'sector-time' }, formatLapTime(t))))),
    h('dl', { class: 'stats' },
      ...row('Lap time', formatLapTime(lap.time)),
      ...row('Top speed', fmt.speed(lap.topSpeed)),
      ...row('Average speed', fmt.speed(lap.avgSpeed)),
      ...row('Slowest point', fmt.speed(lap.minSpeed)),
      ...row('Full throttle', fmt.percent(lap.fullThrottle)),
      ...row('Braking zones', String(lap.brakingZones)),
      ...(aero ? [] : row('Wing setting', `${trim} downforce`)),
    ),
    h('details', { class: 'vehicle-data' },
      h('summary', null, 'Vehicle data'),
      h('dl', { class: 'stats' },
        ...row('Mass', `${Math.round(car.mass)} kg`),
        ...row('Power', `${Math.round(car.power / 1000)} kW (${Math.round(car.power / 745.7)} hp) at the wheels`),
        ...row('Tyre grip', car.grip.toFixed(2)),
        ...row('Drag area', aero ? `${car.cdA[0].toFixed(2)} m²` : `${car.cdA[0].toFixed(2)}–${car.cdA[1].toFixed(2)} m²`),
        ...row('Downforce area', aero ? `${car.clA[0].toFixed(2)} m²` : `${car.clA[0].toFixed(2)}–${car.clA[1].toFixed(2)} m²`),
        ...row('Top speed (gearing)', fmt.speed(car.topSpeed)),
      ),
      h('p', { class: 'hint' }, cal
        ? `Calibrated against ${cal.laps} real qualifying lap${cal.laps === 1 ? '' : 's'}: ${(cal.rmsError * 100).toFixed(1)}% RMS error. Edit data/vehicles.json to change a class.`
        : 'Not calibrated. Edit data/vehicles.json to change a class.'),
    ),
  );
}

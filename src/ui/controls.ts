/** Reusable form controls that update in place instead of being rebuilt. */
import { h, setText } from './dom.ts';

export interface Control {
  el: HTMLElement;
  update(): void;
}

export interface SliderOptions {
  label: string;
  min: number;
  max: number;
  step: number;
  get: () => number;
  format: (v: number) => string;
  /** Called continuously while dragging. */
  onInput: (v: number) => void;
  /** Called once when the value is released. */
  onCommit?: (v: number) => void;
  /** Called when an interaction starts (before the first input). */
  onStart?: () => void;
  title?: string;
}

export function slider(o: SliderOptions): Control {
  const value = h('span', { class: 'slider-value' });
  const input = h('input', { type: 'range', min: String(o.min), max: String(o.max), step: String(o.step) });
  let active = false;
  const start = () => {
    if (!active) {
      active = true;
      o.onStart?.();
    }
  };
  input.addEventListener('pointerdown', start);
  input.addEventListener('keydown', start);
  input.addEventListener('input', () => {
    start();
    const v = Number(input.value);
    setText(value, o.format(v));
    o.onInput(v);
  });
  input.addEventListener('change', () => {
    active = false;
    o.onCommit?.(Number(input.value));
  });
  const el = h('label', { class: 'slider', title: o.title }, h('span', { class: 'slider-head' }, h('span', null, o.label), value), input);
  const update = () => {
    if (active) return;
    const v = o.get();
    input.value = String(v);
    setText(value, o.format(v));
  };
  update();
  return { el, update };
}

export interface SegmentOption<T extends string> {
  value: T;
  label: string;
  title?: string;
}

export function segmented<T extends string>(options: SegmentOption<T>[], get: () => T, set: (v: T) => void): Control {
  const buttons = options.map((o) =>
    h('button', { type: 'button', class: 'segment', title: o.title, onclick: () => set(o.value) }, o.label),
  );
  const el = h('div', { class: 'segmented' }, ...buttons);
  const update = () => {
    const v = get();
    buttons.forEach((b, i) => b.classList.toggle('on', options[i].value === v));
  };
  update();
  return { el, update };
}

export function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h('section', { class: 'panel-section' }, h('h3', null, title), ...children);
}

/** The list of design warnings, shared by the Design and Analyse panels. */
import { h } from '../dom.ts';
import * as fmt from '../format.ts';
import type { Store } from '../store.ts';

const ICONS = { error: '●', warning: '▲', info: 'i' };

export function issueList(store: Store, onLocate: (station: number) => void, limit = Infinity): HTMLElement {
  const t = store.track;
  const issues = store.issues;
  if (!t) return h('p', { class: 'muted small' }, 'No track yet.');
  if (!issues.length) return h('p', { class: 'ok small' }, 'No problems found.');
  const shown = issues.slice(0, limit);
  const list = h('ul', { class: 'issues' },
    ...shown.map((issue) =>
      h('li', {
        class: `issue ${issue.severity}`,
        onclick: () => {
          store.setFocus({ start: issue.start, end: issue.end, centre: issue.focus });
          onLocate(issue.focus);
        },
        onmouseenter: () => store.setHover(issue.focus),
        onmouseleave: () => store.setHover(null),
      },
      h('span', { class: 'issue-icon' }, ICONS[issue.severity]),
      h('span', { class: 'issue-text' }, issue.message),
      h('span', { class: 'issue-at' }, fmt.km(t.s[issue.focus]))),
    ),
  );
  if (issues.length > shown.length) {
    list.append(h('li', { class: 'issue more', onclick: () => store.setMode('analyse') }, `+ ${issues.length - shown.length} more in Analyse`));
  }
  return list;
}

/** Saves text or a blob as a file through the browser's download. */
import { h } from './dom.ts';

export function download(filename: string, data: Blob | string, type = 'text/csv'): void {
  const blob = typeof data === 'string' ? new Blob([data], { type: `${type};charset=utf-8` }) : data;
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/** A file-name-safe version of a name: "Test Ring" -> "test-ring". */
export function slug(name: string, fallback = 'circuit'): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || fallback;
}

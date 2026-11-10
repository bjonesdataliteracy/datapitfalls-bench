// Reads the trap catalog (traps/catalog.yaml). Entries follow the Trap
// contract in @datapitfalls/schemas; `npm test` validates them against it.
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { monthIndex } from './months.js';

export interface TrapWindow {
  /** First data month in which the trap is present. */
  start: number;
  /** Last data month, or null when it runs to the end of the window. */
  end: number | null;
}

interface CatalogEntry {
  id: string;
  start_month: string;
  end_month?: string;
}

/** The months each trap covers, keyed by trap id. */
export function loadTrapWindows(catalogPath: string): Map<string, TrapWindow> {
  const entries = yaml.load(readFileSync(catalogPath, 'utf8')) as CatalogEntry[] | null;
  if (!Array.isArray(entries)) throw new Error(`${catalogPath}: expected a list of traps`);
  const windows = new Map<string, TrapWindow>();
  for (const entry of entries) {
    windows.set(entry.id, {
      start: monthIndex(entry.start_month),
      end: entry.end_month ? monthIndex(entry.end_month) : null,
    });
  }
  return windows;
}

export function trapCovers(window: TrapWindow | undefined, t: number): boolean {
  if (!window) return false;
  return t >= window.start && (window.end === null || t <= window.end);
}

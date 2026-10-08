// The time range a Dataset is examined over. One choice per Dataset drives the sample analysis,
// the test search, and the search-speed measurement, so all three look at the same data.

export const TIME_RANGES = [
  { id: '-1h', label: 'Last hour' },
  { id: '-24h', label: 'Last 24 hours' },
  { id: '-7d', label: 'Last 7 days' },
  { id: '-30d', label: 'Last 30 days' },
  { id: '-90d', label: 'Last 90 days' },
  { id: '-365d', label: 'Last 365 days' },
];

export const DEFAULT_RANGE = '-24h';

/** "last 30 days" for "-30d"; falls back to the raw value for a range this build does not list. */
export function rangeLabel(earliest: string | undefined): string {
  return TIME_RANGES.find((r) => r.id === (earliest ?? DEFAULT_RANGE))?.label.toLowerCase() ?? String(earliest);
}

/** The chosen range followed by each longer one, for a search that should step back until it finds events. */
export function rangeAndLonger(earliest: string): string[] {
  const start = TIME_RANGES.findIndex((r) => r.id === earliest);
  return start < 0 ? [earliest] : TIME_RANGES.slice(start).map((r) => r.id);
}

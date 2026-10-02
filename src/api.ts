// Cribl REST calls used by the app. Every path here must be declared in config/policies.yml.

declare global {
  interface Window {
    CRIBL_API_URL: string;
    CRIBL_BASE_PATH: string;
  }
}

export const LAKE_ID = 'default';
const SEARCH_GROUP = 'default_search';

export type SearchVersion = 'v1' | 'v2';
export type DataPathFormat = 'ndjson' | 'parquet';

export type PathFilter = {
  filter: string;
  dataTypeId: string;
  dataPathFormat?: DataPathFormat;
  [key: string]: unknown;
};

export type LakeSearchConfig = {
  searchVersion?: SearchVersion;
  /** v1 Datatypes (Event Breaker rulesets). Kept in place on v2 so a revert restores them. */
  datatypes?: string[];
  /** v2 format → Datatype ID rows. */
  pathFilters?: PathFilter[];
  [key: string]: unknown;
};

export type LakeDataset = {
  id: string;
  format?: string;
  description?: string;
  retentionPeriodInDays?: number;
  searchConfig?: LakeSearchConfig;
  /** Daily size snapshot. Only present on list results, and absent for Datasets that hold no data. */
  metrics?: { currentSizeBytes?: number; metricsDate?: string };
  [key: string]: unknown;
};

export type Datatype = {
  id: string;
  lib?: string;
  description?: string;
  tags?: string;
  dataFormat: string;
  additionalExtractions?: unknown[];
  schemaMap?: unknown[];
  addFields?: unknown[];
  timestampExtraction?: { sourceField?: string; anchorRegex?: string };
  [key: string]: unknown;
};

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(window.CRIBL_API_URL + path, init);
  if (!res.ok) {
    let detail = '';
    try {
      const text = await res.text();
      try {
        const body = JSON.parse(text) as { message?: string; error?: string };
        detail = body.message ?? body.error ?? text;
      } catch {
        detail = text;
      }
    } catch {
      /* body unreadable — status alone will do */
    }
    throw new ApiError(res.status, `${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  }
  return res;
}

async function getItems<T>(path: string, init?: RequestInit): Promise<T[]> {
  const res = await request(path, init);
  const body = (await res.json()) as { items?: T[] };
  return body.items ?? [];
}

const lakeDatasetsPath = `/products/lake/lakes/${LAKE_ID}/datasets`;

export function listLakeDatasets(): Promise<LakeDataset[]> {
  return getItems<LakeDataset>(`${lakeDatasetsPath}?excludeDeleted=true&includeMetrics=true`);
}

/** IDs of Datasets Cribl does not classify as internal (everything except e.g. cribl_logs, cribl_metrics). */
export async function listNonInternalDatasetIds(): Promise<Set<string>> {
  const items = await getItems<LakeDataset>(`${lakeDatasetsPath}?excludeDeleted=true&excludeInternal=true`);
  return new Set(items.map((d) => d.id));
}

export async function getLakeDataset(id: string): Promise<LakeDataset> {
  const items = await getItems<LakeDataset>(`${lakeDatasetsPath}/${encodeURIComponent(id)}`);
  if (!items[0]) throw new Error(`Lake Dataset "${id}" was not found.`);
  return items[0];
}

export function listDatatypes(): Promise<Datatype[]> {
  return getItems<Datatype>(`/m/${SEARCH_GROUP}/search/datatypes`);
}

/** Creates a custom v2 Datatype. Fails if the ID is already taken; never overwrites. */
export async function createDatatype(datatype: Datatype): Promise<void> {
  await request(`/m/${SEARCH_GROUP}/search/datatypes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(datatype),
  });
}

/** Dataset fields that a search-config change must never alter. */
const PRESERVED_FIELDS = ['format', 'description', 'retentionPeriodInDays', 'storageLocationId', 'bucketName'] as const;

/**
 * Replaces a Lake Dataset's search config.
 *
 * PATCH on this endpoint replaces the whole Dataset — omitted fields are dropped and retention
 * falls back to the default. So this always re-reads the Dataset and sends it back complete,
 * changing only `searchConfig`, then checks the response kept the other fields intact.
 */
export async function updateSearchConfig(
  id: string,
  change: (current: LakeSearchConfig) => LakeSearchConfig,
): Promise<LakeDataset> {
  const current = await getLakeDataset(id);
  const body: LakeDataset = { ...current, searchConfig: change(current.searchConfig ?? {}) };
  const items = await getItems<LakeDataset>(`${lakeDatasetsPath}/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const updated = items[0] ?? (await getLakeDataset(id));
  const changed = PRESERVED_FIELDS.filter((f) => JSON.stringify(updated[f]) !== JSON.stringify(current[f]));
  if (changed.length) {
    throw new Error(
      `Saved, but these settings changed unexpectedly: ${changed.join(', ')}. Review the Dataset in Cribl Lake.`,
    );
  }
  return updated;
}

export type SearchEvent = Record<string, unknown>;

export type SearchRun = {
  events: SearchEvent[];
  /** Engine the job ran on for this Dataset, as reported by the job status. */
  computeType?: string;
  /** How long the job ran, from start to completion, excluding time spent queued. */
  durationMs?: number;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Every search the app starts goes through this gate. A timing search must run with none of the app's
// other searches alongside it, or the extra load would skew the number it reports.
const searchGate = {
  running: 0,
  exclusiveRunning: false,
  exclusiveWaiting: 0,
  waiters: [] as (() => void)[],
  wake() {
    for (const resume of this.waiters.splice(0)) resume();
  },
};

/** Runs `job` once it may start: alone if `exclusive`, otherwise alongside other non-exclusive searches. */
async function throughGate<T>(exclusive: boolean, job: () => Promise<T>): Promise<T> {
  const gate = searchGate;
  if (exclusive) gate.exclusiveWaiting += 1;
  // Ordinary searches also wait while a timing search is queued, so it cannot be held off indefinitely.
  const blocked = () => gate.exclusiveRunning || (exclusive ? gate.running > 0 : gate.exclusiveWaiting > 0);
  while (blocked()) await new Promise<void>((resume) => gate.waiters.push(resume));
  if (exclusive) {
    gate.exclusiveWaiting -= 1;
    gate.exclusiveRunning = true;
  }
  gate.running += 1;
  try {
    return await job();
  } finally {
    gate.running -= 1;
    if (exclusive) gate.exclusiveRunning = false;
    gate.wake();
  }
}

/** Runs a search over one Dataset to completion and returns up to `limit` result rows. */
function runSearch(
  datasetId: string,
  pipeline: string,
  opts: { earliest: string; limit: number; timeoutMs?: number; exclusive?: boolean },
): Promise<SearchRun> {
  return throughGate(opts.exclusive ?? false, () => runSearchNow(datasetId, pipeline, opts));
}

async function runSearchNow(
  datasetId: string,
  pipeline: string,
  opts: { earliest: string; limit: number; timeoutMs?: number },
): Promise<SearchRun> {
  const jobsPath = `/m/${SEARCH_GROUP}/search/jobs`;
  const [job] = await getItems<{ id: string }>(jobsPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: `dataset="${datasetId}" | ${pipeline}`,
      earliest: opts.earliest,
      latest: 'now',
      sampleRate: 1,
    }),
  });
  if (!job?.id) throw new Error('Cribl Search did not return a job ID.');

  type Status = {
    status: string;
    error?: unknown;
    timeStarted?: number;
    timeCompleted?: number;
    cacheStatusesByStageId?: Record<string, Record<string, { computeType?: string }>>;
  };
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const deadline = Date.now() + timeoutMs;
  let computeType: string | undefined;
  let durationMs: number | undefined;
  for (;;) {
    const [status] = await getItems<Status>(`${jobsPath}/${job.id}/status`);
    computeType = status?.cacheStatusesByStageId?.root?.[datasetId]?.computeType ?? computeType;
    if (status?.status === 'completed') {
      if (status.timeStarted && status.timeCompleted) durationMs = status.timeCompleted - status.timeStarted;
      break;
    }
    if (status?.status === 'failed' || status?.status === 'canceled') {
      const reason = typeof status.error === 'string' ? status.error : JSON.stringify(status.error ?? '');
      throw new Error(`Search job ${status.status}${reason && reason !== '""' ? `: ${reason.slice(0, 300)}` : '.'}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`The search is still running after ${Math.round(timeoutMs / 60_000)} minutes. Try again later.`);
    }
    await sleep(2000);
  }

  // Results are NDJSON: a header line describing the job, then one row per line.
  const res = await request(`${jobsPath}/${job.id}/results?limit=${opts.limit}&offset=0`);
  const events: SearchEvent[] = [];
  for (const line of (await res.text()).split('\n')) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as SearchEvent;
      if ('isFinished' in row && 'job' in row) continue;
      events.push(row);
    } catch {
      /* skip a malformed line rather than fail the whole sample */
    }
  }
  return { events, computeType, durationMs };
}

/** Runs a small search over one Dataset and returns up to `limit` events. */
export function sampleDataset(datasetId: string, opts: { earliest: string; limit: number }): Promise<SearchRun> {
  return runSearch(datasetId, `limit ${opts.limit}`, opts);
}

export type Timing = {
  /** Job run time in milliseconds. */
  ms: number;
  /** Events the search counted, to check two timings covered similar amounts of data. */
  events: number;
  /** When it was measured (epoch milliseconds). */
  at: number;
};

/** Timings of the same benchmark search on each engine, per Dataset. */
export type Benchmark = { v1?: Timing; v2?: Timing };

/**
 * Times a fixed search — count every event from the last 24 hours — so v1 and v2 can be compared like for like.
 * A full day makes both engines read real volume; over one hour v2 mostly showed its fixed start-up cost.
 * Returns the engine the job actually ran on, which can lag a just-saved config change.
 */
export async function timeDataset(datasetId: string): Promise<{ timing: Timing; computeType?: string }> {
  const run = await runSearch(datasetId, 'summarize events=count()', { earliest: '-24h', limit: 1, timeoutMs: 600_000, exclusive: true });
  if (run.durationMs == null) throw new Error('Cribl Search did not report how long the job ran.');
  return { timing: { ms: run.durationMs, events: Number(run.events[0]?.events ?? 0), at: Date.now() }, computeType: run.computeType };
}

// App state lives in the app-scoped KV store, so it survives reloads and is shared by everyone using the app.

async function kvGet<T>(key: string, empty: T): Promise<T> {
  let text: string;
  try {
    text = await (await request(`/kvstore/${key}`)).text();
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return empty;
    throw err;
  }
  if (!text.trim()) return empty;
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' ? (value as T) : empty;
  } catch {
    return empty;
  }
}

async function kvPut(key: string, value: unknown): Promise<void> {
  await request(`/kvstore/${key}`, {
    method: 'PUT',
    // The KV store keeps the body as text. Sent as JSON, Cribl parses it first and stores "[object Object]".
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(value),
  });
}

// The key names the benchmark window: timings taken over a different window are not comparable and are left behind.
const BENCHMARKS_KEY = 'benchmarks-24h';

export function loadBenchmarks(): Promise<Record<string, Benchmark>> {
  return kvGet<Record<string, Benchmark>>(BENCHMARKS_KEY, {});
}

/**
 * Stores one Dataset's new timing and returns the full, current set.
 * `startOver` discards the Dataset's other timing, so a fresh v1 baseline is never paired with an old v2 result.
 */
export async function saveTiming(
  datasetId: string,
  engine: 'v1' | 'v2',
  timing: Timing,
  startOver = false,
): Promise<Record<string, Benchmark>> {
  const all = await loadBenchmarks();
  all[datasetId] = { ...(startOver ? {} : all[datasetId]), [engine]: timing };
  await kvPut(BENCHMARKS_KEY, all);
  return all;
}

/** Forgets a Dataset's timings, for when a new comparison could not be started cleanly. */
export async function clearBenchmark(datasetId: string): Promise<void> {
  const { [datasetId]: _dropped, ...rest } = await loadBenchmarks();
  await kvPut(BENCHMARKS_KEY, rest);
}

/** IDs of Datasets the user has set aside (for example, empty ones) so they don't clutter the migration list. */
export async function loadHiddenIds(): Promise<string[]> {
  const ids = await kvGet<unknown>('hidden', []);
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

export function saveHiddenIds(ids: string[]): Promise<void> {
  return kvPut('hidden', ids);
}

/** Datasets whose last sample analysis found no events: the time range searched and when. */
export type EmptyResults = Record<string, { earliest: string; at: number }>;

export function loadEmptyResults(): Promise<EmptyResults> {
  return kvGet<EmptyResults>('empty', {});
}

export function saveEmptyResults(results: EmptyResults): Promise<void> {
  return kvPut('empty', results);
}

/** Outcome of the post-migration test search for one Dataset. */
export type Verification =
  | { state: 'running' }
  | { state: 'error'; message: string }
  | { state: 'done'; eventCount: number; computeType?: string; datatypes: string[] };

/** Runs a 10-event search over the last 24 hours and reports the engine used and the datatype values returned. */
export async function verifyDataset(datasetId: string): Promise<Verification> {
  try {
    const run = await sampleDataset(datasetId, { earliest: '-24h', limit: 10 });
    const seen = new Set<string>();
    for (const e of run.events) if (typeof e.datatype === 'string') seen.add(e.datatype);
    return { state: 'done', eventCount: run.events.length, computeType: run.computeType, datatypes: [...seen] };
  } catch (err) {
    return { state: 'error', message: err instanceof Error ? err.message : String(err) };
  }
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  EMPTY_CELL_PLACEHOLDER,
  EmptyState,
  FilterToolbar,
  Link,
  Modal,
  Pill,
  SelectField,
  Table,
  Text,
  Toast,
  defineColumns,
} from '@capra/core';
import { ReloadOutlined } from '@capra/icons';
import {
  clearBenchmark,
  listDatatypes,
  listLakeDatasets,
  listNonInternalDatasetIds,
  loadBenchmarks,
  loadEmptyResults,
  saveEmptyResults,
  loadHiddenIds,
  saveHiddenIds,
  saveTiming,
  timeDataset,
  sampleDataset,
  updateSearchConfig,
  verifyDataset,
  type Benchmark,
  type Datatype,
  type EmptyResults,
  type LakeDataset,
  type Verification,
} from './api';
import type { HostTheme } from './host-theme';
import {
  currentRows,
  eligibleDatatypes,
  emptyReason,
  FORMAT_ROWS,
  primaryRow,
  searchVersionOf,
  secondaryRow,
  sizeGb,
  toV1,
  toV2,
  type Plan,
} from './migration';
import { recommendJsonDatatype, summarizeSample, type Recommendation, type Sample } from './recommend';
import { ReviewDrawer } from './ReviewDrawer';
import { describeSpeed, isSystemDataset, median, speedUp } from './speed';

type Selection = Parameters<typeof FilterToolbar>[0]['selectedKeys'];
type SortDescriptor = { column: string | number; direction: 'ascending' | 'descending' };

type Row = {
  id: string;
  format: string;
  size: string;
  version: string;
  v1Datatypes: string;
  target: string;
  basis: string;
  speed: string;
  [key: string]: unknown;
};

const VERSION_FILTERS = [
  { id: 'all', label: 'All search types' },
  { id: 'v1', label: 'v1 only' },
  { id: 'v2', label: 'v2 only' },
];

/** `returnTo`: Dataset whose drawer started the action, reopened once the dialog is done. */
type PendingAction = { mode: 'migrate' | 'revert'; ids: string[]; returnTo?: string };

const BASIS_APPEARANCE: Record<string, 'success' | 'info' | 'highlight' | 'warning' | 'danger' | 'default'> = {
  'No events found': 'warning',
  Verified: 'success',
  'Not on v2 yet': 'warning',
  'Check Datatype': 'warning',
  'Verify failed': 'danger',
  'No stored data': 'warning',
  'Analysis failed': 'danger',
  'Strong match': 'success',
  'Possible match': 'info',
  'Chosen manually': 'highlight',
  'Not supported': 'warning',
};

const staticColumns = defineColumns<Row>([
  { id: 'format', label: 'Storage format', allowsSorting: true },
  { id: 'size', label: 'Size (GB)' },
  {
    id: 'version',
    label: 'Search type',
    allowsSorting: true,
    render: (value) => (
      <Pill variant="muted" appearance={value === 'v2' ? 'success' : 'warning'}>
        {value}
      </Pill>
    ),
  },
  { id: 'v1Datatypes', label: 'v1 Datatypes' },
  { id: 'target', label: 'v2 Datatype ID', allowsSorting: true },
  {
    id: 'basis',
    label: 'Status',
    allowsSorting: true,
    render: (value) =>
      value === EMPTY_CELL_PLACEHOLDER ? (
        EMPTY_CELL_PLACEHOLDER
      ) : (
        <Pill variant="muted" appearance={BASIS_APPEARANCE[value] ?? 'default'}>
          {value}
        </Pill>
      ),
  },
  { id: 'speed', label: 'Search speed' },
]);

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function DatasetsPage({ theme }: { theme: HostTheme }) {
  const [datasets, setDatasets] = useState<LakeDataset[]>([]);
  const [datatypes, setDatatypes] = useState<Datatype[]>([]);
  const [nonInternalIds, setNonInternalIds] = useState<Set<string> | null>(null);
  const [showSystem, setShowSystem] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ label: string; done: number; total: number } | null>(null);
  const [benchmarks, setBenchmarks] = useState<Record<string, Benchmark>>({});
  const [measuring, setMeasuring] = useState<Set<string>>(new Set());
  const [measureOnMigrate, setMeasureOnMigrate] = useState(true);
  const [verifications, setVerifications] = useState<Record<string, Verification>>({});
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showHidden, setShowHidden] = useState(false);
  // Datasets whose last analysis found no events. Remembered across reloads so they stay out of the progress numbers.
  const [emptyResults, setEmptyResults] = useState<EmptyResults>({});
  const emptyResultsRef = useRef<EmptyResults>({});
  const [showEmpty, setShowEmpty] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [samples, setSamples] = useState<Record<string, Sample>>({});
  const [analyzing, setAnalyzing] = useState<Set<string>>(new Set());
  const [analysisErrors, setAnalysisErrors] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Record<string, Partial<Plan>>>({});

  const [filter, setFilter] = useState('');
  const [versionFilter, setVersionFilter] = useState('all');
  const [selectedKeys, setSelectedKeys] = useState<Selection>(new Set());
  const [sort, setSort] = useState<SortDescriptor>({ column: 'id', direction: 'ascending' });
  const [openId, setOpenId] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const [failures, setFailures] = useState<{ id: string; message: string }[]>([]);

  const load = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const [ds, dt, nonInternal] = await Promise.all([listLakeDatasets(), listDatatypes(), listNonInternalDatasetIds()]);
      setDatasets(ds);
      setDatatypes(dt);
      setNonInternalIds(nonInternal);
    } catch (err) {
      setLoadError(errorMessage(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    // Timings are a nice-to-have: if the KV store is unavailable the app still migrates, just without history.
    loadBenchmarks().then(setBenchmarks, () => undefined);
    loadHiddenIds().then((ids) => setHidden(new Set(ids)), () => undefined);
    loadEmptyResults().then(
      (results) => {
        emptyResultsRef.current = { ...results, ...emptyResultsRef.current };
        setEmptyResults(emptyResultsRef.current);
      },
      () => undefined,
    );
  }, [load]);

  const isSystem = useCallback((id: string) => isSystemDataset(id, nonInternalIds), [nonInternalIds]);
  const systemCount = useMemo(() => datasets.filter((d) => isSystem(d.id)).length, [datasets, isSystem]);
  /** Datasets in scope: system ones are left out unless the user asks for them. */
  /** Why a v1 Dataset is not counted as migration work (no stored data, or analyzed and empty), else null. */
  const emptyOf = useCallback(
    (d: LakeDataset) =>
      searchVersionOf(d) === 'v2' ? null : emptyReason(d, Boolean(emptyResults[d.id]), samples[d.id]?.eventCount),
    [emptyResults, samples],
  );
  const shown = useMemo(
    () =>
      datasets.filter(
        (d) => (showSystem || !isSystem(d.id)) && (showHidden || !hidden.has(d.id)) && (showEmpty || !emptyOf(d)),
      ),
    [datasets, showSystem, isSystem, showHidden, hidden, showEmpty, emptyOf],
  );
  const emptyTotal = useMemo(
    () => datasets.filter((d) => (showSystem || !isSystem(d.id)) && (showHidden || !hidden.has(d.id)) && emptyOf(d)).length,
    [datasets, showSystem, isSystem, showHidden, hidden, emptyOf],
  );
  const hiddenCount = useMemo(() => datasets.filter((d) => hidden.has(d.id)).length, [datasets, hidden]);

  /** Sets Datasets aside (or brings them back). Hiding is only a view preference; it changes nothing in Cribl Lake. */
  const setHiddenFor = (ids: string[], hide: boolean) => {
    const next = new Set(hidden);
    for (const id of ids) {
      if (hide) next.add(id);
      else next.delete(id);
    }
    setHidden(next);
    if (!next.size) setShowHidden(false);
    setSelectedKeys(new Set());
    saveHiddenIds([...next]).catch((err) =>
      Toast.warning(`Hidden Datasets could not be saved and will reset on reload: ${errorMessage(err)}`),
    );
  };

  const columns = useMemo(
    () => [
      ...defineColumns<Row>([
        {
          id: 'id',
          label: 'Dataset',
          allowsSorting: true,
          render: (value) => (
            <Link
              href={`#${encodeURIComponent(value)}`}
              // Keep the press from also toggling the row's selection.
              onPointerDown={(e: React.PointerEvent) => e.stopPropagation()}
              onMouseDown={(e: React.MouseEvent) => e.stopPropagation()}
              onClick={(e: React.MouseEvent) => {
                e.preventDefault();
                e.stopPropagation();
                setOpenId(value);
              }}
            >
              {value}
            </Link>
          ),
        },
      ]),
      ...staticColumns,
    ],
    [],
  );

  const byId = useMemo(() => new Map(datasets.map((d) => [d.id, d])), [datasets]);
  const jsonDatatypes = useMemo(() => eligibleDatatypes(datatypes, 'ndjson'), [datatypes]);

  const recommendations = useMemo(() => {
    const out: Record<string, Recommendation> = {};
    for (const d of datasets) {
      if (primaryRow(d) === 'ndjson') out[d.id] = recommendJsonDatatype(d, jsonDatatypes, samples[d.id]);
    }
    return out;
  }, [datasets, jsonDatatypes, samples]);

  /** What would be saved for a Dataset: its current v2 rows, or the recommendation, plus any manual choice. */
  const planFor = useCallback(
    (dataset: LakeDataset): Plan | null => {
      const primary = primaryRow(dataset);
      if (!primary) return null;
      const secondary = secondaryRow(dataset);
      const saved = searchVersionOf(dataset) === 'v2' ? currentRows(dataset) : {};
      const base: Plan = {
        primaryId: saved[primary] ?? recommendations[dataset.id]?.datatypeId ?? FORMAT_ROWS[primary].defaultDatatypeId,
        secondaryId: (secondary && saved[secondary]) ?? null,
      };
      return { ...base, ...overrides[dataset.id] };
    },
    [recommendations, overrides],
  );

  const isDirty = useCallback(
    (dataset: LakeDataset): boolean => {
      const plan = planFor(dataset);
      const primary = primaryRow(dataset);
      if (!plan || !primary || searchVersionOf(dataset) !== 'v2') return false;
      const secondary = secondaryRow(dataset);
      const saved = currentRows(dataset);
      return plan.primaryId !== saved[primary] || plan.secondaryId !== ((secondary && saved[secondary]) ?? null);
    },
    [planFor],
  );

  const rows = useMemo<Row[]>(() => {
    const all = shown.map((d): Row => {
      const primary = primaryRow(d);
      const plan = planFor(d);
      const version = searchVersionOf(d);
      const v1 = d.searchConfig?.datatypes ?? [];
      let basis = EMPTY_CELL_PLACEHOLDER;
      if (!primary) basis = 'Not supported';
      else if (version === 'v2') {
        const v = verifications[d.id];
        if (!v) basis = 'Not verified';
        else if (v.state === 'running') basis = 'Verifying…';
        else if (v.state === 'error') basis = 'Verify failed';
        else if (v.computeType !== 'v2') basis = 'Not on v2 yet';
        else if (v.eventCount === 0) basis = 'No events to verify';
        else basis = v.datatypes.length ? 'Verified' : 'Check Datatype';
      } else if (version === 'v1') {
        const rec = recommendations[d.id];
        if (rec && plan && plan.primaryId !== rec.datatypeId) basis = 'Chosen manually';
        else if (rec?.confidence === 'high') basis = 'Strong match';
        else if (rec?.confidence === 'medium') basis = 'Possible match';
        else if (emptyOf(d) === 'no-events') basis = 'No events found';
        else if (emptyOf(d) === 'no-data') basis = 'No stored data';
        else if (!samples[d.id]) basis = 'Not analyzed';
        else basis = 'Default (analyzed)';
        if (analysisErrors[d.id]) basis = 'Analysis failed';
        if (hidden.has(d.id)) basis = 'Hidden';
        if (analyzing.has(d.id)) basis = 'Analyzing…';
      }
      return {
        id: d.id,
        format: primary ? FORMAT_ROWS[primary].label : (d.format ?? 'Unknown'),
        size: sizeGb(d) ?? EMPTY_CELL_PLACEHOLDER,
        version,
        v1Datatypes: v1.length ? v1.join(', ') : 'Default rulesets',
        target: plan ? [plan.primaryId, plan.secondaryId].filter(Boolean).join(', ') : EMPTY_CELL_PLACEHOLDER,
        basis,
        speed: measuring.has(d.id) ? 'Measuring…' : describeSpeed(benchmarks[d.id]),
      };
    });
    const needle = filter.trim().toLowerCase();
    const filtered = all.filter(
      (r) =>
        (versionFilter === 'all' || r.version === versionFilter) &&
        (!needle || [r.id, r.format, r.version, r.v1Datatypes, r.target].some((v) => v.toLowerCase().includes(needle))),
    );
    const dir = sort.direction === 'descending' ? -1 : 1;
    return filtered.sort((a, b) => dir * String(a[sort.column]).localeCompare(String(b[sort.column]), undefined, { numeric: true }));
  }, [shown, planFor, recommendations, samples, emptyOf, verifications, analyzing, analysisErrors, hidden, measuring, benchmarks, filter, versionFilter, sort]);

  const selectedIds = useMemo(
    () => {
      // Only rows currently in the table count, so a hidden Dataset can never be part of a bulk action.
      const visible = rows.map((r) => r.id);
      return selectedKeys === 'all' ? visible : visible.filter((id) => selectedKeys.has(id));
    },
    [selectedKeys, rows],
  );
  const selectedV1 = selectedIds.filter((id) => {
    const d = byId.get(id);
    return d && searchVersionOf(d) === 'v1' && primaryRow(d);
  });
  const selectedJson = selectedIds.filter((id) => {
    const d = byId.get(id);
    return d && primaryRow(d) === 'ndjson';
  });

  const analyze = useCallback(async (id: string, earliest: string): Promise<'events' | 'empty' | 'failed'> => {
    setAnalyzing((prev) => new Set(prev).add(id));
    setAnalysisErrors(({ [id]: _cleared, ...rest }) => rest);
    try {
      const run = await sampleDataset(id, { earliest, limit: 50 });
      setSamples((prev) => ({ ...prev, [id]: summarizeSample(run.events) }));
      // Record or clear the "no events" result. A ref holds the latest set because analyses run in parallel.
      const { [id]: previous, ...others } = emptyResultsRef.current;
      if (!run.events.length || previous) {
        emptyResultsRef.current = run.events.length ? others : { ...others, [id]: { earliest, at: Date.now() } };
        setEmptyResults(emptyResultsRef.current);
        saveEmptyResults(emptyResultsRef.current).catch(() => undefined);
      }
      return run.events.length ? 'events' : 'empty';
    } catch (err) {
      setAnalysisErrors((prev) => ({ ...prev, [id]: errorMessage(err) }));
      return 'failed';
    } finally {
      setAnalyzing((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const analyzeSelected = async () => {
    const ids = selectedJson;
    setBulkProgress({ label: 'Analyzing', done: 0, total: ids.length });
    // Two searches at a time keeps the workspace's search concurrency free for other users.
    const queue = [...ids];
    const tally = { events: 0, empty: 0, failed: 0 };
    const emptyIds: string[] = [];
    const worker = async () => {
      for (let id = queue.shift(); id; id = queue.shift()) {
        const outcome = await analyze(id, '-24h');
        tally[outcome] += 1;
        if (outcome === 'empty') emptyIds.push(id);
        setBulkProgress((prev) => prev && { ...prev, done: prev.done + 1 });
      }
    };
    await Promise.all([worker(), worker()]);
    setBulkProgress(null);
    const summary =
      `Analyzed ${ids.length} Dataset${ids.length === 1 ? '' : 's'}: ${tally.events} with events` +
      (tally.empty ? `, ${tally.empty} with no events in the last 24 hours` : '') +
      (tally.failed ? `, ${tally.failed} failed` : '') +
      '. See the Status column.';
    if (emptyIds.length) {
      Toast.warning(summary, {
        duration: 0,
        action: { label: `Hide the ${emptyIds.length} with no events`, onClick: () => setHiddenFor(emptyIds, true) },
      });
    } else if (tally.failed) Toast.warning(summary);
    else Toast.success(summary);
  };

  /**
   * Times the benchmark search on whichever engine the Dataset currently uses and stores the result.
   * Takes the faster of two runs so a cold start doesn't count against either engine.
   */
  const measure = useCallback(async (id: string, fallbackEngine: 'v1' | 'v2', startOver = false): Promise<'v1' | 'v2'> => {
    setMeasuring((prev) => new Set(prev).add(id));
    try {
      const first = await timeDataset(id);
      const second = await timeDataset(id);
      // The job reports the engine it really ran on; a just-saved change can take a moment to apply.
      const engineOf = (r: typeof first) => (r.computeType === 'v2' ? 'v2' : r.computeType === 'v1' ? 'v1' : fallbackEngine);
      const engine = engineOf(second);
      const best = engineOf(first) === engine && first.timing.ms < second.timing.ms ? first : second;
      // Merge rather than replace, so a timing held in memory is never lost to a stale or failed store read.
      // `startOver` begins a new comparison: the Dataset's other timing is discarded, not carried along.
      const withTiming = (base: Record<string, Benchmark>) => ({
        ...base,
        [id]: { ...(startOver ? {} : base[id]), [engine]: best.timing },
      });
      setBenchmarks(withTiming);
      try {
        const stored = await saveTiming(id, engine, best.timing, startOver);
        setBenchmarks((prev) => {
          const merged = { ...stored };
          for (const [key, value] of Object.entries(prev)) merged[key] = { ...stored[key], ...value };
          return merged;
        });
      } catch {
        /* KV store unavailable: the timing stays for this session only */
      }
      return engine;
    } finally {
      setMeasuring((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  const measureNow = async (id: string, engine: 'v1' | 'v2') => {
    try {
      await measure(id, engine);
    } catch (err) {
      Toast.error(`Could not measure ${id}: ${errorMessage(err)}`);
    }
  };

  const verify = useCallback(async (id: string): Promise<Verification> => {
    setVerifications((prev) => ({ ...prev, [id]: { state: 'running' } }));
    const result = await verifyDataset(id);
    setVerifications((prev) => ({ ...prev, [id]: result }));
    return result;
  }, []);

  /**
   * After a migration, in the background and one Dataset at a time: verify the Dataset really searches on v2,
   * and only then time it on v2. A saved change can take a moment to apply, so verification retries.
   */
  const checkAfterMigration = async (ids: string[], timed: boolean) => {
    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    const unverified: string[] = [];
    for (const id of ids) {
      let onV2 = false;
      for (let attempt = 0; attempt < 3 && !onV2; attempt++) {
        await sleep(attempt === 0 ? 5_000 : 20_000);
        const result = await verify(id);
        if (result.state !== 'done') break;
        onV2 = result.computeType === 'v2';
      }
      if (!onV2) {
        unverified.push(id);
        continue;
      }
      // Timing a search that is not confirmed on v2 would record a misleading number, so it is skipped above.
      if (timed) await measure(id, 'v2').catch(() => undefined);
    }
    if (unverified.length) {
      Toast.warning(
        `Could not confirm these Datasets search on v2, so their v2 speed was not measured: ${unverified.join(', ')}. Open one and run the test search again.`,
        { duration: 0 },
      );
    }
  };

  const runPending = async (action: PendingAction) => {
    const failed: { id: string; message: string }[] = [];
    const migrated: string[] = [];
    const timed = action.mode === 'migrate' && measureOnMigrate;
    let ok = 0;
    // Close the dialog and report progress on the page: timing the v1 baseline makes each Dataset take a while.
    setPending(null);
    setBulkProgress({ label: action.mode === 'revert' ? 'Reverting' : 'Migrating', done: 0, total: action.ids.length });
    for (const id of action.ids) {
      const dataset = byId.get(id);
      const plan = dataset && planFor(dataset);
      try {
        if (!dataset) throw new Error('Dataset is no longer listed.');
        if (timed && plan && searchVersionOf(dataset) === 'v1') {
          // Take a fresh v1 baseline every time, so it is measured minutes before v2 rather than days.
          // A failed timing must not block the migration; it just leaves this Dataset without a comparison.
          await measure(id, 'v1', true).catch(() => {
            setBenchmarks(({ [id]: _stale, ...rest }) => rest);
            void clearBenchmark(id).catch(() => undefined);
          });
        }
        if (action.mode === 'revert') await updateSearchConfig(id, toV1);
        else if (plan) await updateSearchConfig(id, toV2(dataset, plan));
        else throw new Error(`Storage format "${dataset.format}" does not support v2.`);
        ok += 1;
        if (action.mode === 'migrate') migrated.push(id);
      } catch (err) {
        failed.push({ id, message: errorMessage(err) });
      }
      setBulkProgress((prev) => prev && { ...prev, done: prev.done + 1 });
    }
    setBulkProgress(null);
    setFailures(failed);
    setOverrides((prev) => {
      const next = { ...prev };
      for (const id of action.ids) if (!failed.some((f) => f.id === id)) delete next[id];
      return next;
    });
    setSelectedKeys(new Set());
    await load();
    if (action.returnTo) setOpenId(action.returnTo);
    if (migrated.length) void checkAfterMigration(migrated, timed);
    const verb = action.mode === 'revert' ? 'reverted to v1' : 'saved on v2';
    if (ok) Toast.success(`${ok} Dataset${ok === 1 ? '' : 's'} ${verb}.`);
    if (failed.length) Toast.error(`${failed.length} Dataset${failed.length === 1 ? '' : 's'} could not be updated. See the details on the page.`);
  };

  const selectCreatedDatatype = async (datasetId: string, datatypeId: string) => {
    setOverrides((prev) => ({ ...prev, [datasetId]: { ...prev[datasetId], primaryId: datatypeId } }));
    Toast.success(`Datatype ${datatypeId} created and selected for ${datasetId}. Migrate or save to apply it.`);
    try {
      setDatatypes(await listDatatypes());
    } catch (err) {
      Toast.error(`The Datatype was created, but the list could not be refreshed: ${errorMessage(err)}`);
    }
  };

  // The drawer stacks above the confirmation dialog, so step it aside while the dialog is open.
  const confirmFromDrawer = (mode: PendingAction['mode'], id: string) => {
    setOpenId(null);
    setPending({ mode, ids: [id], returnTo: id });
  };
  const cancelPending = () => {
    if (pending?.returnTo) setOpenId(pending.returnTo);
    setPending(null);
  };

  const openDataset = openId ? (byId.get(openId) ?? null) : null;
  // An empty v1 Dataset is not counted as work left to do, even when it is shown.
  const counted = shown.filter((d) => !emptyOf(d));
  const counts = {
    total: counted.length,
    v1: counted.filter((d) => searchVersionOf(d) === 'v1').length,
    v2: counted.filter((d) => searchVersionOf(d) === 'v2').length,
  };
  const progressText = bulkProgress ? `${bulkProgress.label} ${bulkProgress.done} of ${bulkProgress.total}…` : null;
  const gains = shown.map((d) => speedUp(benchmarks[d.id])).filter((g): g is number => g != null).sort((a, b) => a - b);
  const medianGain = median(gains);
  const gainText =
    medianGain == null ? EMPTY_CELL_PLACEHOLDER : `${Math.abs(Math.round(medianGain * 100))}% ${medianGain >= 0 ? 'faster' : 'slower'}`;
  /** JSON Datasets in a bulk migration that would get the default without their data ever being checked. */
  const unanalyzed =
    pending?.mode === 'migrate' && !pending.returnTo
      ? pending.ids.filter((id) => {
          const d = byId.get(id);
          return d && primaryRow(d) === 'ndjson' && !samples[id]?.eventCount && !overrides[id]?.primaryId;
        })
      : [];

  return (
    <>
      <header className="page-header">
        <div className="page-title">
          <Text as="h1" variant="heading-lg">
            Lake Datasets
          </Text>
          <Text as="p" color="subtle">
            Move Cribl Lake Datasets from v1 Datatypes to v2. The switch changes how Cribl Search reads the Dataset, not
            the stored data, and you can revert it.
          </Text>
        </div>
        <Button leadingIcon={ReloadOutlined} pending={isLoading} onClick={() => void load()}>
          Refresh
        </Button>
      </header>

      <div className="page-content">
        {loadError && (
          <div className="span-12">
            <Alert appearance="danger" title="Could not load Lake Datasets" action={{ label: 'Try again', onClick: () => void load() }}>
              {loadError}
            </Alert>
          </div>
        )}

        {failures.length > 0 && (
          <div className="span-12">
            <Alert appearance="warning" title="Some Datasets were not updated" onDismiss={() => setFailures([])}>
              {failures.map((f) => `${f.id}: ${f.message}`).join(' · ')}
            </Alert>
          </div>
        )}

        {(
          [
            [emptyTotal ? `Lake Datasets (${emptyTotal} empty not counted)` : 'Lake Datasets', counts.total],
            ['Still on v1', counts.v1],
            ['On v2', counts.v2],
            [`Median search speed on v2 (${gains.length} measured)`, gainText],
          ] as const
        ).map(([label, value]) => (
          <div className="span-3" key={label}>
            <Card>
              <Card.Content>
                <div className="metric">
                  <Text color="subtle">{label}</Text>
                  <Text variant="metric-lg">{isLoading && !datasets.length ? EMPTY_CELL_PLACEHOLDER : String(value)}</Text>
                </div>
              </Card.Content>
            </Card>
          </div>
        ))}

        <div className="span-12 table-stack">
          {!isLoading && !loadError && datasets.length === 0 ? (
            <EmptyState
              theme={theme}
              title="No Lake Datasets"
              description="This workspace has no Cribl Lake Datasets to migrate."
            />
          ) : (
            <>
              <FilterToolbar
                filterInputProps={{ 'aria-label': 'Filter Datasets', placeholder: 'Filter Datasets', onChange: setFilter }}
                renderActions={() => (
                  <div className="toolbar-actions">
                    {progressText && <Text color="subtle">{progressText}</Text>}
                    {hiddenCount > 0 && (
                      <div className="nowrap">
                        <Checkbox checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)}>
                          {`Show hidden Datasets (${hiddenCount})`}
                        </Checkbox>
                      </div>
                    )}
                    {emptyTotal > 0 && (
                      <div className="nowrap">
                        <Checkbox checked={showEmpty} onChange={(e) => setShowEmpty(e.target.checked)}>
                          {`Show empty Datasets (${emptyTotal})`}
                        </Checkbox>
                      </div>
                    )}
                    <div className="nowrap">
                      <Checkbox checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)}>
                        {`Show system Datasets (${systemCount})`}
                      </Checkbox>
                    </div>
                    <SelectField
                      aria-label="Search type"
                      size="sm"
                      items={VERSION_FILTERS}
                      value={versionFilter}
                      onChange={(key) => key != null && setVersionFilter(String(key))}
                    />
                  </div>
                )}
                renderBulkEditText={() => (
                  <Text>{`${selectedIds.length} of ${rows.length} Datasets selected${progressText ? ` · ${progressText}` : ''}`}</Text>
                )}
                renderBulkEditActions={() => (
                  <div className="bulk-actions">
                    <Button
                      size="sm"
                      disabled={!selectedJson.length || bulkProgress != null}
                      onClick={() => void analyzeSelected()}
                    >
                      Analyze sample events
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!selectedV1.length}
                      onClick={() => setPending({ mode: 'migrate', ids: selectedV1 })}
                    >
                      Migrate to v2
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => setHiddenFor(selectedIds, !selectedIds.every((id) => hidden.has(id)))}
                    >
                      {selectedIds.length > 0 && selectedIds.every((id) => hidden.has(id)) ? 'Unhide' : 'Hide'}
                    </Button>
                    <Button size="sm" variant="tertiary" appearance="neutral" onClick={() => setSelectedKeys(new Set())}>
                      Cancel
                    </Button>
                  </div>
                )}
                selectedKeys={selectedKeys}
              />
              <Table
                aria-label="Lake Datasets"
                columns={columns}
                visibleColumns={['id', 'format', 'size', 'version', 'v1Datatypes', 'target', 'basis', 'speed']}
                items={rows}
                isLoading={isLoading && !datasets.length}
                sortDescriptor={sort}
                onSortChange={setSort}
                selectionMode="multiple"
                selectedKeys={selectedKeys}
                onSelectionChange={setSelectedKeys}
                // Capra's Table forwards extra props to the React Aria table it wraps, which opens the
                // row on click. Its own prop types don't list this one yet, hence the cast.
                {...({ onRowAction: (key: string | number) => setOpenId(String(key)) } as object)}
              />
            </>
          )}
        </div>
      </div>

      <ReviewDrawer
        dataset={openDataset}
        datatypes={datatypes}
        plan={openDataset ? planFor(openDataset) : null}
        isDirty={openDataset ? isDirty(openDataset) : false}
        recommendation={openDataset ? recommendations[openDataset.id] : undefined}
        sample={openDataset ? samples[openDataset.id] : undefined}
        isAnalyzing={openDataset ? analyzing.has(openDataset.id) : false}
        analysisError={openDataset ? analysisErrors[openDataset.id] : undefined}
        benchmark={openDataset ? benchmarks[openDataset.id] : undefined}
        isMeasuring={openDataset ? measuring.has(openDataset.id) : false}
        isHidden={openDataset ? hidden.has(openDataset.id) : false}
        verification={openDataset ? verifications[openDataset.id] : undefined}
        onVerify={() => openDataset && void verify(openDataset.id)}
        emptyResult={openDataset ? emptyResults[openDataset.id] : undefined}
        onToggleHidden={() => {
          if (!openDataset) return;
          const hide = !hidden.has(openDataset.id);
          setHiddenFor([openDataset.id], hide);
          if (hide) {
            setOpenId(null);
            Toast.info(`${openDataset.id} is hidden. Select "Show hidden Datasets" in the toolbar to bring it back.`);
          }
        }}
        onMeasure={() => openDataset && void measureNow(openDataset.id, searchVersionOf(openDataset))}
        onClose={() => setOpenId(null)}
        onPlanChange={(change) => openDataset && setOverrides((prev) => ({ ...prev, [openDataset.id]: { ...prev[openDataset.id], ...change } }))}
        onAnalyze={(earliest) => openDataset && void analyze(openDataset.id, earliest)}
        onDatatypeCreated={(id) => openDataset && void selectCreatedDatatype(openDataset.id, id)}
        onMigrate={() => openDataset && confirmFromDrawer('migrate', openDataset.id)}
        onRevert={() => openDataset && confirmFromDrawer('revert', openDataset.id)}
      />

      <Modal
        isOpen={pending != null}
        onIsOpenChange={(open) => !open && cancelPending()}
        title={
          pending?.mode === 'revert'
            ? 'Revert to v1 Datatypes?'
            : `Save v2 Datatypes on ${pending?.ids.length ?? 0} Dataset${pending?.ids.length === 1 ? '' : 's'}?`
        }
        confirmButtonText={pending?.mode === 'revert' ? 'Revert to v1' : 'Save as v2'}
        onConfirm={() => {
          if (pending) void runPending(pending);
        }}
      >
        {pending && (
          <div className="confirm-body">
            <Text as="p">
              {pending.mode === 'revert'
                ? 'This updates the search configuration of the Dataset below. Searches go back to the v1 Datatypes it had before; its v2 Datatype rows are removed.'
                : 'This updates the search configuration of each Dataset below. Searches, dashboards, and alerts that read these Datasets will use the v2 Datatype from the next run. Stored data, retention, and v1 Datatypes are kept, so you can revert to v1.'}
            </Text>
            {pending.mode === 'migrate' && (
              <Checkbox checked={measureOnMigrate} onChange={(e) => setMeasureOnMigrate(e.target.checked)}>
                Measure search speed before and after (four searches per Dataset, each counting the last 24 hours)
              </Checkbox>
            )}
            {unanalyzed.length > 0 && (
              <Alert appearance="warning" layout="inline" title="Not analyzed">
                {`${unanalyzed.length} of ${pending.ids.length} Datasets have not been checked against sample events and will get the default Datatype ID: ${unanalyzed.join(', ')}.`}
              </Alert>
            )}
            <ul className="confirm-list">
              {pending.ids.map((id) => {
                const dataset = byId.get(id);
                const plan = dataset && planFor(dataset);
                const primary = dataset && primaryRow(dataset);
                const secondary = dataset && secondaryRow(dataset);
                return (
                  <li key={id}>
                    <Text variant="body-md-semibold">{id}</Text>
                    {pending.mode === 'migrate' && plan && primary && (
                      <Text color="subtle">
                        {` — ${FORMAT_ROWS[primary].label}: ${plan.primaryId}` +
                          (secondary && plan.secondaryId ? `, ${FORMAT_ROWS[secondary].label}: ${plan.secondaryId}` : '')}
                      </Text>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </Modal>
    </>
  );
}

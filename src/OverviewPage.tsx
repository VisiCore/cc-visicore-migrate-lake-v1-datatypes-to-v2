import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, EMPTY_CELL_PLACEHOLDER, EmptyState, Pill, Table, Text, defineColumns } from '@capra/core';
import { ReloadOutlined } from '@capra/icons';
import { listLakeDatasets, listNonInternalDatasetIds, loadBenchmarks, loadEmptyResults, loadHiddenIds, type Benchmark, type EmptyResults, type LakeDataset } from './api';
import type { HostTheme } from './host-theme';
import { emptyReason, primaryRow, searchVersionOf } from './migration';
import { rangeLabel } from './ranges';
import { isSystemDataset, median, speedUp } from './speed';

type Row = {
  id: string;
  v1: string;
  v2: string;
  change: string;
  events: string;
  range: string;
  [key: string]: unknown;
};

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const changeText = (gain: number) => {
  const pct = Math.abs(Math.round(gain * 100));
  return pct === 0 ? 'No change' : `${pct}% ${gain > 0 ? 'faster' : 'slower'}`;
};

const columns = defineColumns<Row>([
  { id: 'id', label: 'Dataset' },
  { id: 'v1', label: 'v1 search time' },
  { id: 'v2', label: 'v2 search time' },
  {
    id: 'change',
    label: 'Change',
    render: (value) => (
      <Pill variant="muted" appearance={value.endsWith('faster') ? 'success' : value.endsWith('slower') ? 'warning' : 'default'}>
        {value}
      </Pill>
    ),
  },
  { id: 'events', label: 'Events searched' },
  { id: 'range', label: 'Time range' },
]);

function Kpi({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="span-3">
      <Card>
        <Card.Content>
          <div className="metric">
            <Text color="subtle">{label}</Text>
            <Text variant="metric-lg">{value}</Text>
            <Text color="subtle" variant="body-sm-normal">
              {note}
            </Text>
          </div>
        </Card.Content>
      </Card>
    </div>
  );
}

export function OverviewPage({ theme, onOpenDatasets }: { theme: HostTheme; onOpenDatasets: () => void }) {
  const [datasets, setDatasets] = useState<LakeDataset[]>([]);
  const [benchmarks, setBenchmarks] = useState<Record<string, Benchmark>>({});
  const [notCounted, setNotCounted] = useState({ empty: 0, hidden: 0 });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [all, nonInternal, timings, hiddenIds, emptyResults] = await Promise.all([
        listLakeDatasets(),
        listNonInternalDatasetIds(),
        // Timings are optional: the migration counts still stand without them.
        loadBenchmarks().catch(() => ({})),
        loadHiddenIds().catch(() => [] as string[]),
        loadEmptyResults().catch((): EmptyResults => ({})),
      ]);
      // Same scope as the Datasets page default: Cribl's system Datasets are left out.
      // v1 Datasets that were analyzed and found empty, or that someone hid, are not work left to do.
      const inScope = all.filter((d) => !isSystemDataset(d.id, nonInternal));
      const hidden = new Set(hiddenIds);
      const v1 = inScope.filter((d) => searchVersionOf(d) === 'v1');
      const isEmpty = (d: LakeDataset) => emptyReason(d, Boolean(emptyResults[d.id]), undefined) != null;
      setNotCounted({ empty: v1.filter(isEmpty).length, hidden: v1.filter((d) => hidden.has(d.id) && !isEmpty(d)).length });
      setDatasets(inScope.filter((d) => searchVersionOf(d) === 'v2' || (!hidden.has(d.id) && !isEmpty(d))));
      setBenchmarks(timings);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  const stats = useMemo(() => {
    const supported = datasets.filter((d) => primaryRow(d));
    const onV2 = supported.filter((d) => searchVersionOf(d) === 'v2').length;
    const measured = datasets
      .map((d) => ({ id: d.id, b: benchmarks[d.id], gain: speedUp(benchmarks[d.id]) }))
      .filter((m): m is { id: string; b: Required<Benchmark>; gain: number } => m.gain != null)
      .sort((a, b) => b.gain - a.gain);
    const gains = measured.map((m) => m.gain).sort((a, b) => a - b);
    const v1Total = measured.reduce((sum, m) => sum + m.b.v1.ms, 0);
    const v2Total = measured.reduce((sum, m) => sum + m.b.v2.ms, 0);
    return {
      total: supported.length,
      unsupported: datasets.length - supported.length,
      onV2,
      onV1: supported.length - onV2,
      share: supported.length ? onV2 / supported.length : 0,
      measured,
      median: median(gains),
      faster: gains.filter((g) => g > 0).length,
      v1Total,
      v2Total,
    };
  }, [datasets, benchmarks]);

  const rows: Row[] = stats.measured.map((m) => ({
    id: m.id,
    v1: seconds(m.b.v1.ms),
    v2: seconds(m.b.v2.ms),
    change: changeText(m.gain),
    events: `${m.b.v1.events.toLocaleString()} → ${m.b.v2.events.toLocaleString()}`,
    range: rangeLabel(m.b.v1.earliest).replace(/^l/, 'L'),
  }));
  const blank = isLoading && !datasets.length;
  const n = stats.measured.length;

  return (
    <>
      <header className="page-header">
        <div className="page-title">
          <Text as="h1" variant="heading-lg">
            Overview
          </Text>
          <Text as="p" color="subtle">
            Progress moving Cribl Lake Datasets from v1 to v2 Datatypes, and what it has done to search speed.
          </Text>
        </div>
        <div className="header-actions">
          <Button leadingIcon={ReloadOutlined} pending={isLoading} onClick={() => void load()}>
            Refresh
          </Button>
          <Button variant="primary" onClick={onOpenDatasets}>
            Migrate Datasets
          </Button>
        </div>
      </header>

      <div className="page-content">
        {error && (
          <div className="span-12">
            <Alert appearance="danger" title="Could not load the overview" action={{ label: 'Try again', onClick: () => void load() }}>
              {error}
            </Alert>
          </div>
        )}

        <Kpi
          label="Migrated to v2"
          value={blank ? EMPTY_CELL_PLACEHOLDER : `${Math.round(stats.share * 100)}%`}
          note={blank ? ' ' : `${stats.onV2} of ${stats.total} Datasets`}
        />
        <Kpi
          label="Still on v1"
          value={blank ? EMPTY_CELL_PLACEHOLDER : String(stats.onV1)}
          note={
            [
              notCounted.empty ? `${notCounted.empty} empty` : '',
              notCounted.hidden ? `${notCounted.hidden} hidden` : '',
              stats.unsupported ? `${stats.unsupported} cannot use v2` : '',
            ]
              .filter(Boolean)
              .join(', ')
              .replace(/^(.+)$/, 'Not counted: $1') || 'Datasets left to migrate'
          }
        />
        <Kpi
          label="Median search speed on v2"
          value={stats.median == null ? EMPTY_CELL_PLACEHOLDER : changeText(stats.median)}
          note={n ? `${stats.faster} of ${n} measured Datasets are faster` : 'No Datasets measured yet'}
        />
        <Kpi
          label="Benchmark search time"
          value={n ? `${seconds(stats.v1Total)} → ${seconds(stats.v2Total)}` : EMPTY_CELL_PLACEHOLDER}
          note={n ? `Total across ${n} measured Dataset${n === 1 ? '' : 's'}, v1 then v2` : 'No Datasets measured yet'}
        />

        <div className="span-12">
          <Card>
            <Card.Header>
              <Card.Title>Migration progress</Card.Title>
            </Card.Header>
            <Card.Content>
              <div className="progress">
                <div
                  className="meter"
                  role="progressbar"
                  aria-label="Datasets migrated to v2"
                  aria-valuemin={0}
                  aria-valuemax={stats.total}
                  aria-valuenow={stats.onV2}
                >
                  <div className="meter-fill" style={{ width: `${stats.share * 100}%` }} />
                </div>
                <Text color="subtle">{blank ? ' ' : `${stats.onV2} on v2 · ${stats.onV1} on v1`}</Text>
              </div>
            </Card.Content>
          </Card>
        </div>

        <div className="span-12 table-stack">
          <Text as="h2" variant="heading-sm">
            Search speed by Dataset
          </Text>
          {!isLoading && n === 0 ? (
            <EmptyState
              theme={theme}
              title="No search speed measured yet"
              description="Migrate a Dataset with “Measure search speed before and after” on, and its result appears here."
            >
              <Button onClick={onOpenDatasets}>Go to Datasets</Button>
            </EmptyState>
          ) : (
            <Table aria-label="Search speed by Dataset" columns={columns} visibleColumns={['id', 'v1', 'v2', 'change', 'events', 'range']} items={rows} isLoading={blank} />
          )}
          <Text color="subtle" variant="body-sm-normal">
            Search speed is the run time of one fixed search, a count of the events in each Dataset's chosen time range, taking the faster of
            two runs on v1 just before migration and on v2 just after. Other kinds of search may gain more or less, and
            results vary with load. Not included: Cribl's system Datasets, empty Datasets (no stored data, or no events found when analyzed), and Datasets hidden on the Datasets page.
          </Text>
        </div>
      </div>
    </>
  );
}

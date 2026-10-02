// What a Lake Dataset looks like on v1 vs v2, and how to move between them.
// Defaults mirror the Cribl Search UI (Dataset > Type: v2 > Datatypes table).

import type { DataPathFormat, Datatype, LakeDataset, LakeSearchConfig, PathFilter, SearchVersion } from './api';

export type FormatRow = 'ndjson' | 'parquet' | 'journal';

export const FORMAT_ROWS: Record<FormatRow, { label: string; defaultDatatypeId: string; filter: string }> = {
  ndjson: { label: 'JSON', defaultDatatypeId: 'generic_ndjson', filter: '**/*.json.gz' },
  parquet: { label: 'Parquet', defaultDatatypeId: 'cribl_lake_parquet', filter: '**/*.parquet' },
  journal: {
    label: 'Splunk DDSS',
    defaultDatatypeId: 'splunk_journal',
    filter: '**/{journal,journal.zst,journal.gz,journal.lz4}',
  },
};

export function searchVersionOf(dataset: LakeDataset): SearchVersion {
  return dataset.searchConfig?.searchVersion === 'v2' ? 'v2' : 'v1';
}

/** The Datatypes row a Dataset always has, from its storage format. `null` = v2 not supported. */
export function primaryRow(dataset: LakeDataset): FormatRow | null {
  switch (dataset.format ?? 'json') {
    case 'json':
      return 'ndjson';
    case 'parquet':
      return 'parquet';
    case 'ddss':
      return 'journal';
    default:
      return null;
  }
}

/** JSON and Parquet Datasets can add a second row for the other format; DDSS cannot. */
export function secondaryRow(dataset: LakeDataset): FormatRow | null {
  const primary = primaryRow(dataset);
  if (primary === 'ndjson') return 'parquet';
  if (primary === 'parquet') return 'ndjson';
  return null;
}

/** v2 federated search can't use Datatypes with these options, so the Cribl UI hides them too. */
const isPlain = (d: Datatype) => !d.additionalExtractions?.length && !d.schemaMap?.length && !d.addFields?.length;

export function eligibleDatatypes(datatypes: Datatype[], row: FormatRow): Datatype[] {
  const dataFormat = row === 'journal' ? 'splunk_journal' : row;
  return datatypes.filter((d) => d.dataFormat === dataFormat && isPlain(d));
}

function rowOfFilter(filter: PathFilter, dataset: LakeDataset): FormatRow {
  if (primaryRow(dataset) === 'journal') return 'journal';
  return filter.dataPathFormat === 'parquet' ? 'parquet' : 'ndjson';
}

/** Datatype ID per format row currently saved on a v2 Dataset. */
export function currentRows(dataset: LakeDataset): Partial<Record<FormatRow, string>> {
  const rows: Partial<Record<FormatRow, string>> = {};
  for (const f of dataset.searchConfig?.pathFilters ?? []) rows[rowOfFilter(f, dataset)] = f.dataTypeId;
  return rows;
}

export type Plan = {
  /** Datatype ID for the Dataset's own storage format. */
  primaryId: string;
  /** Datatype ID for the optional second format row; `null` = row not added. */
  secondaryId: string | null;
};

export function toPathFilters(dataset: LakeDataset, plan: Plan): PathFilter[] {
  const primary = primaryRow(dataset);
  if (!primary) throw new Error(`Storage format "${dataset.format}" does not support v2.`);
  const existing = dataset.searchConfig?.pathFilters ?? [];
  const build = (row: FormatRow, dataTypeId: string): PathFilter => {
    // Keep a filter glob someone already customized; otherwise use the Cribl default.
    const prior = existing.find((f) => rowOfFilter(f, dataset) === row);
    const filter = prior?.filter?.trim() ? prior.filter : FORMAT_ROWS[row].filter;
    return row === 'journal' ? { filter, dataTypeId } : { filter, dataTypeId, dataPathFormat: row as DataPathFormat };
  };
  const filters = [build(primary, plan.primaryId)];
  const secondary = secondaryRow(dataset);
  if (secondary && plan.secondaryId) filters.push(build(secondary, plan.secondaryId));
  return filters;
}

export const toV2 =
  (dataset: LakeDataset, plan: Plan) =>
  (current: LakeSearchConfig): LakeSearchConfig => ({
    ...current,
    searchVersion: 'v2',
    pathFilters: toPathFilters({ ...dataset, searchConfig: current }, plan),
  });

/** v1 Datatypes stay on the Dataset while it is on v2, so reverting only flips the type back. */
export const toV1 = (current: LakeSearchConfig): LakeSearchConfig => {
  const { pathFilters: _dropped, ...rest } = current;
  return { ...rest, searchVersion: 'v1' };
};

/**
 * Why a Dataset should not count as migration work, or `null` if it should.
 *  - `no-data`: Cribl Lake reports nothing stored (or only a size snapshot older than the retention period).
 *  - `no-events`: a sample analysis found no events.
 * A sample analysis that did find events overrides the Lake snapshot, which is daily and can lag.
 */
export function emptyReason(
  dataset: LakeDataset,
  analyzedEmpty: boolean,
  sampledEvents: number | undefined,
): 'no-data' | 'no-events' | null {
  if (analyzedEmpty) return 'no-events';
  if (sampledEvents) return null;
  const { currentSizeBytes, metricsDate } = dataset.metrics ?? {};
  if (!currentSizeBytes) return 'no-data';
  const snapshotAgeDays = metricsDate ? (Date.now() - Date.parse(metricsDate)) / 86_400_000 : 0;
  // Allow a day of slack: the snapshot is taken once a day.
  if (dataset.retentionPeriodInDays && snapshotAgeDays > dataset.retentionPeriodInDays + 1) return 'no-data';
  return null;
}

/** Stored size in GB for display, or `null` when Cribl Lake reports none. */
export function sizeGb(dataset: LakeDataset): string | null {
  const bytes = dataset.metrics?.currentSizeBytes;
  if (!bytes) return null;
  const gb = bytes / 1e9;
  return gb < 0.01 ? '<0.01' : gb.toFixed(2);
}

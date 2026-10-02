// Picks a v2 Datatype ID for a Lake Dataset's JSON row.
//
// Evidence, strongest first:
//   1. sampled events already carry a `datatype` value that is a v2 Datatype ID
//   2. a custom Datatype has the same ID as the Dataset
//   3. the Datatype's timestamp anchor/field shows up in the sampled events
//   4. Dataset name, description, or sampled sourcetypes share a distinctive word with the Datatype
// A name match alone (4) only makes a Datatype a candidate: a wrong specific Datatype parses
// timestamps wrongly, so it must be backed by 1-3 before it replaces the Cribl default (generic_ndjson).

import type { Datatype, LakeDataset, SearchEvent } from './api';
import { FORMAT_ROWS } from './migration';

export type Confidence = 'high' | 'medium' | 'default';

export type Candidate = { id: string; score: number; reasons: string[]; /** Backed by more than a name match. */ corroborated: boolean };

export type Recommendation = {
  datatypeId: string;
  confidence: Confidence;
  reasons: string[];
  /** Other Datatypes with some evidence, best first. */
  candidates: Candidate[];
};

export type Sample = {
  eventCount: number;
  /** `datatype` field values seen, with event counts. */
  datatypeValues: Record<string, number>;
  sourcetypes: Record<string, number>;
  /** Event payloads: `_raw` parsed as JSON where possible, else the event itself. */
  payloads: Record<string, unknown>[];
  raws: string[];
};

export function summarizeSample(events: SearchEvent[]): Sample {
  const sample: Sample = { eventCount: events.length, datatypeValues: {}, sourcetypes: {}, payloads: [], raws: [] };
  const bump = (counts: Record<string, number>, value: unknown) => {
    if (typeof value === 'string' && value) counts[value] = (counts[value] ?? 0) + 1;
  };
  for (const event of events) {
    bump(sample.datatypeValues, event.datatype);
    bump(sample.sourcetypes, event.sourcetype);
    const raw = typeof event._raw === 'string' ? event._raw : JSON.stringify(event);
    sample.raws.push(raw);
    let payload: Record<string, unknown> = event;
    if (typeof event._raw === 'string') {
      try {
        const parsed: unknown = JSON.parse(event._raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) payload = parsed as Record<string, unknown>;
      } catch {
        /* _raw is not JSON — judge the event by its top-level fields */
      }
    }
    sample.payloads.push(payload);
  }
  return sample;
}

// Words too common across Datatypes and Dataset names to count as a match.
const STOP_WORDS = new Set([
  'log', 'logs', 'json', 'ndjson', 'data', 'test', 'event', 'events', 'audit', 'cribl', 'generic', 'the', 'and',
  'raw', 'csv', 'rest', 'api', 'access', 'activity', 'stream', 'system', 'default', 'security', 'alert', 'alerts',
  'users', 'user', 'devices', 'main', 'prod', 'dev', 'lake', 'dataset', 'schema', 'syslog', 'network', 'firewall',
]);

function tokens(...texts: (string | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const text of texts) {
    for (const t of (text ?? '').toLowerCase().split(/[^a-z0-9]+/)) {
      if (t.length >= 3 && !STOP_WORDS.has(t) && !/^v?\d+$/.test(t)) out.add(t);
    }
  }
  return out;
}

/** Datatype anchors are stored as "/pattern/flags" strings. */
function parseRegex(literal: string | undefined): RegExp | null {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(literal ?? '');
  if (!m || m[1] === '^' || m[1] === '') return null;
  try {
    return new RegExp(m[1], m[2]);
  } catch {
    return null;
  }
}

/** How a Datatype finds its timestamp, as a test we can run against a sampled event. */
type TimeSignal = { key: string; label: string; test: (raw: string, payload: Record<string, unknown>) => boolean };

function timeSignal(datatype: Datatype): TimeSignal | null {
  const { sourceField, anchorRegex } = datatype.timestampExtraction ?? {};
  // Every event Cribl Stream writes to Lake has _time, so it says nothing about the Datatype.
  if (sourceField && sourceField !== '_raw') {
    if (sourceField === '_time') return null;
    return { key: `field:${sourceField}`, label: `field "${sourceField}"`, test: (_raw, payload) => sourceField in payload };
  }
  const regex = parseRegex(anchorRegex);
  if (!regex || /"_time"/.test(regex.source)) return null;
  return { key: `anchor:${anchorRegex}`, label: `timestamp anchor ${anchorRegex}`, test: (raw) => regex.test(raw) };
}

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function recommendJsonDatatype(dataset: LakeDataset, eligible: Datatype[], sample?: Sample): Recommendation {
  const fallback = FORMAT_ROWS.ndjson.defaultDatatypeId;
  const datasetTokens = tokens(dataset.id, dataset.description, ...Object.keys(sample?.sourcetypes ?? {}));

  const signals = new Map<string, TimeSignal | null>();
  const signalUse: Record<string, number> = {};
  for (const d of eligible) {
    const s = timeSignal(d);
    signals.set(d.id, s);
    if (s) signalUse[s.key] = (signalUse[s.key] ?? 0) + 1;
  }

  const candidates: Candidate[] = [];
  for (const d of eligible) {
    if (d.id === fallback) continue;
    let score = 0;
    let corroborated = false;
    const reasons: string[] = [];

    if (sample?.eventCount) {
      const share = (sample.datatypeValues[d.id] ?? 0) / sample.eventCount;
      if (share > 0) {
        score += share * 70;
        corroborated = true;
        reasons.push(`${pct(share)} of sampled events already have datatype="${d.id}"`);
      }
      const signal = signals.get(d.id);
      if (signal) {
        const hits = sample.raws.filter((raw, i) => signal.test(raw, sample.payloads[i])).length;
        const hitShare = hits / sample.eventCount;
        if (hitShare >= 0.8) {
          const shared = signalUse[signal.key] - 1;
          score += 10 + 30 / signalUse[signal.key];
          corroborated = true;
          reasons.push(
            `Its ${signal.label} is present in ${pct(hitShare)} of sampled events` +
              (shared ? ` (${shared} other Datatype${shared === 1 ? ' uses' : 's use'} the same one)` : ''),
          );
        }
      }
    }

    if (d.id.toLowerCase() === dataset.id.toLowerCase()) {
      score += 70;
      corroborated = true;
      reasons.push('Its ID is the same as the Dataset ID');
    } else {
      const shared = [...tokens(d.id, d.tags)].filter((t) => datasetTokens.has(t));
      if (shared.length) {
        score += Math.min(50, shared.length * 25);
        reasons.push(`Shares "${shared.join('", "')}" with the Dataset name, description, or sourcetype`);
      }
    }

    if (score > 0) candidates.push({ id: d.id, score: Math.round(score), reasons, corroborated });
  }
  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  const best = candidates.find((c) => c.corroborated && c.score >= 40);
  if (best) {
    return {
      datatypeId: best.id,
      confidence: best.score >= 70 ? 'high' : 'medium',
      reasons: best.reasons,
      candidates: candidates.filter((c) => c !== best).slice(0, 5),
    };
  }
  return {
    datatypeId: fallback,
    confidence: 'default',
    reasons: [
      sample?.eventCount
        ? 'No specific Datatype matched the sampled events, so this is the Cribl default for JSON data.'
        : sample
          ? 'The sample search found no events to compare, so this is the Cribl default for JSON data.'
          : 'This is the Cribl default for JSON data. Analyze sample events to check for a more specific Datatype.',
    ],
    candidates: candidates.slice(0, 5),
  };
}

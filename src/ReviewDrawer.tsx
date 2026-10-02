import { useState } from 'react';
import { Alert, Button, Checkbox, Drawer, Link, Pill, SelectField, Text } from '@capra/core';
import type { Benchmark, Datatype, EmptyResults, LakeDataset, Verification } from './api';
import { eligibleDatatypes, FORMAT_ROWS, primaryRow, searchVersionOf, secondaryRow, type FormatRow, type Plan } from './migration';
import { CreateDatatypeForm } from './CreateDatatypeForm';
import type { Recommendation, Sample } from './recommend';
import { describeSpeed, describeTiming } from './speed';

const TIME_RANGES = [
  { id: '-24h', label: 'Last 24 hours' },
  { id: '-7d', label: 'Last 7 days' },
  { id: '-30d', label: 'Last 30 days' },
];

const CONFIDENCE: Record<Recommendation['confidence'], { label: string; appearance: 'success' | 'info' | 'default' }> = {
  high: { label: 'Strong match', appearance: 'success' },
  medium: { label: 'Possible match', appearance: 'info' },
  default: { label: 'Cribl default', appearance: 'default' },
};

type Props = {
  dataset: LakeDataset | null;
  datatypes: Datatype[];
  plan: Plan | null;
  /** Whether `plan` differs from what is saved on a v2 Dataset. */
  isDirty: boolean;
  recommendation?: Recommendation;
  sample?: Sample;
  isAnalyzing: boolean;
  analysisError?: string;
  /** Timings of the benchmark search on each engine, if measured. */
  benchmark?: Benchmark;
  isMeasuring: boolean;
  /** Set aside by the user so it doesn't clutter the migration list. */
  isHidden: boolean;
  /** Set when the last analysis of this Dataset found no events, including in an earlier session. */
  emptyResult?: EmptyResults[string];
  onToggleHidden: () => void;
  onMeasure: () => void;
  /** Latest test-search result for this Dataset. Run automatically after a migration, or on demand. */
  verification?: Verification;
  onVerify: () => void;
  onClose: () => void;
  onPlanChange: (change: Partial<Plan>) => void;
  onAnalyze: (earliest: string) => void;
  /** A custom Datatype was created for this Dataset; reload the list and select it. */
  onDatatypeCreated: (id: string) => void;
  onMigrate: () => void;
  onRevert: () => void;
};

function topValues(counts: Record<string, number>): string {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return 'none';
  return entries
    .slice(0, 4)
    .map(([value, n]) => `${value} (${n})`)
    .join(', ');
}

export function ReviewDrawer(props: Props) {
  const { dataset, datatypes, plan, recommendation, sample } = props;
  const [earliest, setEarliest] = useState('-24h');
  const [creatingFor, setCreatingFor] = useState<string | null>(null);

  if (!dataset || !plan) return <Drawer isOpen={false} onClose={props.onClose} title="Review Dataset" />;

  const version = searchVersionOf(dataset);
  const primary = primaryRow(dataset);
  const secondary = secondaryRow(dataset);
  const v1Datatypes = dataset.searchConfig?.datatypes ?? [];
  const verify = props.verification ?? null;
  const isCreating = creatingFor === dataset.id;
  const sampleFields = [...new Set((sample?.payloads ?? []).slice(0, 10).flatMap((p) => Object.keys(p)))].slice(0, 30);

  const datatypeSelect = (row: FormatRow, value: string, onChange: (id: string) => void) => {
    const options = eligibleDatatypes(datatypes, row).map((d) => ({ id: d.id, label: d.id }));
    // Keep a saved Datatype selectable even if it is no longer eligible, so it isn't silently swapped.
    if (!options.some((o) => o.id === value)) options.unshift({ id: value, label: value });
    return (
      <SelectField
        label={`${FORMAT_ROWS[row].label} Datatype ID`}
        items={options}
        value={value}
        onChange={(key) => key != null && onChange(String(key))}
        canSearch
        searchPlaceholder="Search Datatypes"
      >
        {(item) => (
          <SelectField.Item id={item.id} textValue={item.label}>
            {item.label}
          </SelectField.Item>
        )}
      </SelectField>
    );
  };

  const footer = (
    <div className="drawer-footer">
      {version === 'v2' ? (
        <>
          <Button onClick={props.onRevert}>Revert to v1</Button>
          <Button variant="primary" disabled={!props.isDirty} onClick={props.onMigrate}>
            Save Datatypes
          </Button>
        </>
      ) : (
        <>
          <Button onClick={props.onClose}>Cancel</Button>
          <Button variant="primary" disabled={!primary} onClick={props.onMigrate}>
            Migrate to v2
          </Button>
        </>
      )}
    </div>
  );

  return (
    <Drawer isOpen onClose={props.onClose} title={dataset.id} width={560} footer={footer}>
      <div className="drawer-body">
        <dl className="facts">
          <dt>
            <Text color="subtle">Search type</Text>
          </dt>
          <dd>
            <Pill variant="muted" appearance={version === 'v2' ? 'success' : 'warning'} inline>
              {version}
            </Pill>
          </dd>
          <dt>
            <Text color="subtle">Storage format</Text>
          </dt>
          <dd>
            <Text>{primary ? FORMAT_ROWS[primary].label : (dataset.format ?? 'Unknown')}</Text>
          </dd>
          <dt>
            <Text color="subtle">v1 Datatypes</Text>
          </dt>
          <dd>
            <Text>{v1Datatypes.length ? v1Datatypes.join(', ') : 'Default rulesets'}</Text>
          </dd>
        </dl>

        {!primary && (
          <Alert appearance="warning" title="v2 is not available for this Dataset">
            {`Datasets stored as "${dataset.format}" can't use v2 Datatypes yet. Leave this Dataset on v1.`}
          </Alert>
        )}

        {primary === 'ndjson' && (
          <section className="drawer-section">
            <Text as="h3" variant="heading-xs">
              Find the right Datatype
            </Text>
            <Text color="subtle">
              Runs a search for 50 events from this Dataset and compares them with every eligible v2 Datatype.
            </Text>
            <div className="analyze-row">
              <SelectField
                label="Time range"
                items={TIME_RANGES}
                value={earliest}
                onChange={(key) => key != null && setEarliest(String(key))}
              />
              <Button pending={props.isAnalyzing} onClick={() => props.onAnalyze(earliest)}>
                {sample ? 'Analyze again' : 'Analyze sample events'}
              </Button>
            </div>
            {props.analysisError && (
              <Alert appearance="danger" title="Analysis failed">
                {props.analysisError}
              </Alert>
            )}
            {!sample && props.emptyResult && (
              <Alert appearance="warning" title="No events found last time">
                {`An analysis on ${new Date(props.emptyResult.at).toLocaleDateString()} found no events (${
                  TIME_RANGES.find((r) => r.id === props.emptyResult?.earliest)?.label.toLowerCase() ?? 'selected range'
                }), so this Dataset is not counted in migration progress. Analyze again to recheck.`}
              </Alert>
            )}
            {sample && sample.eventCount === 0 && (
              <Alert
                appearance="warning"
                title="No events found"
                action={props.isHidden ? undefined : { label: 'Hide this Dataset', onClick: props.onToggleHidden }}
              >
                The search returned no events in this time range, so this Dataset is no longer counted in migration
                progress. Try a longer range, pick the Datatype yourself, or hide it to keep it out of the list.
              </Alert>
            )}
            {sample && sample.eventCount > 0 && (
              <dl className="facts">
                <dt>
                  <Text color="subtle">Events sampled</Text>
                </dt>
                <dd>
                  <Text>{String(sample.eventCount)}</Text>
                </dd>
                <dt>
                  <Text color="subtle">Current datatype values</Text>
                </dt>
                <dd>
                  <Text>{topValues(sample.datatypeValues)}</Text>
                </dd>
                <dt>
                  <Text color="subtle">Sourcetypes</Text>
                </dt>
                <dd>
                  <Text>{topValues(sample.sourcetypes)}</Text>
                </dd>
              </dl>
            )}
          </section>
        )}

        {primary && (
          <section className="drawer-section">
            <Text as="h3" variant="heading-xs">
              v2 Datatypes
            </Text>
            {datatypeSelect(primary, plan.primaryId, (id) => props.onPlanChange({ primaryId: id }))}

            {recommendation && (
              <div className="recommendation">
                <div className="recommendation-head">
                  <Text variant="body-sm-semibold">{`Recommended: ${recommendation.datatypeId}`}</Text>
                  <Pill variant="muted" appearance={CONFIDENCE[recommendation.confidence].appearance} inline>
                    {CONFIDENCE[recommendation.confidence].label}
                  </Pill>
                </div>
                <ul className="reasons">
                  {recommendation.reasons.map((r) => (
                    <li key={r}>
                      <Text variant="body-sm-normal">{r}</Text>
                    </li>
                  ))}
                </ul>
                {plan.primaryId !== recommendation.datatypeId && (
                  <div>
                    <Button size="sm" onClick={() => props.onPlanChange({ primaryId: recommendation.datatypeId })}>
                      Use recommended
                    </Button>
                  </div>
                )}
                {recommendation.candidates.length > 0 && (
                  <>
                    <Text variant="body-sm-semibold">Other candidates</Text>
                    <ul className="reasons">
                      {recommendation.candidates.map((c) => (
                        <li key={c.id}>
                          <Text variant="body-sm-normal">{`${c.id}: ${c.reasons.join('; ')}`}</Text>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </div>
            )}

            {primary === 'ndjson' &&
              (isCreating ? (
                <CreateDatatypeForm
                  suggestedId={dataset.id}
                  existingIds={new Set(datatypes.map((d) => d.id))}
                  sampleFields={sampleFields}
                  onCancel={() => setCreatingFor(null)}
                  onCreated={(id) => {
                    setCreatingFor(null);
                    props.onDatatypeCreated(id);
                  }}
                />
              ) : (
                <div className="create-prompt">
                  <Text color="subtle" variant="body-sm-normal">
                    No existing Datatype reads this Dataset's timestamps correctly?
                  </Text>
                  <Button onClick={() => setCreatingFor(dataset.id)}>Create a Datatype</Button>
                </div>
              ))}

            {secondary && (
              <>
                <Checkbox
                  checked={plan.secondaryId != null}
                  onChange={(e) =>
                    props.onPlanChange({ secondaryId: e.target.checked ? FORMAT_ROWS[secondary].defaultDatatypeId : null })
                  }
                >
                  {`Also read ${FORMAT_ROWS[secondary].label} data in this Dataset`}
                </Checkbox>
                {plan.secondaryId != null &&
                  datatypeSelect(secondary, plan.secondaryId, (id) => props.onPlanChange({ secondaryId: id }))}
              </>
            )}
          </section>
        )}

        {version === 'v2' && (
          <section className="drawer-section">
            <Text as="h3" variant="heading-xs">
              Verify
            </Text>
            <Text color="subtle">
              Runs automatically after a migration, before search speed is measured. It runs a 10-event search over the
              last 24 hours and checks which engine and datatype values come back. Dataset
              changes can take a moment to apply, so re-run if the result looks stale.
            </Text>
            <div>
              <Button pending={verify?.state === 'running'} onClick={props.onVerify}>
                Run test search
              </Button>
            </div>
            {verify?.state === 'error' && (
              <Alert appearance="danger" title="Test search failed">
                {verify.message}
              </Alert>
            )}
            {verify?.state === 'done' && verify.eventCount === 0 && (
              <Alert appearance="warning" title="No events returned">
                {`The search ran on ${verify.computeType ?? 'an unknown engine'} but found no events in the last 24 hours, so the Datatype could not be checked.`}
              </Alert>
            )}
            {verify?.state === 'done' && verify.eventCount > 0 && (
              <Alert
                appearance={verify.computeType === 'v2' && verify.datatypes.length ? 'success' : 'warning'}
                title={verify.computeType === 'v2' ? 'Search ran on v2' : `Search ran on ${verify.computeType ?? 'an unknown engine'}`}
              >
                {verify.datatypes.length
                  ? `${verify.eventCount} events returned with datatype: ${verify.datatypes.join(', ')}.`
                  : `${verify.eventCount} events returned, but none has a datatype field. The selected Datatype may not match this data.`}
              </Alert>
            )}
          </section>
        )}

        {primary && (version === 'v2' || props.benchmark?.v1 || props.isMeasuring) && (
          <section className="drawer-section">
            <Text as="h3" variant="heading-xs">
              Search speed
            </Text>
            <Text color="subtle">
              The run time of a count of the last 24 hours of events, keeping the faster of two runs. v1 is measured
              automatically when you migrate, and v2 just after.
            </Text>
            {(props.benchmark?.v1 || props.benchmark?.v2) && (
              <dl className="facts">
                {props.benchmark.v1 && (
                  <>
                    <dt>
                      <Text color="subtle">v1</Text>
                    </dt>
                    <dd>
                      <Text>{describeTiming(props.benchmark.v1)}</Text>
                    </dd>
                  </>
                )}
                {props.benchmark.v2 && (
                  <>
                    <dt>
                      <Text color="subtle">v2</Text>
                    </dt>
                    <dd>
                      <Text>{describeTiming(props.benchmark.v2)}</Text>
                    </dd>
                  </>
                )}
                {props.benchmark.v1 && props.benchmark.v2 && (
                  <>
                    <dt>
                      <Text color="subtle">Change</Text>
                    </dt>
                    <dd>
                      <Text variant="body-md-semibold">{describeSpeed(props.benchmark)}</Text>
                    </dd>
                  </>
                )}
              </dl>
            )}
            {version === 'v2' ? (
              <div>
                <Button pending={props.isMeasuring} onClick={props.onMeasure}>
                  Measure v2 again
                </Button>
              </div>
            ) : (
              props.isMeasuring && <Text color="subtle">Measuring v1…</Text>
            )}
          </section>
        )}

        <div>
          <Button variant="tertiary" onClick={props.onToggleHidden}>
            {props.isHidden ? 'Unhide this Dataset' : 'Hide this Dataset from the list'}
          </Button>
        </div>

        <Link href="https://docs.cribl.io/search/federated-v2" isExternal>
          How v2 Datasets work
        </Link>
      </div>
    </Drawer>
  );
}

import { useState } from 'react';
import { Alert, Button, Radio, RadioGroup, Text, TextField } from '@capra/core';
import { createDatatype, type Datatype } from './api';

type TimeSource = 'time' | 'field';

type Props = {
  /** Suggested ID for the new Datatype. */
  suggestedId: string;
  /** IDs already taken, stock and custom. */
  existingIds: Set<string>;
  /** Field names seen in the sampled events, to help pick a timestamp field. */
  sampleFields: string[];
  onCreated: (id: string) => void;
  onCancel: () => void;
};

// Every existing Datatype ID uses only these characters, so stay within them.
const ID_PATTERN = /^[a-zA-Z0-9_]+$/;

/**
 * A v2 Datatype for a Lake JSON row can only vary in how it finds the timestamp: v2 federated
 * search does not allow extra extractions, schema maps, or added fields. So that is all this asks.
 */
function buildDatatype(id: string, description: string, source: TimeSource, field: string, format: string, timezone: string): Datatype {
  const bounds = { timezone: timezone || 'UTC', earliest: '0', latest: '+10years' };
  let timestampExtraction: Record<string, unknown>;
  if (source === 'time') {
    // Events written to Lake by Cribl Stream carry _time as epoch seconds.
    timestampExtraction = { type: 'manual', sourceField: '_time', format: '%s', ...bounds, timezone: 'UTC' };
  } else if (format) {
    timestampExtraction = { type: 'manual', sourceField: field, format, ...bounds };
  } else {
    timestampExtraction = { type: 'auto', sourceField: field, anchorRegex: '/^/', scanDepth: 150, ...bounds };
  }
  return {
    id,
    lib: 'custom',
    ...(description ? { description } : {}),
    dataFormat: 'ndjson',
    // Same shape the Cribl Datatype editor saves for a v2 Datatype.
    searchVersion: 'v2',
    maxEventBytes: 65536,
    automaticExtraction: { extractionType: 'json' },
    timestampExtraction,
  };
}

export function CreateDatatypeForm({ suggestedId, existingIds, sampleFields, onCreated, onCancel }: Props) {
  const [id, setId] = useState(suggestedId.replace(/[^a-zA-Z0-9_]/g, '_'));
  const [description, setDescription] = useState('');
  const [source, setSource] = useState<TimeSource>('time');
  const [field, setField] = useState('');
  const [format, setFormat] = useState('');
  const [timezone, setTimezone] = useState('UTC');
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trimmedId = id.trim();
  let idProblem: string | null = null;
  if (!trimmedId) idProblem = 'Enter an ID.';
  else if (!ID_PATTERN.test(trimmedId)) idProblem = 'Use only letters, numbers, and underscores.';
  else if (existingIds.has(trimmedId)) idProblem = 'A Datatype with this ID already exists. Choose another ID, or select the existing one above.';
  const fieldProblem = source === 'field' && !field.trim() ? 'Enter the field that holds the timestamp.' : null;

  const submit = async () => {
    setIsSaving(true);
    setError(null);
    try {
      await createDatatype(buildDatatype(trimmedId, description.trim(), source, field.trim(), format.trim(), timezone.trim()));
      onCreated(trimmedId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setIsSaving(false);
    }
  };

  return (
    <div className="create-datatype">
      <Text as="h4" variant="body-md-semibold">
        New JSON Datatype
      </Text>
      <Text color="subtle" variant="body-sm-normal">
        Use this when no existing Datatype reads this Dataset's timestamps correctly. The Datatype parses each event as
        JSON and sets the event time as chosen below. For anything more, use the Datatype editor in Cribl Search.
      </Text>

      <TextField label="Datatype ID" value={id} onChange={setId} helperText={idProblem ?? 'Shown as the datatype value on every event.'} />
      <TextField label="Description (optional)" value={description} onChange={setDescription} />

      <RadioGroup
        name="time-source"
        layout="vertical"
        value={source}
        onChange={(e) => setSource(e.target.value as TimeSource)}
      >
        <Radio value="time">Use each event's _time field (data written by Cribl Stream)</Radio>
        <Radio value="field">Read the timestamp from another field</Radio>
      </RadioGroup>

      {source === 'field' && (
        <>
          <TextField
            label="Timestamp field"
            value={field}
            onChange={setField}
            helperText={
              fieldProblem ??
              (sampleFields.length
                ? `Fields in the sampled events: ${sampleFields.join(', ')}`
                : 'Analyze sample events to see the fields in this Dataset.')
            }
          />
          <TextField
            label="Timestamp format (optional)"
            value={format}
            onChange={setFormat}
            helperText="strptime format, for example %Y-%m-%dT%H:%M:%S.%f%Z or %s for epoch seconds. Leave blank to auto-detect."
          />
          <TextField
            label="Default timezone"
            value={timezone}
            onChange={setTimezone}
            helperText="Applied to timestamps that carry no timezone."
          />
        </>
      )}

      {error && (
        <Alert appearance="danger" title="Could not create the Datatype">
          {error}
        </Alert>
      )}

      <div className="drawer-footer">
        <Button onClick={onCancel} disabled={isSaving}>
          Cancel
        </Button>
        <Button variant="primary" pending={isSaving} disabled={idProblem != null || fieldProblem != null} onClick={() => void submit()}>
          {`Create ${trimmedId && !idProblem ? trimmedId : 'Datatype'}`}
        </Button>
      </div>
    </div>
  );
}

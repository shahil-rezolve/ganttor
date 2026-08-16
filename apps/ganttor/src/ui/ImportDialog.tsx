/**
 * The Jira CSV import wizard: drop → map → preview → import.
 *
 * The preview step is the reason this is a wizard rather than a file input. Jira has no
 * duration field, so a Gantt importer must infer one, and the user gets to see every
 * inference — and the exact column each field was read from — before anything is
 * committed. Nothing about the schedule is invented behind their back.
 */

import { useMemo, useRef, useState } from 'react';

import {
  detectColumns,
  emptyMapping,
  FIELD_SPECS,
  missingRequiredFields,
  valuesOf,
  type ColumnMapping,
  type FieldKey,
} from '../jira/columns.js';
import { needsDayFirstPrompt } from '../jira/dates.js';
import {
  DEFAULT_IMPORT_OPTIONS,
  importJiraRows,
  type ImportOptions,
  type ImportResult,
} from '../jira/import.js';
import { parseCsv, readFileAsText, type ParsedCsv } from '../jira/parse.js';
import { deserializeProject } from '../store/persistence.js';
import { useProjectStore } from '../store/useProjectStore.js';

export interface ImportDialogProps {
  open: boolean;
  onClose: () => void;
}

type Step = 'file' | 'map' | 'preview';

const DURATION_SOURCE_LABELS: Record<string, string> = {
  'both-dates': 'start + due date',
  'original-estimate': 'original estimate',
  'story-points': 'story points',
  'due-date-only': 'due date, default length',
  default: 'default length',
  milestone: 'milestone (zero)',
};

export function ImportDialog({ open, onClose }: ImportDialogProps) {
  const loadProjectDocument = useProjectStore((s) => s.loadProjectDocument);
  const resetToDemo = useProjectStore((s) => s.resetToDemo);

  const [step, setStep] = useState<Step>('file');
  const [csv, setCsv] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>(emptyMapping);
  const [options, setOptions] = useState<ImportOptions>(DEFAULT_IMPORT_OPTIONS);
  const [fileName, setFileName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const result: ImportResult | null = useMemo(() => {
    if (!csv || step !== 'preview') return null;
    return importJiraRows(csv.rows, mapping, {
      ...options,
      projectName: fileName.replace(/\.csv$/i, '') || 'Imported from Jira',
    });
  }, [csv, mapping, options, step, fileName]);

  const missing = csv ? missingRequiredFields(mapping) : [];

  /** Does this file have `nn/nn/nnnn` dates nothing in it can disambiguate? */
  const askDayFirst = useMemo(() => {
    if (!csv) return false;
    const samples: string[] = [];
    for (const row of csv.rows) {
      samples.push(...valuesOf(row, mapping, 'startDate'), ...valuesOf(row, mapping, 'dueDate'));
    }
    return needsDayFirstPrompt(samples);
  }, [csv, mapping]);

  const reset = () => {
    setStep('file');
    setCsv(null);
    setMapping(emptyMapping());
    setOptions(DEFAULT_IMPORT_OPTIONS);
    setFileName('');
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const acceptFile = async (file: File) => {
    setError(null);
    setFileName(file.name);
    try {
      const text = await readFileAsText(file);

      // A .ganttor.json is a project, not an import — accept it here too rather than
      // making the user hunt for a second, near-identical file picker.
      if (/\.json$/i.test(file.name)) {
        loadProjectDocument(deserializeProject(text), `Opened ${file.name}.`);
        close();
        return;
      }

      const parsed = parseCsv(text);
      if (parsed.headers.length === 0 || parsed.rows.length === 0) {
        setError('That file has no data rows.');
        return;
      }
      setCsv(parsed);
      setMapping(detectColumns(parsed.headers));
      setStep('map');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  if (!open) return null;

  return (
    <div
      role="presentation"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(4,6,10,0.62)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 50,
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div className="ganttor-dialog" role="dialog" aria-modal="true" aria-label="Import Jira CSV">
        <div className="ganttor-dialog__head">
          <h2 className="ganttor-dialog__title">
            {step === 'file'
              ? 'Import from Jira'
              : step === 'map'
                ? 'Check the column mapping'
                : 'Review before importing'}
          </h2>
          <button type="button" className="ganttor-btn ganttor-btn--ghost" onClick={close}>
            Close
          </button>
        </div>

        <div className="ganttor-dialog__body">
          {error && (
            <div className="ganttor-notice" data-tone="error">
              <span className="ganttor-notice__message">{error}</span>
            </div>
          )}

          {step === 'file' && (
            <>
              <div
                className="ganttor-drop"
                data-over={dragOver || undefined}
                role="button"
                tabIndex={0}
                onClick={() => fileInput.current?.click()}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') fileInput.current?.click();
                }}
                onDragOver={(event) => {
                  event.preventDefault();
                  setDragOver(true);
                }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(event) => {
                  event.preventDefault();
                  setDragOver(false);
                  const file = event.dataTransfer.files[0];
                  if (file) void acceptFile(file);
                }}
              >
                <strong>Drop a Jira CSV export here</strong>
                <span className="ganttor-field__hint">
                  In Jira: filter your issues, then <em>Export → Export Excel CSV (all
                  fields)</em>. A <code>.ganttor.json</code> project file works here too.
                </span>
              </div>

              <input
                ref={fileInput}
                type="file"
                accept=".csv,text/csv,.json,application/json"
                style={{ display: 'none' }}
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void acceptFile(file);
                }}
              />

              <div className="ganttor-row">
                <button
                  type="button"
                  className="ganttor-btn"
                  onClick={() => {
                    resetToDemo();
                    close();
                  }}
                >
                  Load the sample project instead
                </button>
              </div>
            </>
          )}

          {step === 'map' && csv && (
            <>
              <span className="ganttor-field__hint">
                {csv.headers.length} columns and {csv.rows.length} rows in{' '}
                <strong>{fileName}</strong>. Ganttor guessed the mapping below — correct anything
                it got wrong.
              </span>

              {missing.length > 0 && (
                <div className="ganttor-notice" data-tone="warn">
                  <span className="ganttor-notice__message">
                    Still needed: {missing.map((spec) => spec.label).join(', ')}.
                  </span>
                </div>
              )}

              <div className="ganttor-table__scroll">
                <table className="ganttor-table">
                  <thead>
                    <tr>
                      <th>Ganttor field</th>
                      <th>CSV column</th>
                      <th>What it’s for</th>
                    </tr>
                  </thead>
                  <tbody>
                    {FIELD_SPECS.map((spec) => (
                      <tr key={spec.key}>
                        <td>
                          {spec.label}
                          {spec.required && <span style={{ color: 'var(--gantt-critical)' }}> *</span>}
                        </td>
                        <td>
                          <select
                            className="ganttor-select"
                            aria-label={`Column for ${spec.label}`}
                            value={mapping[spec.key][0] ?? ''}
                            onChange={(event) => {
                              const raw = event.target.value;
                              setMapping((current) =>
                                withField(current, spec.key, raw === '' ? [] : [Number(raw)]),
                              );
                            }}
                          >
                            <option value="">— not mapped —</option>
                            {csv.headers.map((header, index) => (
                              <option key={`${header}-${index}`} value={index}>
                                {header || `(column ${index + 1})`}
                              </option>
                            ))}
                          </select>
                          {spec.multi && mapping[spec.key].length > 1 && (
                            <span className="ganttor-tag" style={{ marginLeft: 5 }}>
                              +{mapping[spec.key].length - 1} more column(s)
                            </span>
                          )}
                        </td>
                        <td className="ganttor-field__hint">{spec.hint}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="ganttor-grid2">
                <label className="ganttor-field">
                  <span className="ganttor-field__label">Days per story point</span>
                  <input
                    type="number"
                    min={0.25}
                    step={0.25}
                    className="ganttor-input ganttor-input--num"
                    value={options.pointsToDays}
                    onChange={(event) =>
                      setOptions((o) => ({
                        ...o,
                        pointsToDays: Math.max(0.25, Number(event.target.value) || 1),
                      }))
                    }
                  />
                  <span className="ganttor-field__hint">
                    Used when an issue has points but no dates.
                  </span>
                </label>

                <label className="ganttor-field">
                  <span className="ganttor-field__label">Default duration (days)</span>
                  <input
                    type="number"
                    min={1}
                    className="ganttor-input ganttor-input--num"
                    value={options.defaultDurationDays}
                    onChange={(event) =>
                      setOptions((o) => ({
                        ...o,
                        defaultDurationDays: Math.max(1, Number(event.target.value) || 1),
                      }))
                    }
                  />
                  <span className="ganttor-field__hint">
                    Used when there is nothing at all to infer from.
                  </span>
                </label>
              </div>

              {askDayFirst && (
                <div className="ganttor-field">
                  <span className="ganttor-field__label">Ambiguous dates</span>
                  <span className="ganttor-field__hint">
                    This export has dates like <code>03/04/2026</code> that could be read either
                    way, and nothing in the file settles it.
                  </span>
                  <div className="ganttor-seg" role="group">
                    <button
                      type="button"
                      className="ganttor-seg__item"
                      aria-pressed={options.dayFirst}
                      onClick={() => setOptions((o) => ({ ...o, dayFirst: true }))}
                    >
                      Day/month (3 April)
                    </button>
                    <button
                      type="button"
                      className="ganttor-seg__item"
                      aria-pressed={!options.dayFirst}
                      onClick={() => setOptions((o) => ({ ...o, dayFirst: false }))}
                    >
                      Month/day (4 March)
                    </button>
                  </div>
                </div>
              )}
            </>
          )}

          {step === 'preview' && result && (
            <>
              <div className="ganttor-grid2">
                <Stat label="Tasks" value={result.stats.tasks} />
                <Stat label="Dependencies" value={result.stats.dependencies} />
                <Stat label="Milestones" value={result.stats.milestones} />
                <Stat label="Summary rows" value={result.stats.summaries} />
                <Stat label="People" value={result.stats.resources} />
                <Stat label="Warnings" value={result.warnings.length} />
              </div>

              <div className="ganttor-section">
                <span className="ganttor-section__title">How each duration was decided</span>
                <span className="ganttor-field__hint">
                  Jira has no duration field, so Ganttor derives one. Nothing here is hidden —
                  every task shows its source.
                </span>
                <div className="ganttor-table__scroll">
                  <table className="ganttor-table">
                    <thead>
                      <tr>
                        <th>Issue</th>
                        <th>Days</th>
                        <th>Derived from</th>
                        <th>Start pinned</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.notes.map((note) => (
                        <tr key={note.taskId}>
                          <td>{note.jiraKey}</td>
                          <td className="num">{note.durationDays}</td>
                          <td>
                            <span className="ganttor-tag">
                              {DURATION_SOURCE_LABELS[note.durationSource] ?? note.durationSource}
                            </span>
                          </td>
                          <td>{note.pinned ? 'yes' : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {result.warnings.length > 0 && (
                <div className="ganttor-section">
                  <span className="ganttor-section__title">
                    Warnings ({result.warnings.length})
                  </span>
                  <div className="ganttor-table__scroll" style={{ maxHeight: 160 }}>
                    <table className="ganttor-table">
                      <tbody>
                        {result.warnings.map((warning, index) => (
                          <tr key={`${warning.kind}-${index}`}>
                            <td>
                              <span className="ganttor-tag ganttor-tag--warn">{warning.kind}</span>
                            </td>
                            <td>{warning.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              <div className="ganttor-notice" data-tone="info">
                <span className="ganttor-notice__message">
                  Importing replaces the project currently open. Export it first if you want to
                  keep it.
                </span>
              </div>
            </>
          )}
        </div>

        <div className="ganttor-dialog__foot">
          {step !== 'file' && (
            <button
              type="button"
              className="ganttor-btn"
              onClick={() => setStep(step === 'preview' ? 'map' : 'file')}
            >
              Back
            </button>
          )}
          <span className="ganttor-bar__spacer" />
          {step === 'map' && (
            <button
              type="button"
              className="ganttor-btn ganttor-btn--primary"
              disabled={missing.length > 0}
              onClick={() => setStep('preview')}
            >
              Preview →
            </button>
          )}
          {step === 'preview' && result && (
            <button
              type="button"
              className="ganttor-btn ganttor-btn--primary"
              onClick={() => {
                loadProjectDocument(
                  result.project,
                  `Imported ${result.stats.tasks} issues and ${result.stats.dependencies} dependencies.`,
                );
                close();
              }}
            >
              Import {result.stats.tasks} tasks
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="ganttor-stat">
      <span className="ganttor-stat__label">{label}</span>
      <span className="ganttor-stat__value">{value}</span>
    </div>
  );
}

/** Replaces one field's columns without disturbing the others. */
function withField(mapping: ColumnMapping, field: FieldKey, columns: number[]): ColumnMapping {
  return { ...mapping, [field]: columns };
}

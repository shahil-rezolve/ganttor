/**
 * CSV text to rows.
 *
 * Papa Parse handles the quoting rules; the job here is to hand back the header row and
 * body separately, keep repeated header names intact (`header: true` would collapse
 * them, losing every multi-value Jira column), and strip the BOM Jira prefixes its
 * exports with.
 */

import Papa from 'papaparse';

export interface ParsedCsv {
  headers: string[];
  rows: string[][];
  /** Papa's row-level complaints, e.g. a ragged row. Advisory, not fatal. */
  errors: string[];
}

export function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<string[]>(text.replace(/^﻿/, ''), {
    header: false,
    skipEmptyLines: 'greedy',
  });

  const all = result.data.filter((row) => Array.isArray(row));
  const [headerRow, ...body] = all;

  return {
    headers: (headerRow ?? []).map((header) => header.trim()),
    // Jira sometimes pads short rows; normalise the width so column indices are safe.
    rows: body.map((row) => padTo(row, headerRow?.length ?? row.length)),
    errors: result.errors.map((error) =>
      error.row === undefined ? error.message : `Row ${error.row + 1}: ${error.message}`,
    ),
  };
}

function padTo(row: string[], width: number): string[] {
  if (row.length >= width) return row;
  return [...row, ...Array.from({ length: width - row.length }, () => '')];
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the file.'));
    reader.readAsText(file);
  });
}

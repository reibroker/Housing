/**
 * Streaming gzip + TSV parsing, done entirely in the browser.
 *
 * Redfin publishes its market tracker as gzipped TSV. The national file is a
 * few MB, but the county and ZIP files are hundreds of MB uncompressed -- far
 * too much to hold in memory as a string, let alone as an array of objects.
 *
 * So we never materialize the whole file. We pipe the response body through
 * DecompressionStream('gzip'), decode it to text incrementally, split on
 * newlines as chunks arrive, and hand each row to a filter callback. Only rows
 * the caller keeps are retained. Peak memory stays proportional to the result
 * set, not the file.
 *
 * DecompressionStream is supported in Chrome 80+, Edge 80+, Safari 16.4+ and
 * Firefox 113+. We feature-detect and report a clear message rather than
 * failing cryptically on an old browser.
 */

export const HAS_DECOMPRESSION_STREAM = typeof globalThis.DecompressionStream === 'function';

export class ParseError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'ParseError';
    this.cause = cause;
  }
}

/**
 * Parse a gzipped-or-plain TSV ReadableStream row by row.
 *
 * @param {ReadableStream<Uint8Array>} stream
 * @param {object} opts
 * @param {boolean} opts.gzipped        Pipe through DecompressionStream first.
 * @param {(row:object, index:number)=>boolean} opts.filter
 *        Return true to keep the row. Defaults to keeping everything.
 * @param {string[]} [opts.columns]     If given, only these columns are copied
 *        into each row object -- a large memory saving on wide files.
 * @param {(info:{rows:number, bytes:number, kept:number})=>void} [opts.onProgress]
 * @param {number} [opts.maxRows]       Safety valve; stop after this many rows.
 * @returns {Promise<{rows:object[], header:string[], totalRows:number, bytes:number}>}
 */
export async function parseTsvStream(stream, opts = {}) {
  const { gzipped = false, filter = () => true, columns = null, onProgress, maxRows = 5_000_000 } = opts;

  let source = stream;
  if (gzipped) {
    if (!HAS_DECOMPRESSION_STREAM) {
      throw new ParseError(
        'This browser cannot gunzip in-page (DecompressionStream is unavailable). ' +
          'Use a current version of Chrome, Edge, Firefox 113+ or Safari 16.4+, or decompress the file before uploading it.'
      );
    }
    try {
      source = stream.pipeThrough(new DecompressionStream('gzip'));
    } catch (e) {
      throw new ParseError('Failed to start gzip decompression. The file may not actually be gzipped.', e);
    }
  }

  const reader = source.pipeThrough(new TextDecoderStream('utf-8')).getReader();

  let header = null;
  let keepIdx = null; // indices of the columns we care about
  const rows = [];
  let buffer = '';
  let totalRows = 0;
  let bytes = 0;
  let lastProgress = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      bytes += value.length;
      buffer += value;

      // Process every complete line currently in the buffer. The trailing
      // partial line stays in `buffer` for the next chunk.
      let nl;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line === '') continue;

        if (header === null) {
          header = line.split('\t').map((h) => h.trim().replace(/^"|"$/g, ''));
          if (columns) {
            keepIdx = columns
              .map((c) => ({ name: c, i: header.indexOf(c) }))
              .filter((x) => x.i !== -1);
            if (keepIdx.length === 0) {
              throw new ParseError(
                `None of the requested columns were found. File header was: ${header.slice(0, 12).join(', ')}...`
              );
            }
          }
          continue;
        }

        const parts = line.split('\t');
        const row = {};
        if (keepIdx) {
          for (const { name, i } of keepIdx) row[name] = unquote(parts[i]);
        } else {
          for (let i = 0; i < header.length; i++) row[header[i]] = unquote(parts[i]);
        }

        totalRows++;
        if (filter(row, totalRows)) rows.push(row);
        if (totalRows >= maxRows) break;
      }

      if (onProgress && bytes - lastProgress > 2_000_000) {
        lastProgress = bytes;
        onProgress({ rows: totalRows, bytes, kept: rows.length });
      }
      if (totalRows >= maxRows) break;
    }

    // Flush any final line that had no trailing newline.
    if (buffer.trim() && header) {
      const parts = buffer.split('\t');
      const row = {};
      if (keepIdx) for (const { name, i } of keepIdx) row[name] = unquote(parts[i]);
      else for (let i = 0; i < header.length; i++) row[header[i]] = unquote(parts[i]);
      totalRows++;
      if (filter(row, totalRows)) rows.push(row);
    }
  } finally {
    // Releasing the lock lets the browser tear down the underlying connection
    // if we bailed out early via maxRows.
    try { reader.releaseLock(); } catch { /* already released */ }
  }

  if (header === null) throw new ParseError('The file appears to be empty -- no header row was found.');

  onProgress?.({ rows: totalRows, bytes, kept: rows.length });
  return { rows, header, totalRows, bytes };
}

function unquote(v) {
  if (v === undefined) return '';
  const t = v.trim();
  return t.length > 1 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/**
 * Minimal CSV parser for the small, well-formed CSVs we read from FRED.
 * Handles quoted fields and embedded commas; not a general-purpose RFC 4180
 * implementation, but correct for these inputs.
 */
export function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) throw new ParseError('Empty CSV response.');

  const splitLine = (line) => {
    const out = [];
    let cur = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { cur += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (ch === ',' && !inQuotes) {
        out.push(cur); cur = '';
      } else {
        cur += ch;
      }
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };

  const header = splitLine(lines[0]);
  const rows = lines.slice(1).map((l) => {
    const parts = splitLine(l);
    const o = {};
    header.forEach((h, i) => { o[h] = parts[i] ?? ''; });
    return o;
  });
  return { header, rows };
}

/** Parse a numeric cell, treating FRED's "." and empty strings as missing. */
export function num(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim().replace(/,/g, '');
  if (s === '' || s === '.' || s === 'NA' || s === 'null' || s === '-') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

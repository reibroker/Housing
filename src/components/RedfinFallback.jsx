/**
 * The CORS escape hatch for Redfin.
 *
 * Redfin's S3 bucket is a data-distribution bucket, not an API, so whether it
 * sends Access-Control-Allow-Origin is entirely up to their bucket policy and
 * can change without notice. Rather than making the whole dashboard depend on
 * someone else's CORS configuration, this component turns a blocked fetch into
 * a two-click recovery: download the file, drop it here.
 *
 * The file never leaves the machine. `File.stream()` feeds the same streaming
 * gunzip + TSV parser used for the network path, so a 200MB file is processed
 * incrementally and the resulting charts are byte-for-byte identical.
 */

import { useCallback, useRef, useState } from 'react';
import { REDFIN_FILES } from '../data/redfin.js';

export default function RedfinFallback({ error, level = 'national', onFile, progress, loading }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef(null);
  const file = REDFIN_FILES[level] || REDFIN_FILES.national;

  const handle = useCallback(
    (f) => {
      if (!f) return;
      if (!/\.(tsv|txt|csv)(\.gz)?$/i.test(f.name)) {
        alert(`"${f.name}" does not look like a Redfin market tracker file. Expected a .tsv000.gz (or an unzipped .tsv).`);
        return;
      }
      onFile(f);
    },
    [onFile]
  );

  return (
    <div>
      {error && (
        <div className="notice error">
          <strong>Redfin data could not be fetched directly</strong>
          <pre>{error.message}</pre>
        </div>
      )}

      <div
        className={`dropzone${over ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true); }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); handle(e.dataTransfer.files?.[0]); }}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click(); }}
        role="button"
        tabIndex={0}
      >
        <strong>Drop the Redfin {file.label} file here</strong>
        <span>
          Or click to browse. Accepts <code>.tsv000.gz</code> straight from Redfin &mdash; it is gunzipped and
          parsed in this browser tab. Nothing is uploaded anywhere.
        </span>
        <input
          ref={inputRef}
          type="file"
          accept=".gz,.tsv,.txt,.csv"
          style={{ display: 'none' }}
          onChange={(e) => handle(e.target.files?.[0])}
        />
      </div>

      {progress && (
        <>
          <div className="progress">
            {/* No total is known up front (the response is streamed and gzipped),
                so this is a live throughput read rather than a percentage. */}
            <div className="progress-fill" style={{ width: `${Math.min(98, (progress.bytes / 60_000_000) * 100)}%` }} />
          </div>
          <p className="card-note" style={{ fontVariantNumeric: 'tabular-nums' }}>
            Parsed {progress.rows.toLocaleString()} rows &middot; kept {progress.kept.toLocaleString()} &middot;{' '}
            {(progress.bytes / 1_048_576).toFixed(1)} MB decompressed
          </p>
        </>
      )}

      {loading && !progress && <p className="card-note">Working&hellip;</p>}

      <p className="card-note">
        Direct link: <code>{file.url}</code> (~{file.approxMB} MB compressed)
      </p>
    </div>
  );
}

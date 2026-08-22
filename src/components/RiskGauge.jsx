/**
 * The headline gauge.
 *
 * Deliberately NOT a rainbow arc. A multi-hue arc double-encodes the value as
 * both angle and hue and makes every reading look like a traffic light, which
 * over-dramatizes small moves. Instead: a recessive track, one filled arc in the
 * current band's status color, and the number itself as the hero. The band is
 * always named in text beside a colored dot, so the state never depends on color
 * alone -- which is also what makes it readable for colorblind users and in
 * forced-colors mode.
 */

import { RISK_BANDS } from '../model/riskModel.js';

const BAND_COLOR = {
  low: 'var(--good)',
  moderate: 'var(--good)',
  elevated: 'var(--warning)',
  high: 'var(--serious)',
  severe: 'var(--critical)',
};

/** Point on the gauge arc for a 0-100 value. 180 deg sweep, left to right. */
function polar(cx, cy, r, value) {
  const angle = Math.PI - (Math.max(0, Math.min(100, value)) / 100) * Math.PI;
  return { x: cx + r * Math.cos(angle), y: cy - r * Math.sin(angle) };
}

function arcPath(cx, cy, r, from, to) {
  const a = polar(cx, cy, r, from);
  const b = polar(cx, cy, r, to);
  const large = Math.abs(to - from) > 50 ? 1 : 0;
  return `M ${a.x.toFixed(2)} ${a.y.toFixed(2)} A ${r} ${r} 0 ${large} 1 ${b.x.toFixed(2)} ${b.y.toFixed(2)}`;
}

export default function RiskGauge({ score, band, coverage, available, total }) {
  const W = 340;
  const H = 196;
  const cx = W / 2;
  const cy = 168;
  const r = 132;
  const stroke = 14;

  const hasScore = Number.isFinite(score);
  const color = band ? BAND_COLOR[band.tone] : 'var(--text-muted)';
  const marker = hasScore ? polar(cx, cy, r, score) : null;

  return (
    <div className="gauge-figure">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        style={{ maxWidth: W, display: 'block', margin: '0 auto' }}
        role="img"
        aria-label={
          hasScore
            ? `Housing price-decline pressure score ${score.toFixed(0)} out of 100, band: ${band?.label}.`
            : 'Score unavailable.'
        }
      >
        {/* Recessive track. */}
        <path d={arcPath(cx, cy, r, 0, 100)} fill="none" stroke="var(--grid)" strokeWidth={stroke} strokeLinecap="round" />

        {/* Filled portion, in the current band's status color. */}
        {hasScore && (
          <path
            d={arcPath(cx, cy, r, 0, Math.max(score, 0.5))}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
          />
        )}

        {/* Band boundaries as hairline ticks -- solid, one shade off the surface. */}
        {RISK_BANDS.slice(1).map((b) => {
          const inner = polar(cx, cy, r - stroke / 2 - 1, b.min);
          const outer = polar(cx, cy, r + stroke / 2 + 1, b.min);
          return (
            <line
              key={b.min}
              x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y}
              stroke="var(--surface-1)" strokeWidth={2}
            />
          );
        })}

        {/* Current value marker, with a 2px surface ring so it reads over the arc. */}
        {marker && (
          <>
            <circle cx={marker.x} cy={marker.y} r={9} fill="var(--surface-1)" />
            <circle cx={marker.x} cy={marker.y} r={6} fill={color} />
          </>
        )}

        {/* Endpoint scale labels only -- a number at every tick is noise. */}
        <text x={cx - r} y={cy + 22} textAnchor="middle" fontSize={11} fill="var(--text-muted)">0</text>
        <text x={cx + r} y={cy + 22} textAnchor="middle" fontSize={11} fill="var(--text-muted)">100</text>
      </svg>

      <div className="gauge-value" style={{ color: hasScore ? 'var(--text-primary)' : 'var(--text-muted)' }}>
        {hasScore ? Math.round(score) : '--'}
        <span className="gauge-scale"> / 100</span>
      </div>

      {band && (
        <div className="gauge-band">
          <span className="gauge-dot" style={{ background: color }} aria-hidden="true" />
          {band.label} pressure
        </div>
      )}

      <div className="coverage" title="Share of the model's total weight that resolved to real data">
        <span>Coverage</span>
        <span className="coverage-track">
          <span className="coverage-fill" style={{ width: `${Math.round((coverage || 0) * 100)}%` }} />
        </span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {Math.round((coverage || 0) * 100)}% &middot; {available}/{total}
        </span>
      </div>
    </div>
  );
}

/**
 * Tiny zero-dependency crontab evaluator.
 *
 * Supports the standard 5-field syntax (minute hour dom month dow) with:
 *   - "*"            wildcard
 *   - "*​/N"          step
 *   - "A,B,C"        list
 *   - "A-B"          range
 *   - integer        literal
 *
 * All matching is done in UTC. Day-of-week 0 = Sunday.
 *
 * Public API:
 *   parseCron(expr)    → fields[]   (or null on parse error)
 *   matches(fields, d) → boolean
 *   nextAfter(expr, fromDate)   → Date next firing time (or null)
 */

const FIELD_RANGES = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day-of-month
  [1, 12], // month
  [0, 6],  // day-of-week (0 = Sun)
];

function expandField(token, [min, max]) {
  if (token === "*") {
    const out = new Set();
    for (let i = min; i <= max; i++) out.add(i);
    return out;
  }
  const out = new Set();
  for (const part of token.split(",")) {
    const stepMatch = part.match(/^(.+)\/(\d+)$/);
    let base = stepMatch ? stepMatch[1] : part;
    const step = stepMatch ? parseInt(stepMatch[2], 10) : 1;
    let lo = min;
    let hi = max;
    if (base === "*") {
      // already lo..hi
    } else if (base.includes("-")) {
      const [a, b] = base.split("-").map((n) => parseInt(n, 10));
      if (Number.isNaN(a) || Number.isNaN(b)) return null;
      lo = a;
      hi = b;
    } else {
      const v = parseInt(base, 10);
      if (Number.isNaN(v)) return null;
      lo = v;
      hi = v;
    }
    if (lo < min || hi > max || step < 1) return null;
    for (let i = lo; i <= hi; i += step) out.add(i);
  }
  return out;
}

function parseCron(expr) {
  if (!expr) return null;
  const parts = String(expr).trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = [];
  for (let i = 0; i < 5; i++) {
    const set = expandField(parts[i], FIELD_RANGES[i]);
    if (!set) return null;
    fields.push(set);
  }
  return fields;
}

function matches(fields, d) {
  return (
    fields[0].has(d.getUTCMinutes()) &&
    fields[1].has(d.getUTCHours()) &&
    fields[2].has(d.getUTCDate()) &&
    fields[3].has(d.getUTCMonth() + 1) &&
    fields[4].has(d.getUTCDay())
  );
}

/**
 * Walk forward minute-by-minute up to one year to find the next firing.
 * (Sufficient for cron-like business schedules; pathological expressions
 * that never match within a year return null.)
 */
function nextAfter(expr, fromDate) {
  const fields = parseCron(expr);
  if (!fields) return null;

  // Round up to the next whole minute
  const start = new Date(fromDate.getTime() + 60_000);
  start.setUTCSeconds(0, 0);

  const limit = 366 * 24 * 60; // 1 year of minutes
  for (let i = 0; i < limit; i++) {
    const cand = new Date(start.getTime() + i * 60_000);
    if (matches(fields, cand)) return cand;
  }
  return null;
}

module.exports = { parseCron, matches, nextAfter };

/**
 * Prometheus-compatible metrics middleware.
 *
 * Exposes a GET /metrics endpoint (Prometheus text format) that reports:
 *   - http_requests_total           counter   (method, route, status)
 *   - http_request_duration_seconds histogram (method, route)
 *   - http_requests_in_flight       gauge
 *   - nodejs_heap_used_bytes        gauge
 *   - nodejs_event_loop_lag_seconds gauge
 *
 * Lightweight — no external dependencies.  Uses process.hrtime.bigint()
 * for sub-millisecond timing.
 */

// ── counters & histograms ─────────────────────────────────────

/** request counter: key = `method:route:status` → count */
const counters = new Map();

/** duration histogram: key = `method:route` → buckets + sum + count */
const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const histograms = new Map();

let inFlight = 0;
let startTime = Date.now();

function inc(method, route, status) {
  const key = `${method}:${route}:${status}`;
  counters.set(key, (counters.get(key) || 0) + 1);
}

function observe(method, route, durationSec) {
  const key = `${method}:${route}`;
  let h = histograms.get(key);
  if (!h) {
    h = { buckets: new Array(BUCKETS.length).fill(0), sum: 0, count: 0 };
    histograms.set(key, h);
  }
  h.sum += durationSec;
  h.count += 1;
  for (let i = 0; i < BUCKETS.length; i++) {
    if (durationSec <= BUCKETS[i]) h.buckets[i]++;
  }
}

/** Normalise Express route path so high-cardinality IDs don't explode label space. */
function normaliseRoute(req) {
  if (req.route?.path) {
    // Express matched route, e.g. /agents/:name/follow
    return req.baseUrl + req.route.path;
  }
  // Fallback — strip UUIDs and numeric IDs
  return req.baseUrl + req.path
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id')
    .replace(/\/\d+\b/g, '/:id');
}

// ── middleware ─────────────────────────────────────────────────

/**
 * Express middleware — call `app.use(metricsMiddleware)` BEFORE routes.
 */
function metricsMiddleware(req, res, next) {
  // Skip metrics endpoint itself
  if (req.path === '/metrics') return next();

  const start = process.hrtime.bigint();
  inFlight++;

  const onFinish = () => {
    inFlight--;
    const ns = Number(process.hrtime.bigint() - start);
    const sec = ns / 1e9;
    const route = normaliseRoute(req);
    inc(req.method, route, res.statusCode);
    observe(req.method, route, sec);
    res.removeListener('finish', onFinish);
    res.removeListener('close', onFinish);
  };

  res.on('finish', onFinish);
  res.on('close', onFinish);
  next();
}

// ── event loop lag sampler ────────────────────────────────────

let eventLoopLag = 0;
function sampleLag() {
  const start = process.hrtime.bigint();
  setImmediate(() => {
    eventLoopLag = Number(process.hrtime.bigint() - start) / 1e9;
  });
}
setInterval(sampleLag, 2000);

// ── serialise to Prometheus text format ───────────────────────

function renderMetrics() {
  const lines = [];

  // uptime
  lines.push('# HELP process_uptime_seconds Process uptime');
  lines.push('# TYPE process_uptime_seconds gauge');
  lines.push(`process_uptime_seconds ${((Date.now() - startTime) / 1000).toFixed(1)}`);

  // heap
  const mem = process.memoryUsage();
  lines.push('# HELP nodejs_heap_used_bytes Heap used');
  lines.push('# TYPE nodejs_heap_used_bytes gauge');
  lines.push(`nodejs_heap_used_bytes ${mem.heapUsed}`);
  lines.push('# HELP nodejs_heap_total_bytes Heap total');
  lines.push('# TYPE nodejs_heap_total_bytes gauge');
  lines.push(`nodejs_heap_total_bytes ${mem.heapTotal}`);
  lines.push('# HELP nodejs_rss_bytes Resident set size');
  lines.push('# TYPE nodejs_rss_bytes gauge');
  lines.push(`nodejs_rss_bytes ${mem.rss}`);

  // event loop lag
  lines.push('# HELP nodejs_event_loop_lag_seconds Event loop lag');
  lines.push('# TYPE nodejs_event_loop_lag_seconds gauge');
  lines.push(`nodejs_event_loop_lag_seconds ${eventLoopLag.toFixed(6)}`);

  // in-flight
  lines.push('# HELP http_requests_in_flight Current in-flight requests');
  lines.push('# TYPE http_requests_in_flight gauge');
  lines.push(`http_requests_in_flight ${inFlight}`);

  // request counter
  lines.push('# HELP http_requests_total Total HTTP requests');
  lines.push('# TYPE http_requests_total counter');
  for (const [key, count] of counters.entries()) {
    const [method, route, status] = key.split(':');
    lines.push(`http_requests_total{method="${method}",route="${route}",status="${status}"} ${count}`);
  }

  // duration histogram
  lines.push('# HELP http_request_duration_seconds Request duration');
  lines.push('# TYPE http_request_duration_seconds histogram');
  for (const [key, h] of histograms.entries()) {
    const [method, route] = key.split(':');
    const labels = `method="${method}",route="${route}"`;
    let cum = 0;
    for (let i = 0; i < BUCKETS.length; i++) {
      cum += h.buckets[i];
      lines.push(`http_request_duration_seconds_bucket{${labels},le="${BUCKETS[i]}"} ${cum}`);
    }
    lines.push(`http_request_duration_seconds_bucket{${labels},le="+Inf"} ${h.count}`);
    lines.push(`http_request_duration_seconds_sum{${labels}} ${h.sum.toFixed(6)}`);
    lines.push(`http_request_duration_seconds_count{${labels}} ${h.count}`);
  }

  return lines.join('\n') + '\n';
}

// ── /metrics route handler ────────────────────────────────────

function metricsHandler(req, res) {
  res.set('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
  res.send(renderMetrics());
}

module.exports = { metricsMiddleware, metricsHandler };

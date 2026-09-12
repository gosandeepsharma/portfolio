/**
 * gosandeep.com — metrics API
 *
 * Queries PostHog server-side so the API key never reaches the browser.
 * Env vars (set in Vercel → Project → Settings → Environment Variables):
 *   POSTHOG_API_KEY   required — a PostHog *personal* API key, read-only scope
 *   METRICS_PASSWORD  optional — if set, callers must send x-metrics-key with the same value
 *
 * GET /api/metrics?range=24h|7d|30d|90d
 */

const HOST = 'https://us.posthog.com';
const PORTFOLIO = 605665;   // Portfolio (gosandeep.com) — site pages + A Walk Through Time
const EAGLES = 599518;      // Eagle's Descent
const LASERCHAT = 483835;   // LaserChat (laserchat.app) — its own product, own PostHog project

const RANGES = {
  '24h': { days: 1,  bucket: 'toStartOfHour' },
  '7d':  { days: 7,  bucket: 'toStartOfDay' },
  '30d': { days: 30, bucket: 'toStartOfDay' },
  '90d': { days: 90, bucket: 'toStartOfDay' }
};

// events written by my own setup/testing carry analytics=debug in the URL
const NOT_TEST = "coalesce(properties.$current_url, '') NOT ILIKE '%analytics=debug%'";
const IS_AWTT = "coalesce(properties.$pathname, '') ILIKE '%/alloftime%'";

// PostHog stores direct traffic as the literal string '$direct', not an empty value
const REF = "if(coalesce(properties.$referring_domain, '') IN ('', '$direct'), '(direct)', properties.$referring_domain)";
// internal navigation sets $referring_domain to our own host — that is not a traffic source
const NOT_SELF_REF = "coalesce(properties.$referring_domain, '') NOT ILIKE '%gosandeep.com%'";

/**
 * Two deadlines, because the two kinds of call have very different honest costs.
 *
 * Reading PostHog's cached result takes ~130-400ms when the connection is healthy.
 * Measured from Vercel, a small share of calls instead stall at the connection level
 * and never answer — with a single 9s deadline those stalls WERE the page's load time.
 * So the cached read gets a short leash and is simply tried again.
 *
 * Computing a cold query legitimately takes 8-12s, so that call needs a long leash
 * and is not retried; if it stalls, that one section reports itself missing and the
 * rest of the dashboard still renders.
 *
 * Worst case per query is 3 + 3 + 12 = 18s, inside the function's 30s cap.
 */
const CACHED_TIMEOUT_MS = 3000;
const CACHED_ATTEMPTS = 2;
const COMPUTE_TIMEOUT_MS = 12000;

function deadline(ms) {
  if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

function isStall(err) {
  return !!err && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

async function hogOnce(projectId, sql, key, refresh, timeoutMs) {
  const payload = { query: { kind: 'HogQLQuery', query: sql } };
  if (refresh) payload.refresh = refresh;
  const r = await fetch(`${HOST}/api/projects/${projectId}/query/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
    signal: deadline(timeoutMs)
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`PostHog ${r.status}: ${body.slice(0, 200)}`);
  }
  return r.json();
}

/**
 * PostHog caches query results. Ask for the cached copy first — it comes back in
 * roughly a third of a second and PostHog refreshes it in the background, which is
 * exactly right for a traffic dashboard. On a cold cache it answers with a
 * `query_status` and no `results`, so fall through to a normal computing call.
 * Computing cold is what used to take 8-12s per range.
 *
 * Returns { rows, cached }.
 */
async function hog(projectId, sql, key) {
  for (let attempt = 1; attempt <= CACHED_ATTEMPTS; attempt++) {
    try {
      const j = await hogOnce(projectId, sql, key, 'lazy_async', CACHED_TIMEOUT_MS);
      // results present = a cached answer; absent (just a query_status) = cold cache
      if (Array.isArray(j.results)) return { rows: j.results, cached: !!j.is_cached };
      break;
    } catch (err) {
      if (!isStall(err)) throw err;
    }
  }

  // cold cache, or every cached read stalled — compute it
  const j = await hogOnce(projectId, sql, key, null, COMPUTE_TIMEOUT_MS);
  return { rows: j.results || [], cached: !!j.is_cached };
}

const num = (v) => (typeof v === 'number' ? v : Number(v) || 0);
const rows = (res, map) => res.map(map);

module.exports = async function handler(req, res) {
  const key = process.env.POSTHOG_API_KEY;
  const pass = process.env.METRICS_PASSWORD;

  if (pass && req.headers['x-metrics-key'] !== pass) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!key) {
    return res.status(500).json({
      error: 'POSTHOG_API_KEY is not set',
      hint: 'Add a read-only PostHog personal API key in Vercel → Settings → Environment Variables, then redeploy.'
    });
  }

  const rangeKey = RANGES[req.query.range] ? req.query.range : '30d';
  const { days, bucket } = RANGES[rangeKey];
  const SINCE = `timestamp > now() - INTERVAL ${days} DAY`;
  const q = (projectId, sql) => hog(projectId, sql, key);

  try {
    const startedAt = Date.now();
    const NAMES = [
      'portfolio totals', 'portfolio trend', 'portfolio pages', 'portfolio referrers',
      'portfolio card clicks', 'portfolio outbound',
      'eagles totals', 'eagles trend', 'eagles referrers', 'eagles phases',
      'laserchat totals', 'laserchat trend', 'laserchat referrers'
    ];

    const settled = await Promise.allSettled([
      // ---- project 605665: portfolio + AWTT ----
      q(PORTFOLIO, `
        SELECT
          uniqIf(person_id, event = '$pageview')                AS visitors,
          countIf(event = '$pageview')                          AS pageviews,
          uniqIf(person_id, event = '$pageview' AND ${IS_AWTT}) AS awttVisitors,
          countIf(event = '$pageview' AND ${IS_AWTT})           AS awttPageviews,
          countIf(event = '$pageview' AND coalesce(properties.$pathname,'') = '/') AS homeViews,
          countIf(event = 'work_card_click' AND coalesce(properties.project,'') = 'A Walk Through Time') AS awttCardClicks,
          countIf(event = 'work_card_click')                    AS cardClicks,
          countIf(event = 'outbound_click')                     AS outboundClicks
        FROM events WHERE ${SINCE} AND ${NOT_TEST}`),

      q(PORTFOLIO, `
        SELECT ${bucket}(timestamp) AS t,
               uniq(person_id) AS visitors,
               count() AS pageviews,
               countIf(${IS_AWTT}) AS awttPageviews
        FROM events
        WHERE event = '$pageview' AND ${SINCE} AND ${NOT_TEST}
        GROUP BY t ORDER BY t`),

      q(PORTFOLIO, `
        SELECT coalesce(properties.$pathname, '(none)') AS path,
               count() AS views, uniq(person_id) AS visitors
        FROM events WHERE event = '$pageview' AND ${SINCE} AND ${NOT_TEST}
        GROUP BY path ORDER BY views DESC LIMIT 12`),

      q(PORTFOLIO, `
        SELECT ${REF} AS ref, uniq(person_id) AS visitors
        FROM events
        WHERE event = '$pageview' AND ${SINCE} AND ${NOT_TEST} AND ${NOT_SELF_REF}
        GROUP BY ref ORDER BY visitors DESC LIMIT 8`),

      q(PORTFOLIO, `
        SELECT coalesce(properties.project, '(unknown)') AS project, count() AS clicks
        FROM events WHERE event = 'work_card_click' AND ${SINCE} AND ${NOT_TEST}
        GROUP BY project ORDER BY clicks DESC LIMIT 8`),

      q(PORTFOLIO, `
        SELECT coalesce(properties.host, '(unknown)') AS host, count() AS clicks
        FROM events WHERE event = 'outbound_click' AND ${SINCE} AND ${NOT_TEST}
        GROUP BY host ORDER BY clicks DESC LIMIT 8`),

      // ---- project 599518: Eagle's Descent ----
      q(EAGLES, `
        SELECT
          uniqIf(person_id, event = '$pageview') AS visitors,
          countIf(event = '$pageview')           AS pageviews,
          countIf(event = 'sim_started')         AS started,
          countIf(event = 'sim_landed')          AS landed,
          countIf(event = 'sim_crashed')         AS crashed,
          countIf(event = 'sim_aborted')         AS aborted,
          countIf(event = 'sim_restarted')       AS restarts,
          countIf(event = 'learn_opened')        AS learnOpened
        FROM events WHERE ${SINCE}`),

      q(EAGLES, `
        SELECT ${bucket}(timestamp) AS t,
               uniqIf(person_id, event = '$pageview') AS visitors,
               countIf(event = 'sim_started') AS started
        FROM events WHERE ${SINCE} GROUP BY t ORDER BY t`),

      q(EAGLES, `
        SELECT ${REF} AS ref, uniq(person_id) AS visitors
        FROM events
        WHERE event = '$pageview' AND ${SINCE} AND ${NOT_SELF_REF}
        GROUP BY ref ORDER BY visitors DESC LIMIT 8`),

      q(EAGLES, `
        SELECT coalesce(properties.phase, '(unknown)') AS phase, count() AS n
        FROM events WHERE event = 'phase_reached' AND ${SINCE}
        GROUP BY phase ORDER BY n DESC LIMIT 8`),

      // ---- project 483835: LaserChat ----
      // LaserChat does not emit $pageview; 'landing_viewed' is its pageview equivalent.
      // The funnel counts PEOPLE, not events — one account can start many runs, so event
      // counts would make step 3 look larger than step 2.
      q(LASERCHAT, `
        SELECT
          uniqIf(person_id, event = 'landing_viewed') AS visitors,
          countIf(event = 'landing_viewed')           AS views,
          uniqIf(person_id, event = 'signed_up')      AS signups,
          uniqIf(person_id, event = 'run_started')    AS runners,
          uniqIf(person_id, event = 'run_completed')  AS finishers,
          countIf(event = 'run_started')              AS runsStarted,
          countIf(event = 'run_completed')            AS runsCompleted,
          uniqIf(person_id, event = 'returned')       AS returning
        FROM events WHERE ${SINCE}`),

      q(LASERCHAT, `
        SELECT ${bucket}(timestamp) AS t,
               uniqIf(person_id, event = 'landing_viewed') AS visitors,
               countIf(event = 'run_started') AS runs
        FROM events WHERE ${SINCE} GROUP BY t ORDER BY t`),

      q(LASERCHAT, `
        SELECT ${REF} AS ref, uniq(person_id) AS visitors
        FROM events
        WHERE event = 'landing_viewed' AND ${SINCE}
          AND coalesce(properties.$referring_domain, '') NOT ILIKE '%laserchat.app%'
        GROUP BY ref ORDER BY visitors DESC LIMIT 8`)
    ]);

    // Whatever came back still renders; whatever didn't is named in `incomplete`
    // so the page can say which section is missing instead of showing nothing.
    const incomplete = [];
    let cachedCount = 0;
    const vals = settled.map((r, i) => {
      if (r.status === 'fulfilled') {
        if (r.value.cached) cachedCount++;
        return r.value.rows;
      }
      const why = String((r.reason && r.reason.message) || r.reason).slice(0, 160);
      incomplete.push(NAMES[i] + ' — ' + why);
      return [];
    });
    const [
      pTotals, pTrend, pPages, pRefs, pCards, pOut,
      eTotals, eTrend, eRefs, ePhases,
      lTotals, lTrend, lRefs
    ] = vals;

    const p = pTotals[0] || [];
    const e = eTotals[0] || [];
    const l = lTotals[0] || [];

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      range: rangeKey,
      generatedAt: new Date().toISOString(),
      tookMs: Date.now() - startedAt,
      cachedCount: cachedCount,
      queryCount: NAMES.length,
      incomplete: incomplete,
      portfolio: {
        visitors: num(p[0]), pageviews: num(p[1]),
        cardClicks: num(p[6]), outboundClicks: num(p[7]),
        trend: rows(pTrend, (r) => ({ t: r[0], visitors: num(r[1]), pageviews: num(r[2]) })),
        topPages: rows(pPages, (r) => ({ path: r[0], views: num(r[1]), visitors: num(r[2]) })),
        referrers: rows(pRefs, (r) => ({ ref: r[0], visitors: num(r[1]) })),
        cardClicksByProject: rows(pCards, (r) => ({ project: r[0], clicks: num(r[1]) })),
        outboundByHost: rows(pOut, (r) => ({ host: r[0], clicks: num(r[1]) }))
      },
      awtt: {
        visitors: num(p[2]), pageviews: num(p[3]),
        funnel: { homeViews: num(p[4]), cardClicks: num(p[5]), opened: num(p[3]) },
        trend: rows(pTrend, (r) => ({ t: r[0], pageviews: num(r[3]) }))
      },
      eagles: {
        visitors: num(e[0]), pageviews: num(e[1]), started: num(e[2]),
        landed: num(e[3]), crashed: num(e[4]), aborted: num(e[5]),
        restarts: num(e[6]), learnOpened: num(e[7]),
        trend: rows(eTrend, (r) => ({ t: r[0], visitors: num(r[1]), started: num(r[2]) })),
        referrers: rows(eRefs, (r) => ({ ref: r[0], visitors: num(r[1]) })),
        phases: rows(ePhases, (r) => ({ phase: r[0], n: num(r[1]) }))
      },
      laserchat: {
        visitors: num(l[0]), views: num(l[1]),
        signups: num(l[2]), runners: num(l[3]), finishers: num(l[4]),
        runsStarted: num(l[5]), runsCompleted: num(l[6]), returning: num(l[7]),
        trend: rows(lTrend, (r) => ({ t: r[0], visitors: num(r[1]), runs: num(r[2]) })),
        referrers: rows(lRefs, (r) => ({ ref: r[0], visitors: num(r[1]) }))
      }
    });
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
}

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

const RANGES = {
  '24h': { days: 1,  bucket: 'toStartOfHour' },
  '7d':  { days: 7,  bucket: 'toStartOfDay' },
  '30d': { days: 30, bucket: 'toStartOfDay' },
  '90d': { days: 90, bucket: 'toStartOfDay' }
};

// events written by my own setup/testing carry analytics=debug in the URL
const NOT_TEST = "coalesce(properties.$current_url, '') NOT ILIKE '%analytics=debug%'";
const IS_AWTT = "coalesce(properties.$pathname, '') ILIKE '%/alloftime%'";

async function hog(projectId, sql, key) {
  const r = await fetch(`${HOST}/api/projects/${projectId}/query/`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ query: { kind: 'HogQLQuery', query: sql } })
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`PostHog ${r.status}: ${body.slice(0, 300)}`);
  }
  const j = await r.json();
  return j.results || [];
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
    const [
      pTotals, pTrend, pPages, pRefs, pCards, pOut,
      eTotals, eTrend, eRefs, ePhases
    ] = await Promise.all([
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
        SELECT coalesce(nullIf(properties.$referring_domain, ''), '(direct)') AS ref,
               uniq(person_id) AS visitors
        FROM events WHERE event = '$pageview' AND ${SINCE} AND ${NOT_TEST}
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
        SELECT coalesce(nullIf(properties.$referring_domain, ''), '(direct)') AS ref,
               uniq(person_id) AS visitors
        FROM events WHERE event = '$pageview' AND ${SINCE}
        GROUP BY ref ORDER BY visitors DESC LIMIT 8`),

      q(EAGLES, `
        SELECT coalesce(properties.phase, '(unknown)') AS phase, count() AS n
        FROM events WHERE event = 'phase_reached' AND ${SINCE}
        GROUP BY phase ORDER BY n DESC LIMIT 8`)
    ]);

    const p = pTotals[0] || [];
    const e = eTotals[0] || [];

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      range: rangeKey,
      generatedAt: new Date().toISOString(),
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
      }
    });
  } catch (err) {
    return res.status(502).json({ error: String(err.message || err) });
  }
}

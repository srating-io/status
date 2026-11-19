/*
 * Serves public/ with a generated status.json and history.json, so the page can be worked on
 * without the prober, a database or nginx.
 *
 *   npm run dev              all operational
 *   npm run dev -- down      start on another scenario
 *   /__scenario/<name>       switch while it is running
 *
 * The json is built per request rather than kept as fixture files: the page compares
 * `generated_at` and the bucket dates to the clock, so a file on disk is stale the day after it
 * is written.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.PORT) || 3003;
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const DAY = 86400000;
const HOUR = 3600000;

/** The same keys, names and order the prober publishes. */
const SERVICES = [
  { key: 'v1', name: 'Public API', group: 'API', latency: 140 },
  { key: 'internal', name: 'Website API', group: 'API', latency: 95 },
  { key: 'database', name: 'Database', group: 'API', latency: 3 },
  { key: 'gui', name: 'Website', group: 'Website', latency: 310 },
  { key: 'docs', name: 'Documentation', group: 'Website', latency: 180 },
  { key: 'ux', name: 'Design system', group: 'Website', latency: 210 },
  { key: 'ws', name: 'Live updates', group: 'Realtime', latency: 4 },
  { key: 'stripe', name: 'Billing', group: 'Billing', latency: 120 },
  // the pipeline check is whether the scraper manager is running, which has no response time
  { key: 'pipeline', name: 'Data pipeline', group: 'Data', latency: null },
];

const SCENARIOS = {
  'operational': 'everything up, one resolved incident in the list',
  'degraded': 'the public api answering slowly',
  'down': 'website api and database down, an open incident and a notice',
  'stale': 'the prober stopped 20 minutes ago',
  'no-history': 'first hour after launch, history.json does not exist yet',
  'old-history': 'history.json from a prober older than the charts: daily p50 only',
  'empty': 'a snapshot with no services in it',
  'missing': 'status.json does not exist',
};

let scenario = SCENARIOS[process.argv[2]] ? process.argv[2] : 'operational';

/** Stable per service and day, so a reload does not redraw different bars. */
const noise = (seed) => {
  let hash = 2166136261;

  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return ((hash >>> 0) % 10000) / 10000;
};

const dayKey = (date) => date.toISOString().slice(0, 10);

/** p50, p95 and max for one bucket off a typical latency, or nulls for a service with none. */
const latencies = (base, roll) => {
  if (base === null) {
    return { 'p50_ms': null, 'p95_ms': null, 'max_ms': null };
  }

  const p50 = Math.round(base * (0.8 + (roll * 0.5)));
  const p95 = Math.round(p50 * (2.2 + roll));

  return { 'p50_ms': p50, 'p95_ms': p95, 'max_ms': Math.round(p95 * (1.4 + (roll * 1.5))) };
};

const buildHistory = () => {
  const services = {};
  const hourly = {};
  const now = Date.now();
  const lastHour = Math.floor(now / HOUR) * HOUR - HOUR;
  const old = scenario === 'old-history';

  for (const service of SERVICES) {
    const buckets = [];

    // 75 of the 90 days, so the oldest bars show what "no data" looks like
    for (let i = 74; i >= 0; i--) {
      const key = dayKey(new Date(now - (i * DAY)));
      const roll = noise(service.key + key);

      let uptime = 1;

      if (roll > 0.985) {
        uptime = 0.9;
      } else if (roll > 0.94) {
        uptime = 0.997;
      }

      const ms = latencies(service.latency, roll);

      // the shape an older prober wrote: p50 and nothing else
      buckets.push(old
        ? { 'bucket': key, 'uptime': uptime, 'p50_ms': ms.p50_ms }
        : { 'bucket': key, 'uptime': uptime, ...ms });
    }

    services[service.key] = buckets;

    const hours = [];

    // 160 of the 168 hours, so the oldest show "no data" -- the prober only began rolling up then
    for (let i = 159; i >= 0; i--) {
      const start = new Date(lastHour - (i * HOUR));
      const roll = noise(service.key + start.toISOString());
      const utcHour = start.getUTCHours();

      // evenings in the US are the busy hours, so they run slower
      const load = utcHour >= 23 || utcHour <= 3 ? 1.45 : 1;
      let uptime = roll > 0.99 ? 0.95 : 1;

      // one bad hour yesterday, so the strip and the tooltips have something to show
      if (i === 26 && (service.key === 'internal' || service.key === 'database')) {
        uptime = 0.8;
      }

      if (scenario === 'down' && i === 0 && (service.key === 'internal' || service.key === 'database')) {
        uptime = 0.9;
      }

      const ms = latencies(service.latency === null ? null : service.latency * load, roll);

      hours.push({ 'bucket': start.toISOString().slice(0, 13) + ':00:00Z', 'uptime': uptime, ...ms });
    }

    hourly[service.key] = hours;
  }

  const history = { 'generated_at': new Date().toISOString(), 'days': 90, 'services': services };

  if (old) {
    return history;
  }

  return {
    ...history,
    'hours': 168,
    'hourly': hourly,
    'incidents': [
      {
        'service': 'internal',
        'title': 'Website API is not responding',
        'started_at': new Date(lastHour - (26 * HOUR) + (10 * 60000)).toISOString(),
        'resolved_at': new Date(lastHour - (26 * HOUR) + (22 * 60000)).toISOString(),
      },
      {
        'service': 'v1',
        'title': 'Public API is not responding',
        'started_at': new Date(now - (40 * DAY)).toISOString(),
        'resolved_at': new Date(now - (40 * DAY) + (2 * HOUR)).toISOString(),
      },
      {
        'service': null,
        'title': 'Scheduled database maintenance',
        'started_at': new Date(now - (10 * DAY)).toISOString(),
        'resolved_at': new Date(now - (10 * DAY) + (45 * 60000)).toISOString(),
      },
    ],
  };
};

const buildSnapshot = () => {
  const now = Date.now();
  const states = {};
  const notices = [];

  const incidents = [{
    'state': 'resolved',
    'title': 'Live updates were not responding',
    'body': 'The websocket server was restarted after a deploy and came back within four minutes.',
    // inside the prober's 2 day window for resolved incidents
    'started_at': new Date(now - DAY).toISOString(),
    'resolved_at': new Date(now - DAY + (4 * 60000)).toISOString(),
  }];

  if (scenario === 'degraded') {
    states.v1 = 'degraded';
  }

  if (scenario === 'down') {
    states.internal = 'down';
    states.database = 'down';
    notices.push('3 finished games are waiting on box score data.');

    incidents.unshift({
      'state': 'investigating',
      'title': 'Website API is not responding',
      'body': null,
      'started_at': new Date(now - (6 * 60000)).toISOString(),
      'resolved_at': null,
    });
  }

  const services = scenario === 'empty' ? [] : SERVICES.map((service) => {
    const state = states[service.key] || 'operational';
    let latency = service.latency;

    if (state === 'down') {
      latency = null;
    } else if (state === 'degraded' && latency !== null) {
      latency = latency * 9;
    }

    return {
      'key': service.key,
      'name': service.name,
      'group': service.group,
      'state': state,
      'latency_ms': latency,
      'uptime_24h': state === 'down' ? 0.9958 : 1,
      'uptime_90d': 0.9994,
    };
  });

  let overall = 'operational';

  if (services.some((service) => service.state === 'down')) {
    overall = 'down';
  } else if (services.some((service) => service.state === 'degraded')) {
    overall = 'degraded';
  }

  return {
    'generated_at': new Date(scenario === 'stale' ? now - (20 * 60000) : now).toISOString(),
    'interval_ms': 60000,
    'state': overall,
    'services': services,
    'notices': notices,
    'incidents': incidents,
  };
};

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

const send = (res, status, type, body) => {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
};

const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;

  if (pathname.startsWith('/__scenario/')) {
    const name = pathname.slice('/__scenario/'.length);

    if (!SCENARIOS[name]) {
      send(res, 404, 'text/plain', 'unknown scenario, one of: ' + Object.keys(SCENARIOS).join(', '));
      return;
    }

    scenario = name;
    console.log('scenario -> ' + name);
    res.writeHead(302, { 'Location': '/' });
    res.end();
    return;
  }

  if (pathname === '/status.json') {
    if (scenario === 'missing') {
      send(res, 404, 'text/plain', 'not found');
      return;
    }

    send(res, 200, TYPES['.json'], JSON.stringify(buildSnapshot()));
    return;
  }

  if (pathname === '/history.json') {
    if (scenario === 'no-history' || scenario === 'missing') {
      send(res, 404, 'text/plain', 'not found');
      return;
    }

    send(res, 200, TYPES['.json'], JSON.stringify(buildHistory()));
    return;
  }

  const file = path.join(ROOT, pathname === '/' ? 'index.html' : pathname);

  // nothing outside public/, whatever the path says
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) {
    send(res, 403, 'text/plain', 'forbidden');
    return;
  }

  fs.readFile(file, (error, body) => {
    if (error) {
      send(res, 404, 'text/plain', 'not found');
      return;
    }

    send(res, 200, TYPES[path.extname(file)] || 'application/octet-stream', body);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('status page on http://localhost:' + PORT + ' (scenario: ' + scenario + ')');

  for (const name of Object.keys(SCENARIOS)) {
    console.log('  /__scenario/' + name.padEnd(12) + SCENARIOS[name]);
  }
});

# srating.io-status

The public status page at [status.srating.io](https://status.srating.io): uptime, response times
and incidents for the website, the public API and the data pipeline.

Three static files and nothing else. No framework, no build step, no dependencies, no node process.

## Why it is static

The page reports on the gui, the internal api, the public api and the database, so it cannot depend
on any of them. nginx serves `public/` straight off disk, which means the page still loads when
node is down, when pm2 is down, when mysql is down, and during a gui `build-live` swap.

It makes no api call. It reads two json files that the prober writes next to it.

## How it gets its data

```
data-pipeline/handlers/statusProbe.ts      probes every service once a minute
        |  writes (temp file + rename)
        v
/var/www/status.srating.io/data/status.json     current state, rewritten every minute
/var/www/status.srating.io/data/history.json    90 days of daily buckets, rewritten hourly
        ^
        |  fetched every 60s, never cached
public/status.js
```

The shapes are `Status.Snapshot` and `Status.History` in `@srating-io/types` (`src/status.ts`).
That file is the contract: change it there first, then the prober, then this page.

If `generated_at` is more than three intervals old the page says so instead of showing a stale
green. The prober is a scraper handler, so a dead scraper would otherwise freeze the page on the
last good result.

The Data pipeline card means "the scraper manager is running". The prober is forked by it and exits
with it, so the prober can only ever report it up. A stale snapshot is the real signal, and the page
shows the pipeline as Down whenever it sees one.

## Working on it

```bash
npm run dev               # http://localhost:3003, everything operational
npm run dev -- down       # start on another scenario
```

`scripts/dev.mjs` serves `public/` with generated json, so there is no prober, database or nginx to
set up. Switch scenarios while it runs at `/__scenario/<name>`:

| scenario | what it shows |
| :--- | :--- |
| `operational` | everything up, one resolved incident |
| `degraded` | the public api answering slowly |
| `down` | two services down, an open incident and a notice |
| `stale` | the prober stopped 20 minutes ago |
| `no-history` | `history.json` missing, as in the first hour after launch |
| `empty` | a snapshot with no services |
| `missing` | `status.json` missing |

Check both color schemes. The css follows `prefers-color-scheme`.

## Deploying

```bash
git pull
npm run deploy            # copies public/ to /var/www/status.srating.io/html
```

The copy deletes nothing. The json lives in `data/`, beside `html/`, so a deploy cannot touch it.
Set `STATUS_HTML_PATH` to deploy somewhere else.

## Server setup

One time, on the droplet:

```bash
mkdir -p /var/www/status.srating.io/html /var/www/status.srating.io/data
chown -R "$USER":"$USER" /var/www/status.srating.io    # the user pm2 runs the scraper as
```

DNS: an A record for `status.srating.io` pointing at the droplet.

nginx: the two `status.srating.io` server blocks are in `sports-scraper/nginx_config.md`, with the
rest of the config. The part specific to this page:

```nginx
server {
    root /var/www/status.srating.io/html;
    index index.html;
    server_name status.srating.io;

    location / {
        try_files $uri $uri/ =404;
    }

    location ~ ^/(status|history)\.json$ {
        root /var/www/status.srating.io/data;
        add_header Cache-Control "no-store" always;
        try_files $uri =404;
    }
}
```

Add the port 80 block first, run `certbot --nginx -d status.srating.io`, then add the 443 block.
The 443 block names a certificate that does not exist until certbot has run, so the other order
fails `nginx -t`.

## Incidents

The prober opens an incident when a public service fails three checks in a row and resolves it when
the service answers again. What it writes is a bare title. The useful part is the edit afterwards,
and that is done in sql, in the `status_incident` table. Times are UTC.

```sql
-- say what is going on
update status_incident
set state = 'identified', body = 'A deploy left the api workers on the old build. Restarting them.'
where status_incident_id = 12;

-- a notice that is not tied to a service: maintenance, a known upstream problem
insert into status_incident (service, state, title, body, started_at)
values (null, 'monitoring', 'Scheduled database maintenance', 'Expect a few minutes of slow responses.', utc_timestamp());

-- close one by hand
update status_incident set state = 'resolved', resolved_at = utc_timestamp() where status_incident_id = 12;
```

`state` is one of `investigating`, `identified`, `monitoring`, `resolved`. Leave `service` null on
anything written by hand: the prober resolves every open incident for a service as soon as that
service is healthy, so a notice filed under `v1` closes on the next good check.

The page shows everything unresolved, plus whatever was resolved in the last 2 days. The window is
`RESOLVED_INCIDENT_DAYS` in the prober, mirrored by `INCIDENT_DAYS` in `status.js`.

## What it cannot tell you

- **A droplet or nginx outage.** Everything runs on one box, the prober included. If the box is
  down a visitor gets a connection error, not a red page. Only a monitor somewhere else closes
  this: UptimeRobot or BetterStack pointed at `https://status.srating.io/status.json`.
- **Downtime while the prober is not running.** No checks are recorded, so those minutes are
  missing from the uptime numbers rather than counted against them. The bars show "no data".
- **Host details.** Disk, memory, load, pm2 and certificate expiry are checked and alerted to
  Discord, and deliberately kept out of both json files. This page is public.

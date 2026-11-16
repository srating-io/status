# AGENTS.md — srating.io-status (status.srating.io)

The public status page. Three static files in `public/`, served by nginx off disk. See the README
for how the data reaches it and how it is deployed.

## Commands
- `npm run dev` — port **3003**, with generated json. `/__scenario/<name>` switches the scenario.
- `npm run deploy` — copies `public/` to the nginx directory.
- No build, no tests, no lint. Verify in a browser against every scenario, light and dark.

## Layout
```
public/index.html   markup, every panel starts in a loading state
public/status.js    fetches status.json + history.json every 60s and renders them
public/status.css   the only stylesheet, light and dark through prefers-color-scheme
scripts/dev.mjs     local server and scenario generator
scripts/deploy.sh   the deploy
```

## Rules
- **No dependency on anything it reports on.** No api call, no framework, no bundler, no node
  process in production, no CDN script or font. If the gui, the api or mysql is down this page
  still has to load.
- **Nothing in `public/` is generated.** `status.json` and `history.json` are written by the
  prober (`sports-scraper/handlers/statusProbe.ts`) into a separate `data/` directory.
- The json shapes are `Status.Snapshot` and `Status.History` in `@srating-io/types`. A new field
  starts there, then the prober, then here.
- Everything from the json reaches the DOM through `textContent`, never `innerHTML` with data.
  Incident titles and bodies are hand-written text.
- Never render an empty panel. A blank page during an outage looks the same as a broken one.
- The page is public. Hostnames, ports, disk and memory figures and row counts do not belong in
  it, and the prober does not send them.
- `status.js` is plain ES5-style script on purpose, with no modules and no transpile step. Keep it
  runnable by opening the file.
- Ports are distinct across the local sites; keep 3003.

/*
 * Reads the two json files the prober writes and renders them. No framework and no api call: the
 * internal api is one of the things this page reports on, so it cannot be a dependency of it.
 * The charts themselves live in chart.js, which loads first.
 */
(function () {
  'use strict';

  var Chart = window.StatusChart;
  var pct = Chart.format.pct;
  var ms = Chart.format.ms;

  var HOUR = 60 * 60 * 1000;
  var DAY = 24 * HOUR;
  var POLL_MS = 60 * 1000;

  /** history.json is rewritten hourly and is the larger file, so it is not refetched every minute. */
  var HISTORY_POLL_MS = 10 * 60 * 1000;

  /** Must match RESOLVED_INCIDENT_DAYS in the prober, which is what actually filters the list. */
  var INCIDENT_DAYS = 2;

  var RANGE_STORAGE_KEY = 'status-range';

  /**
   * `strip` is [slots, slot size] for the uptime strips, `line` the same for the response chart.
   * 7 days of strip is 4 hour slots: 168 bars with a gap between each do not fit a phone.
   */
  var RANGES = {
    '24h': {name: '24 hours', hourly: true, strip: [24, HOUR], line: [24, HOUR], from: '24 hours ago', to: 'now'},
    '7d': {name: '7 days', hourly: true, strip: [42, 4 * HOUR], line: [168, HOUR], from: '7 days ago', to: 'now'},
    '30d': {name: '30 days', hourly: false, strip: [30, DAY], line: [30, DAY], from: '30 days ago', to: 'today'},
    '90d': {name: '90 days', hourly: false, strip: [90, DAY], line: [90, DAY], from: '90 days ago', to: 'today'}
  };

  /** One ms axis for all three. Fixed order, so a color always means the same series. */
  var SERIES = [
    {key: 'p50', label: 'Typical (p50)', color: 'var(--series-1)', width: 2, area: true},
    {key: 'p95', label: 'Slow tail (p95)', color: 'var(--series-2)', width: 2},
    {key: 'max', label: 'Worst (max)', color: 'var(--series-3)', width: 1.5}
  ];

  var state = {
    snapshot: null,
    history: null,
    range: readRange(),
    expanded: {},
    /** Series switched off in a legend, shared by every chart so they all read the same way. */
    hidden: {},
    cards: {},
    layout: '',
    width: 0
  };

  function $(id) {
    return document.getElementById(id);
  }

  function text(node, value) {
    node.textContent = value == null ? '' : String(value);
  }

  /** Everything from the json goes through this -- incident bodies are hand written prose. */
  function el(tag, className, content) {
    var node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (content != null) {
      node.textContent = String(content);
    }
    return node;
  }

  /** Storage can throw in a private window, and the page must render the same without it. */
  function readRange() {
    try {
      var saved = window.localStorage.getItem(RANGE_STORAGE_KEY);
      if (saved && RANGES[saved]) {
        return saved;
      }
    } catch (e) {
      // the default below
    }
    return '24h';
  }

  function saveRange(key) {
    try {
      window.localStorage.setItem(RANGE_STORAGE_KEY, key);
    } catch (e) {
      // remembered for this visit only
    }
  }

  function label(state) {
    if (state === 'operational') { return 'Operational'; }
    if (state === 'degraded') { return 'Degraded'; }
    if (state === 'down') { return 'Down'; }
    if (state === 'maintenance') { return 'Maintenance'; }
    return 'Unknown';
  }

  /**
   * Incidents use the statuspage vocabulary, which is a different set from the service states
   * above -- running them through label() turned every open incident into "Unknown".
   */
  function incidentLabel(state) {
    if (state === 'investigating') { return 'Investigating'; }
    if (state === 'identified') { return 'Identified'; }
    if (state === 'monitoring') { return 'Monitoring'; }
    if (state === 'resolved') { return 'Resolved'; }
    return state ? String(state) : 'Open';
  }

  function num(value) {
    return typeof value === 'number' && isFinite(value) ? value : null;
  }

  function mean(list) {
    if (!list.length) {
      return null;
    }
    var sum = 0;
    for (var i = 0; i < list.length; i++) {
      sum += list[i];
    }
    return sum / list.length;
  }

  function median(list) {
    if (!list.length) {
      return null;
    }
    var sorted = list.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  /**
   * The range actually drawn: an hourly range falls back to 30 days when the file was written by a
   * prober older than the charts. With no file at all every range is equally empty, so none moves.
   */
  function effectiveRange() {
    var history = state.history;
    if (RANGES[state.range].hourly && history && !history.hourly) {
      return '30d';
    }
    return state.range;
  }

  /**
   * The window ends at the newest complete hour (or the end of today) as of when history.json was
   * written, not as of now -- otherwise the newest slot reads "no data" for the minutes between
   * the hour closing and the file being refetched.
   */
  function windowEnd(range) {
    var generated = state.history ? Date.parse(state.history.generated_at) : NaN;
    var at = isNaN(generated) ? Date.now() : generated;

    return range.hourly ? Math.floor(at / HOUR) * HOUR : (Math.floor(at / DAY) + 1) * DAY;
  }

  /** Hourly keys are full UTC timestamps; daily keys are UTC dates. */
  function points(list, hourly) {
    var out = [];

    for (var i = 0; list && i < list.length; i++) {
      var raw = String(list[i].bucket);
      var t = Date.parse(hourly ? raw : raw.slice(0, 10) + 'T00:00:00Z');

      if (!isNaN(t)) {
        out.push({
          t: t,
          uptime: num(list[i].uptime),
          p50: num(list[i].p50_ms),
          p95: num(list[i].p95_ms),
          max: num(list[i].max_ms)
        });
      }
    }

    return out;
  }

  /**
   * Fixed slots ending at `end`, so a gap reads as "no data" rather than shifting the axis.
   * Several hours in one slot: mean uptime, median of the medians, and the true max.
   */
  function slotted(list, count, size, end) {
    var start = end - (count * size);
    var raw = [];
    var i;

    for (i = 0; i < count; i++) {
      raw.push({uptime: [], p50: [], p95: [], max: []});
    }

    for (i = 0; i < list.length; i++) {
      var index = Math.floor((list[i].t - start) / size);
      if (index < 0 || index >= count) {
        continue;
      }
      var into = raw[index];
      if (list[i].uptime != null) { into.uptime.push(list[i].uptime); }
      if (list[i].p50 != null) { into.p50.push(list[i].p50); }
      if (list[i].p95 != null) { into.p95.push(list[i].p95); }
      if (list[i].max != null) { into.max.push(list[i].max); }
    }

    var slots = [];
    for (i = 0; i < count; i++) {
      slots.push({
        t: start + (i * size),
        size: size,
        uptime: mean(raw[i].uptime),
        p50: median(raw[i].p50),
        p95: median(raw[i].p95),
        max: raw[i].max.length ? Math.max.apply(null, raw[i].max) : null
      });
    }

    return slots;
  }

  /** Everything one service draws for a range, from the one bucketing, so every number agrees. */
  function seriesFor(key, rangeKey) {
    var range = RANGES[rangeKey];
    var history = state.history || {};
    var source = range.hourly ? (history.hourly || {})[key] : (history.services || {})[key];
    var list = points(source, range.hourly);
    var end = windowEnd(range);

    return {
      start: end - (range.line[0] * range.line[1]),
      end: end,
      strip: slotted(list, range.strip[0], range.strip[1], end),
      line: slotted(list, range.line[0], range.line[1], end)
    };
  }

  /** Incident spans for one service, or every incident for the overview. */
  function incidentsFor(key) {
    var list = (state.history && state.history.incidents) || [];
    var out = [];

    for (var i = 0; i < list.length; i++) {
      if (key && list[i].service !== key) {
        continue;
      }
      var from = Date.parse(list[i].started_at);
      if (isNaN(from)) {
        continue;
      }
      var to = list[i].resolved_at ? Date.parse(list[i].resolved_at) : Date.now();
      out.push({from: from, to: isNaN(to) ? Date.now() : to, title: list[i].title || 'Incident'});
    }

    return out;
  }

  /** Hours read in the visitor's own time; days are UTC days, so they are shown as UTC dates. */
  function slotTitle(slot) {
    var date = new Date(slot.t);

    // said out loud, or an evening visitor in the US reads tomorrow's date as a bug
    if (slot.size >= DAY) {
      return date.toLocaleDateString([], {month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC'}) + ' (UTC)';
    }

    var start = date.toLocaleString([], {weekday: 'short', hour: 'numeric'});

    if (slot.size === HOUR) {
      return start;
    }

    return start + ' – ' + new Date(slot.t + slot.size).toLocaleTimeString([], {hour: 'numeric'});
  }

  /** A handful of x labels on round times: every 6 hours, each midnight, or every week. */
  function ticksFor(slots) {
    var ticks = [];
    var i;

    if (!slots.length) {
      return ticks;
    }

    var size = slots[0].size;
    var count = slots.length;

    for (i = 0; i < count; i++) {
      var date = new Date(slots[i].t);

      if (size === HOUR && count <= 24) {
        if (date.getHours() % 6 === 0) {
          ticks.push({index: i, text: date.toLocaleTimeString([], {hour: 'numeric'})});
        }
      } else if (size === HOUR) {
        if (date.getHours() === 0) {
          ticks.push({index: i, text: date.toLocaleDateString([], {weekday: 'short'})});
        }
      } else if ((count - 1 - i) % (count > 30 ? 15 : 7) === 0) {
        ticks.push({index: i, text: date.toLocaleDateString([], {month: 'short', day: 'numeric', timeZone: 'UTC'})});
      }
    }

    return ticks;
  }

  function hasAny(slots, key) {
    for (var i = 0; i < slots.length; i++) {
      if (slots[i][key] != null) {
        return true;
      }
    }
    return false;
  }

  function values(slots, key) {
    var out = [];
    for (var i = 0; i < slots.length; i++) {
      if (slots[i][key] != null) {
        out.push(slots[i][key]);
      }
    }
    return out;
  }

  /** The range in four numbers, off the same slots the charts draw. */
  function renderTiles(slots, latency) {
    var row = el('div', 'tiles');

    function tile(name, value, note) {
      var node = el('div', 'tile');
      node.appendChild(el('div', 'tile-value', value));
      node.appendChild(el('div', 'tile-label', name));
      if (note) {
        node.appendChild(el('div', 'tile-note', note));
      }
      row.appendChild(node);
    }

    tile('Uptime', pct(mean(values(slots, 'uptime'))));

    if (latency) {
      tile('Typical', ms(median(values(slots, 'p50'))), 'median p50');

      if (hasAny(slots, 'p95')) {
        tile('Slow tail', ms(median(values(slots, 'p95'))), 'median p95');
      }

      var worstKey = hasAny(slots, 'max') ? 'max' : 'p50';
      var worst = null;
      for (var i = 0; i < slots.length; i++) {
        if (slots[i][worstKey] != null && (!worst || slots[i][worstKey] > worst[worstKey])) {
          worst = slots[i];
        }
      }

      tile('Slowest ' + (slots.length && slots[0].size >= DAY ? 'day' : 'hour'),
        ms(worst ? worst[worstKey] : null), worst ? slotTitle(worst) : null);
    }

    return row;
  }

  /** The chart's equivalent for a reader who cannot or would rather not hover: newest first. */
  function renderTable(slots, latency) {
    var details = el('details', 'table-view');
    details.appendChild(el('summary', null, 'View as table'));

    var table = el('table');
    var head = el('tr');
    var columns = ['Time', 'Uptime'];
    var keys = ['uptime'];

    if (latency) {
      for (var s = 0; s < SERIES.length; s++) {
        if (hasAny(slots, SERIES[s].key)) {
          columns.push(SERIES[s].label);
          keys.push(SERIES[s].key);
        }
      }
    }

    for (var c = 0; c < columns.length; c++) {
      head.appendChild(el('th', null, columns[c]));
    }

    var thead = el('thead');
    thead.appendChild(head);
    table.appendChild(thead);

    var body = el('tbody');

    for (var i = slots.length - 1; i >= 0; i--) {
      var tr = el('tr');
      tr.appendChild(el('td', null, slotTitle(slots[i])));

      for (var k = 0; k < keys.length; k++) {
        var value = slots[i][keys[k]];
        tr.appendChild(el('td', null, keys[k] === 'uptime' ? pct(value) : ms(value)));
      }

      body.appendChild(tr);
    }

    table.appendChild(body);

    var scroll = el('div', 'table-scroll');
    scroll.appendChild(table);
    details.appendChild(scroll);

    return details;
  }

  function renderAxis(range) {
    var axis = el('div', 'bars-axis');
    axis.appendChild(el('span', null, range.from));
    axis.appendChild(el('span', null, range.to));
    return axis;
  }

  /** The strip under a card's name: one service's uptime across the selected range. */
  function renderStrip(card, service, rangeKey) {
    var range = RANGES[rangeKey];
    var data = seriesFor(service.key, rangeKey);
    var up = mean(values(data.line, 'uptime'));

    card.strip.textContent = '';
    card.strip.appendChild(Chart.bars({
      slots: data.strip,
      start: data.start,
      end: data.end,
      incidents: incidentsFor(service.key),
      slotTitle: slotTitle,
      ariaLabel: service.name + ' uptime over the last ' + range.name + ': ' + pct(up)
    }));
    card.strip.appendChild(renderAxis(range));
  }

  /** Tiles, the response chart and the table, drawn only while the panel is open. */
  function renderDetail(card, service, rangeKey) {
    var range = RANGES[rangeKey];
    var detail = card.detail;

    detail.textContent = '';

    if (!state.history) {
      detail.appendChild(el('p', 'muted', 'History is not available yet. It is written once an hour.'));
      return;
    }

    var data = seriesFor(service.key, rangeKey);
    var latency = hasAny(data.line, 'p50');

    detail.appendChild(renderTiles(data.line, latency));

    if (latency) {
      var series = [];
      for (var s = 0; s < SERIES.length; s++) {
        // an older history.json has p50 only, and a legend entry for an empty series lies
        if (s === 0 || hasAny(data.line, SERIES[s].key)) {
          series.push(SERIES[s]);
        }
      }

      detail.appendChild(el('h4', 'chart-title', 'Response time (ms)'));
      detail.appendChild(Chart.line({
        slots: data.line,
        series: series,
        start: data.start,
        end: data.end,
        ticks: ticksFor(data.line),
        shading: incidentsFor(service.key),
        slotTitle: slotTitle,
        hidden: state.hidden,
        onToggle: function (seriesKey) {
          toggleSeries(seriesKey, card);
        },
        width: detail.clientWidth,
        ariaLabel: service.name + ' response time over the last ' + range.name + ': typical ' +
          ms(median(values(data.line, 'p50'))) + '. Use the arrow keys to read each ' +
          (data.line[0].size >= DAY ? 'day' : 'hour') + ', or open the table below.'
      }));
    } else if (service.latency_ms == null && !hasAny(seriesFor(service.key, '90d').line, 'p50')) {
      detail.appendChild(el('p', 'muted', 'This service has no response time, only up or down.'));
    } else {
      detail.appendChild(el('p', 'muted', 'No response times were recorded in the last ' + range.name + '.'));
    }

    detail.appendChild(renderTable(data.line, latency));
  }

  function toggleSeries(seriesKey, from) {
    state.hidden[seriesKey] = !state.hidden[seriesKey];

    var shown = 0;
    for (var s = 0; s < SERIES.length; s++) {
      if (!state.hidden[SERIES[s].key]) {
        shown++;
      }
    }

    // the last line on the chart stays: an empty plot reads as no data
    if (!shown) {
      state.hidden[seriesKey] = false;
      return;
    }

    for (var key in state.cards) {
      if (Object.prototype.hasOwnProperty.call(state.cards, key)) {
        state.cards[key].detailKey = '';
      }
    }

    render();

    // the legend was redrawn under the pointer, so keyboard focus goes back to the same button
    var again = from.detail.querySelector('.legend-item[data-key="' + seriesKey + '"]');
    if (again) {
      again.focus();
    }
  }

  /** What a card was last drawn for. A 60s poll that changes none of it leaves the charts alone. */
  function drawKey(rangeKey) {
    return rangeKey + '|' + (state.history ? state.history.generated_at : 'none') + '|' + state.width;
  }

  function buildCard(service) {
    var key = service.key;
    var id = 'detail-' + String(key).replace(/[^A-Za-z0-9_-]/g, '');
    var card = {key: key, stripKey: '', detailKey: ''};

    card.root = el('div', 'svc');

    var top = el('div', 'svc-top');
    card.name = el('span', 'svc-name', service.name);
    card.state = el('span', 'state');
    top.appendChild(card.name);
    top.appendChild(card.state);
    card.root.appendChild(top);

    var metaRow = el('div', 'svc-meta-row');
    card.meta = el('div', 'svc-meta');
    card.toggle = el('button', 'details-toggle', 'Details');
    card.toggle.type = 'button';
    card.toggle.setAttribute('aria-controls', id);
    metaRow.appendChild(card.meta);
    metaRow.appendChild(card.toggle);
    card.root.appendChild(metaRow);

    card.strip = el('div', 'strip-host');
    card.root.appendChild(card.strip);

    card.detail = el('div', 'detail');
    card.detail.id = id;
    card.root.appendChild(card.detail);

    card.toggle.addEventListener('click', function () {
      state.expanded[key] = !state.expanded[key];
      updateCard(card, card.service);
    });

    return card;
  }

  function updateCard(card, service) {
    var rangeKey = effectiveRange();
    var key = drawKey(rangeKey);
    var open = !!state.expanded[card.key];

    card.service = service;

    text(card.name, service.name);
    card.state.className = 'state state-' + (service.state || 'unknown');
    text(card.state, label(service.state));

    card.meta.textContent = '';
    // the data pipeline has no response time, and neither does a service that did not answer
    if (service.latency_ms != null) {
      card.meta.appendChild(el('span', null, 'Response ' + ms(service.latency_ms)));
    }
    card.meta.appendChild(el('span', null, '24h ' + pct(service.uptime_24h)));
    card.meta.appendChild(el('span', null, '90d ' + pct(service.uptime_90d)));

    if (card.stripKey !== key) {
      card.stripKey = key;
      renderStrip(card, service, rangeKey);
    }

    card.toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
    text(card.toggle, open ? 'Hide details' : 'Details');
    card.detail.hidden = !open;

    // drawn after it is visible: the line chart needs the panel's real width
    if (open && card.detailKey !== key) {
      card.detailKey = key;
      renderDetail(card, service, rangeKey);
    }
  }

  function renderServices(snapshot) {
    var root = $('services');
    var services = snapshot.services || [];
    var layout = [];
    var i;

    for (i = 0; i < services.length; i++) {
      layout.push((services[i].group || 'Other') + '/' + services[i].key);
    }

    // cards are kept between polls, so an open panel, a tooltip or keyboard focus survives them
    if (layout.join('|') !== state.layout || !root.querySelector('.svc')) {
      state.layout = layout.join('|');
      state.cards = {};
      root.innerHTML = '';

      if (!services.length) {
        root.appendChild(el('p', 'muted', 'No services are being reported yet.'));
        return;
      }

      var groups = [];
      var byGroup = {};

      for (i = 0; i < services.length; i++) {
        var name = services[i].group || 'Other';
        if (!byGroup[name]) {
          byGroup[name] = el('div', 'group');
          byGroup[name].appendChild(el('h3', null, name));
          groups.push(byGroup[name]);
        }
        var card = buildCard(services[i]);
        state.cards[services[i].key] = card;
        byGroup[name].appendChild(card.root);
      }

      for (i = 0; i < groups.length; i++) {
        root.appendChild(groups[i]);
      }
    }

    for (i = 0; i < services.length; i++) {
      updateCard(state.cards[services[i].key], services[i]);
    }
  }

  var overviewKey = '';

  /** Every public service at once: each slot shows the worst one, and the tooltip names them. */
  function renderOverview(snapshot) {
    var host = $('overview-chart');
    var rangeKey = effectiveRange();
    var range = RANGES[rangeKey];
    var key = drawKey(rangeKey) + '|' + state.layout;

    if (key === overviewKey) {
      return;
    }
    overviewKey = key;

    host.textContent = '';

    var services = snapshot.services || [];

    if (!state.history || !services.length) {
      host.appendChild(el('p', 'muted', state.history ? 'No services are being reported yet.' : 'History is not available yet. It is written once an hour.'));
      return;
    }

    var per = [];
    var i;
    var start = 0;
    var end = 0;

    for (i = 0; i < services.length; i++) {
      var data = seriesFor(services[i].key, rangeKey);
      per.push({name: services[i].name, strip: data.strip});
      start = data.start;
      end = data.end;
    }

    var slots = [];
    var count = per[0].strip.length;

    for (var s = 0; s < count; s++) {
      var worst = null;
      for (i = 0; i < per.length; i++) {
        var value = per[i].strip[s].uptime;
        if (value != null && (worst === null || value < worst)) {
          worst = value;
        }
      }
      slots.push({t: per[0].strip[s].t, size: per[0].strip[s].size, uptime: worst});
    }

    host.appendChild(Chart.bars({
      slots: slots,
      start: start,
      end: end,
      incidents: incidentsFor(null),
      slotTitle: slotTitle,
      ariaLabel: 'Uptime of the worst affected service across the last ' + range.name,
      rows: function (slot, index) {
        var rows = [];
        for (var k = 0; k < per.length; k++) {
          var up = per[k].strip[index].uptime;
          if (up != null && up < 1) {
            rows.push({value: pct(up), label: per[k].name});
          }
        }
        if (slot.uptime != null && !rows.length) {
          rows.push({value: 'All up', label: ''});
        }
        return rows;
      }
    }));
    host.appendChild(renderAxis(range));
  }

  function renderRanges() {
    var buttons = document.querySelectorAll('[data-range]');
    var hourly = !!(state.history && state.history.hourly);
    var actual = effectiveRange();

    for (var i = 0; i < buttons.length; i++) {
      var key = buttons[i].getAttribute('data-range');
      buttons[i].setAttribute('aria-pressed', key === actual ? 'true' : 'false');
      buttons[i].disabled = RANGES[key].hourly && !hourly && !!state.history;
    }

    var note = $('range-note');
    if (actual !== state.range) {
      text(note, 'Hourly detail is not available yet, so this shows ' + RANGES[actual].name + '.');
      note.hidden = false;
    } else {
      note.hidden = true;
    }
  }

  function renderIncidents(snapshot) {
    var root = $('incidents');
    var list = snapshot.incidents || [];
    var i;

    root.innerHTML = '';

    if (!list.length) {
      root.appendChild(el('p', 'muted', 'No incidents in the last ' + INCIDENT_DAYS + ' days.'));
      return;
    }

    for (i = 0; i < list.length; i++) {
      var incident = list[i];
      var resolved = incident.state === 'resolved';
      var card = el('div', 'inc ' + (resolved ? 'inc-resolved' : 'inc-open'));

      card.appendChild(el('h4', null, incident.title || 'Incident'));

      if (incident.body) {
        card.appendChild(el('p', null, incident.body));
      }

      var when = incident.started_at ? new Date(incident.started_at) : null;
      var stamp = el('time', null, incidentLabel(incident.state) +
        (when && !isNaN(when.getTime()) ? ' · started ' + when.toLocaleString() : ''));

      if (when && !isNaN(when.getTime())) {
        stamp.setAttribute('datetime', when.toISOString());
      }

      card.appendChild(stamp);
      root.appendChild(card);
    }
  }

  function renderNotices(snapshot) {
    var root = $('notices');
    var list = snapshot.notices || [];

    root.innerHTML = '';

    for (var i = 0; i < list.length; i++) {
      root.appendChild(el('div', 'notice notice-warn', list[i]));
    }
  }

  /**
   * The snapshot is written by a scraper handler. If that handler dies the file stops changing
   * while every service in it still reads green, so the page has to say when what it is showing
   * is too old to trust rather than quietly lie.
   */
  function renderStale(snapshot) {
    var node = $('stale');
    var generated = new Date(snapshot.generated_at);

    if (isNaN(generated.getTime())) {
      node.hidden = true;
      return false;
    }

    var age = Date.now() - generated.getTime();
    var allowed = Math.max((snapshot.interval_ms || POLL_MS) * 3, 3 * POLL_MS);

    if (age > allowed) {
      text(node, 'These checks last ran ' + Math.round(age / 60000) +
        ' minutes ago, so what you see below may be out of date.');
      node.hidden = false;
      return true;
    }

    node.hidden = true;
    return false;
  }

  /**
   * The prober is forked by the scraper manager and exits with it, so a snapshot that stopped
   * updating is the one sign the pipeline is not running. Nothing else can report it.
   */
  function markPipelineDown(snapshot) {
    var list = snapshot.services || [];

    for (var i = 0; i < list.length; i++) {
      if (list[i].key === 'pipeline') {
        list[i].state = 'down';
      }
    }
  }

  function renderBanner(snapshot, stale) {
    var node = $('banner');
    var state = snapshot.state || 'unknown';

    node.className = 'banner banner-' + (stale ? 'unknown' : state);

    if (stale) {
      text($('banner-text'), 'Status may be out of date');
      return;
    }

    if (state === 'operational') {
      text($('banner-text'), 'All systems operational');
    } else if (state === 'degraded') {
      // degraded is also a probe that just failed and has not reached the down threshold yet
      text($('banner-text'), 'Some systems are degraded');
    } else if (state === 'down') {
      text($('banner-text'), 'Some systems are down');
    } else {
      text($('banner-text'), 'Status unknown');
    }
  }

  function render() {
    var snapshot = state.snapshot;

    if (!snapshot) {
      return;
    }

    var stale = renderStale(snapshot);

    if (stale) {
      markPipelineDown(snapshot);
    }

    renderBanner(snapshot, stale);
    renderNotices(snapshot);
    renderRanges();
    renderOverview(snapshot);
    renderServices(snapshot);
    renderIncidents(snapshot);

    var generated = new Date(snapshot.generated_at);
    text($('generated'), isNaN(generated.getTime())
      ? ''
      : 'Last checked ' + generated.toLocaleString());
  }

  function fail(message) {
    var node = $('banner');
    node.className = 'banner banner-unknown';
    text($('banner-text'), message);
    state.layout = '';
    state.cards = {};
    overviewKey = '';
    $('services').innerHTML = '';
    $('services').appendChild(el('p', 'muted', 'Checks could not be loaded. If the rest of the site is also unreachable, the outage is wider than this page can report.'));
    $('overview-chart').innerHTML = '';
    $('overview-chart').appendChild(el('p', 'muted', 'Not available while the checks cannot be loaded.'));
    $('incidents').innerHTML = '';
  }

  // cache busted explicitly: a cached snapshot is worse than no snapshot
  function fetchJson(name) {
    return fetch(name + '?t=' + Date.now(), {cache: 'no-store'}).then(function (r) {
      if (!r.ok) { throw new Error(name + ' ' + r.status); }
      return r.json();
    });
  }

  function loadStatus() {
    fetchJson('status.json').then(function (snapshot) {
      state.snapshot = snapshot;
      render();
    }).catch(function () {
      state.snapshot = null;
      fail('Status could not be loaded');
    });
  }

  // history is optional: it does not exist until the first hourly rollup has run
  function loadHistory() {
    fetchJson('history.json').then(function (history) {
      state.history = history;
    }).catch(function () {
      state.history = null;
    }).then(render);
  }

  function measure() {
    // the panels share one width, so any card's content box will do; bucketed to skip tiny resizes
    var probe = $('services');
    return Math.round((probe ? probe.clientWidth : 0) / 20) * 20;
  }

  function wireRanges() {
    var buttons = document.querySelectorAll('[data-range]');

    for (var i = 0; i < buttons.length; i++) {
      buttons[i].addEventListener('click', function (event) {
        var key = event.currentTarget.getAttribute('data-range');
        if (!RANGES[key]) {
          return;
        }
        state.range = key;
        saveRange(key);
        render();
      });
    }
  }

  var resizeTimer = null;

  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      var width = measure();
      if (width !== state.width) {
        state.width = width;
        render();
      }
    }, 150);
  });

  state.width = measure();
  wireRanges();
  loadStatus();
  loadHistory();
  setInterval(loadStatus, POLL_MS);
  setInterval(loadHistory, HISTORY_POLL_MS);
}());

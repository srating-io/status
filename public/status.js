/*
 * Reads the two json files the prober writes and renders them. No framework and no api call: the
 * internal api is one of the things this page reports on, so it cannot be a dependency of it.
 */
(function () {
  'use strict';

  var DAYS = 90;
  var POLL_MS = 60 * 1000;

  /** Below this a day is drawn as an outage rather than a wobble. */
  var UPTIME_OK = 0.999;
  var UPTIME_WARN = 0.95;

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

  function pct(value) {
    if (value == null) {
      return '–';
    }
    // two decimals below 100 so 99.99 and 100 are not both "100%"
    var n = value * 100;
    return (n >= 99.995 ? n.toFixed(0) : n.toFixed(2)) + '%';
  }

  function ms(value) {
    if (value == null) {
      return '–';
    }
    return value >= 1000 ? (value / 1000).toFixed(2) + ' s' : Math.round(value) + ' ms';
  }

  function dayKey(date) {
    return date.toISOString().slice(0, 10);
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

  function barClass(uptime) {
    if (uptime == null) { return 'bar'; }
    if (uptime >= UPTIME_OK) { return 'bar bar-ok'; }
    if (uptime >= UPTIME_WARN) { return 'bar bar-warn'; }
    return 'bar bar-down';
  }

  /** 90 fixed slots, so a gap in the history reads as "no data" rather than shifting the axis. */
  function renderBars(buckets) {
    var byDay = {};
    var i;

    for (i = 0; i < buckets.length; i++) {
      byDay[String(buckets[i].bucket).slice(0, 10)] = buckets[i];
    }

    var wrap = el('div', 'bars');
    var now = new Date();

    for (i = DAYS - 1; i >= 0; i--) {
      var date = new Date(now.getTime() - (i * 86400000));
      var key = dayKey(date);
      var bucket = byDay[key];
      var uptime = bucket ? bucket.uptime : null;
      var bar = el('div', barClass(uptime));

      bar.title = key + (uptime == null ? ': no data' : ': ' + pct(uptime) + ' uptime');
      wrap.appendChild(bar);
    }

    return wrap;
  }

  /** Latency trend. Drawn only when there are at least two points to draw a line between. */
  function renderSpark(buckets) {
    var points = [];
    var i;

    for (i = 0; i < buckets.length; i++) {
      if (buckets[i].p50_ms != null) {
        points.push(Number(buckets[i].p50_ms));
      }
    }

    if (points.length < 2) {
      return null;
    }

    var max = Math.max.apply(null, points);
    var min = Math.min.apply(null, points);
    var span = max - min || 1;
    var width = 100;
    var height = 34;
    var d = '';

    for (i = 0; i < points.length; i++) {
      var x = (i / (points.length - 1)) * width;
      var y = height - 2 - (((points[i] - min) / span) * (height - 4));
      d += (i === 0 ? 'M' : 'L') + x.toFixed(2) + ' ' + y.toFixed(2);
    }

    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'spark');
    svg.setAttribute('viewBox', '0 0 ' + width + ' ' + height);
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', 'Median response time trend, ' + ms(points[0]) + ' to ' + ms(points[points.length - 1]));

    var path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);

    return svg;
  }

  function renderService(service, history) {
    var card = el('div', 'svc');
    var top = el('div', 'svc-top');

    top.appendChild(el('span', 'svc-name', service.name));
    top.appendChild(el('span', 'state state-' + (service.state || 'unknown'), label(service.state)));
    card.appendChild(top);

    var meta = el('div', 'svc-meta');
    // the data pipeline has no response time, and neither does a service that did not answer
    if (service.latency_ms != null) {
      meta.appendChild(el('span', null, 'Response ' + ms(service.latency_ms)));
    }
    meta.appendChild(el('span', null, '24h ' + pct(service.uptime_24h)));
    meta.appendChild(el('span', null, '90d ' + pct(service.uptime_90d)));
    card.appendChild(meta);

    var buckets = (history && history.services && history.services[service.key]) || [];
    card.appendChild(renderBars(buckets));

    var axis = el('div', 'bars-axis');
    axis.appendChild(el('span', null, '90 days ago'));
    axis.appendChild(el('span', null, 'today'));
    card.appendChild(axis);

    var spark = renderSpark(buckets);
    if (spark) {
      card.appendChild(spark);
    }

    return card;
  }

  function renderServices(snapshot, history) {
    var root = $('services');
    var groups = [];
    var byGroup = {};
    var i;

    for (i = 0; i < snapshot.services.length; i++) {
      var service = snapshot.services[i];
      var name = service.group || 'Other';

      if (!byGroup[name]) {
        byGroup[name] = [];
        groups.push(name);
      }

      byGroup[name].push(service);
    }

    root.innerHTML = '';

    if (!groups.length) {
      root.appendChild(el('p', 'muted', 'No services are being reported yet.'));
      return;
    }

    for (i = 0; i < groups.length; i++) {
      var block = el('div', 'group');
      block.appendChild(el('h3', null, groups[i]));

      for (var j = 0; j < byGroup[groups[i]].length; j++) {
        block.appendChild(renderService(byGroup[groups[i]][j], history));
      }

      root.appendChild(block);
    }
  }

  function renderIncidents(snapshot) {
    var root = $('incidents');
    var list = snapshot.incidents || [];
    var i;

    root.innerHTML = '';

    if (!list.length) {
      root.appendChild(el('p', 'muted', 'No incidents in the last ' + DAYS + ' days.'));
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

  function fail(message) {
    var node = $('banner');
    node.className = 'banner banner-unknown';
    text($('banner-text'), message);
    $('services').innerHTML = '';
    $('services').appendChild(el('p', 'muted', 'Checks could not be loaded. If the rest of the site is also unreachable, the outage is wider than this page can report.'));
    $('incidents').innerHTML = '';
  }

  function load() {
    // cache busted explicitly: a cached snapshot is worse than no snapshot
    var bust = '?t=' + Date.now();

    Promise.all([
      fetch('status.json' + bust, {cache: 'no-store'}).then(function (r) {
        if (!r.ok) { throw new Error('status ' + r.status); }
        return r.json();
      }),
      // history is optional: it does not exist until the first hourly rollup has run
      fetch('history.json' + bust, {cache: 'no-store'}).then(function (r) {
        return r.ok ? r.json() : null;
      }).catch(function () { return null; })
    ]).then(function (results) {
      var snapshot = results[0];
      var history = results[1];
      var stale = renderStale(snapshot);

      if (stale) {
        markPipelineDown(snapshot);
      }

      renderBanner(snapshot, stale);
      renderNotices(snapshot);
      renderServices(snapshot, history);
      renderIncidents(snapshot);

      var generated = new Date(snapshot.generated_at);
      text($('generated'), isNaN(generated.getTime())
        ? ''
        : 'Last checked ' + generated.toLocaleString());
    }).catch(function () {
      fail('Status could not be loaded');
    });
  }

  load();
  setInterval(load, POLL_MS);
}());

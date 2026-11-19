/*
 * The two charts the page draws: a response time line and an uptime strip. Hand-written SVG and
 * HTML with no library, for the same reason the page has no framework: it must render when every
 * other srating.io service is down.
 *
 * Everything shown comes from json, so text only ever reaches the DOM through textContent.
 */
(function () {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

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

  function svg(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    for (var name in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, name)) {
        node.setAttribute(name, String(attrs[name]));
      }
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

  /** "12 min", "3 h 5 min" -- how long an uptime fraction was down for in a slot of `size` ms. */
  function downtime(uptime, size) {
    var minutes = Math.round((1 - uptime) * size / 60000);
    if (minutes < 60) {
      return minutes + ' min';
    }
    var hours = Math.floor(minutes / 60);
    var rest = minutes % 60;
    return hours + ' h' + (rest ? ' ' + rest + ' min' : '');
  }

  /** Below these an hour or a day is drawn as trouble rather than a wobble. */
  var UPTIME_OK = 0.999;
  var UPTIME_WARN = 0.95;

  function barClass(uptime) {
    if (uptime == null) { return 'bar'; }
    if (uptime >= UPTIME_OK) { return 'bar bar-ok'; }
    if (uptime >= UPTIME_WARN) { return 'bar bar-warn'; }
    return 'bar bar-down';
  }

  /** A round axis top and step, so ticks read 0 / 200 / 400 rather than 0 / 173 / 346. */
  function niceScale(top) {
    if (!(top > 0)) {
      return {max: 100, step: 50};
    }
    var raw = top / 3;
    var magnitude = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10));
    var n = raw / magnitude;
    var step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * magnitude;
    return {max: Math.ceil(top / step) * step, step: step};
  }

  /** Axis numbers stay unitless; the chart title says ms. */
  function tickText(value) {
    return value >= 1000 ? (value / 1000) + 'k' : String(Math.round(value));
  }

  /**
   * One tooltip per chart. `rows` are {color, value, label}: the value leads and the label follows,
   * and a series is keyed by a short stroke of its color, never by colored text.
   */
  function tooltip(host) {
    var node = el('div', 'tip');
    node.hidden = true;
    node.setAttribute('role', 'status');
    host.appendChild(node);

    return {
      show: function (title, rows, x) {
        node.textContent = '';
        node.appendChild(el('div', 'tip-head', title));

        for (var i = 0; i < rows.length; i++) {
          var row = el('div', 'tip-row');
          var key = el('span', 'tip-key' + (rows[i].color ? '' : ' tip-key-none'));
          if (rows[i].color) {
            key.style.background = rows[i].color;
          }
          row.appendChild(key);
          row.appendChild(el('strong', null, rows[i].value));
          if (rows[i].label) {
            row.appendChild(el('span', 'tip-label', rows[i].label));
          }
          node.appendChild(row);
        }

        node.hidden = false;

        // kept inside the chart: flipped to the left of the pointer past the midpoint
        var width = host.clientWidth;
        var tipWidth = node.offsetWidth;
        var left = x + 14;
        if (left + tipWidth > width) {
          left = Math.max(0, x - tipWidth - 14);
        }
        node.style.left = left + 'px';
      },
      hide: function () {
        node.hidden = true;
      }
    };
  }

  /**
   * Pointer and keyboard both land on a slot index. The pointer snaps to the nearest slot, so a
   * reader aims at a time rather than at a 2px line; arrows, Home and End do the same from focus.
   */
  function scrub(target, count, indexAt, onIndex) {
    var current = null;
    var focused = false;

    function set(index) {
      current = index;
      onIndex(index);
    }

    target.tabIndex = 0;

    target.addEventListener('pointermove', function (event) {
      var index = indexAt(event.clientX - target.getBoundingClientRect().left);
      if (index !== current) {
        set(index);
      }
    });

    target.addEventListener('pointerleave', function () {
      if (!focused) {
        set(null);
      }
    });

    target.addEventListener('focus', function () {
      focused = true;
      set(current == null ? count - 1 : current);
    });

    target.addEventListener('blur', function () {
      focused = false;
      set(null);
    });

    target.addEventListener('keydown', function (event) {
      var next = current == null ? count - 1 : current;

      if (event.key === 'ArrowLeft') {
        next = Math.max(0, next - 1);
      } else if (event.key === 'ArrowRight') {
        next = Math.min(count - 1, next + 1);
      } else if (event.key === 'Home') {
        next = 0;
      } else if (event.key === 'End') {
        next = count - 1;
      } else if (event.key === 'Escape') {
        set(null);
        return;
      } else {
        return;
      }

      event.preventDefault();
      set(next);
    });
  }

  /**
   * Response time over time.
   *
   * opts.slots     [{t, size, p50, p95, max, uptime}], oldest first
   * opts.series    [{key, label, color, width, area}], drawn on one ms axis -- never a second one
   * opts.hidden    {key: true} for series the reader switched off in the legend
   * opts.onToggle  (key) -> void, called by a legend button
   * opts.start/end the window, in ms since epoch
   * opts.ticks     [{index, text}] for the x axis
   * opts.shading   [{from, to, title}], incident spans washed behind the lines
   * opts.slotTitle (slot) -> string for the tooltip header
   * opts.width     the pixel width to draw at
   */
  function line(opts) {
    var slots = opts.slots;
    var all = opts.series;
    var hidden = opts.hidden || {};
    var n = slots.length;
    var s;

    // a hidden series leaves the scale too, which is the point: one worst-case spike otherwise
    // flattens the typical line the chart is about
    var series = [];
    for (s = 0; s < all.length; s++) {
      if (!hidden[all[s].key]) {
        series.push(all[s]);
      }
    }
    if (!series.length) {
      series.push(all[0]);
    }

    var wrap = el('div', 'chart');
    var legend = el('div', 'legend');

    for (s = 0; s < all.length; s++) {
      var shown = series.indexOf(all[s]) !== -1;
      var item = el('button', 'legend-item');
      var key = el('span', 'legend-key');
      key.style.background = all[s].color;
      item.type = 'button';
      item.setAttribute('data-key', all[s].key);
      item.setAttribute('aria-pressed', shown ? 'true' : 'false');
      item.title = (shown ? 'Hide ' : 'Show ') + all[s].label;
      item.appendChild(key);
      item.appendChild(document.createTextNode(all[s].label));
      if (opts.onToggle) {
        item.addEventListener('click', opts.onToggle.bind(null, all[s].key));
      } else {
        item.disabled = true;
      }
      legend.appendChild(item);
    }

    wrap.appendChild(legend);

    var plot = el('div', 'plot');
    plot.setAttribute('role', 'img');
    plot.setAttribute('aria-label', opts.ariaLabel || 'Response time chart');
    wrap.appendChild(plot);

    var W = Math.max(240, Math.floor(opts.width));
    var H = 180;
    var M = {top: 10, right: 58, bottom: 24, left: 40};
    var iw = W - M.left - M.right;
    var ih = H - M.top - M.bottom;

    var top = 0;
    var i;
    for (i = 0; i < n; i++) {
      for (s = 0; s < series.length; s++) {
        var v = slots[i][series[s].key];
        if (v != null && v > top) {
          top = v;
        }
      }
    }

    var scale = niceScale(top);

    function x(index) {
      return M.left + ((index + 0.5) / n) * iw;
    }

    function xAt(time) {
      return M.left + ((time - opts.start) / (opts.end - opts.start)) * iw;
    }

    function y(value) {
      return M.top + ih - (value / scale.max) * ih;
    }

    var root = svg('svg', {'class': 'chart-svg', 'width': W, 'height': H, 'viewBox': '0 0 ' + W + ' ' + H, 'aria-hidden': 'true'});

    var shading = opts.shading || [];
    for (i = 0; i < shading.length; i++) {
      var from = Math.max(shading[i].from, opts.start);
      var to = Math.min(shading[i].to, opts.end);
      if (to > from) {
        root.appendChild(svg('rect', {
          'class': 'shade',
          'x': xAt(from).toFixed(1),
          'y': M.top,
          // a two minute incident would otherwise be invisible on a 90 day axis
          'width': Math.max(3, xAt(to) - xAt(from)).toFixed(1),
          'height': ih
        }));
      }
    }

    for (var tick = 0; tick <= scale.max + scale.step / 2; tick += scale.step) {
      root.appendChild(svg('line', {'class': 'grid', 'x1': M.left, 'x2': M.left + iw, 'y1': y(tick), 'y2': y(tick)}));
      var label = svg('text', {'class': 'tick', 'x': M.left - 6, 'y': y(tick) + 4, 'text-anchor': 'end'});
      label.textContent = tickText(tick);
      root.appendChild(label);
    }

    var ticks = opts.ticks || [];
    var lastRight = -Infinity;
    for (i = 0; i < ticks.length; i++) {
      // ~6px a character at 11px; centered, and held inside the plot rather than hanging off it
      var half = ticks[i].text.length * 3 + 2;
      var tx = Math.min(Math.max(x(ticks[i].index), M.left + half), M.left + iw - half);

      // on a phone a label that would touch the previous one is dropped rather than overlapped
      if (tx - half < lastRight + 8) {
        continue;
      }
      lastRight = tx + half;

      var xt = svg('text', {'class': 'tick', 'x': tx, 'y': H - 6, 'text-anchor': 'middle'});
      xt.textContent = ticks[i].text;
      root.appendChild(xt);
    }

    // drawn back to front, so the line the chart is about sits on top
    for (s = series.length - 1; s >= 0; s--) {
      var spec = series[s];
      var runs = [];
      var run = [];

      // a missing hour breaks the line rather than being bridged by a guess
      for (i = 0; i < n; i++) {
        var value = slots[i][spec.key];
        if (value == null) {
          if (run.length) { runs.push(run); }
          run = [];
        } else {
          run.push([x(i), y(value)]);
        }
      }
      if (run.length) { runs.push(run); }

      for (var r = 0; r < runs.length; r++) {
        var points = runs[r];
        var d = '';
        for (var p = 0; p < points.length; p++) {
          d += (p ? 'L' : 'M') + points[p][0].toFixed(1) + ' ' + points[p][1].toFixed(1);
        }

        if (spec.area && points.length > 1) {
          root.appendChild(svg('path', {
            'class': 'area',
            'd': d + 'L' + points[points.length - 1][0].toFixed(1) + ' ' + y(0) + 'L' + points[0][0].toFixed(1) + ' ' + y(0) + 'Z',
            'fill': spec.color
          }));
        }

        if (points.length === 1) {
          // a lone point between two gaps has no line to sit on
          root.appendChild(svg('circle', {'cx': points[0][0], 'cy': points[0][1], 'r': 2, 'fill': spec.color}));
        } else {
          root.appendChild(svg('path', {'class': 'series', 'd': d, 'stroke': spec.color, 'stroke-width': spec.width || 2}));
        }
      }
    }

    // the one direct label: the latest typical value, at the end of its line
    var lead = series[0];
    for (i = n - 1; i >= 0; i--) {
      if (slots[i][lead.key] != null) {
        var endLabel = svg('text', {'class': 'end-label', 'x': x(i) + 8, 'y': y(slots[i][lead.key]) + 4});
        endLabel.textContent = ms(slots[i][lead.key]);
        root.appendChild(endLabel);
        break;
      }
    }

    var crosshair = svg('line', {'class': 'crosshair', 'y1': M.top, 'y2': M.top + ih, 'visibility': 'hidden'});
    root.appendChild(crosshair);

    var dots = [];
    for (s = 0; s < series.length; s++) {
      var dot = svg('circle', {'class': 'dot', 'r': 4, 'fill': series[s].color, 'visibility': 'hidden'});
      dots.push(dot);
      root.appendChild(dot);
    }

    plot.appendChild(root);

    var tip = tooltip(plot);

    scrub(plot, n, function (px) {
      var index = Math.floor(((px - M.left) / iw) * n);
      return Math.min(n - 1, Math.max(0, index));
    }, function (index) {
      if (index == null) {
        crosshair.setAttribute('visibility', 'hidden');
        for (var k = 0; k < dots.length; k++) {
          dots[k].setAttribute('visibility', 'hidden');
        }
        tip.hide();
        return;
      }

      var slot = slots[index];
      var cx = x(index);
      var rows = [];

      crosshair.setAttribute('x1', cx);
      crosshair.setAttribute('x2', cx);
      crosshair.setAttribute('visibility', 'visible');

      for (var j = 0; j < series.length; j++) {
        var at = slot[series[j].key];
        if (at == null) {
          dots[j].setAttribute('visibility', 'hidden');
        } else {
          dots[j].setAttribute('cx', cx);
          dots[j].setAttribute('cy', y(at));
          dots[j].setAttribute('visibility', 'visible');
        }
        rows.push({color: series[j].color, value: ms(at), label: series[j].label});
      }

      rows.push({value: pct(slot.uptime), label: 'uptime'});

      var titles = overlapping(shading, slot.t, slot.t + slot.size);
      for (var q = 0; q < titles.length; q++) {
        rows.push({value: 'Incident', label: titles[q]});
      }

      tip.show(opts.slotTitle(slot), rows, cx);
    });

    return wrap;
  }

  function overlapping(spans, from, to) {
    var titles = [];
    for (var i = 0; spans && i < spans.length; i++) {
      if (spans[i].from < to && spans[i].to > from) {
        titles.push(spans[i].title);
      }
    }
    return titles;
  }

  /**
   * Uptime as a strip of slots colored by status, with incidents as a track underneath.
   *
   * opts.slots     [{t, size, uptime}], oldest first
   * opts.start/end the window, in ms since epoch
   * opts.incidents [{from, to, title}]
   * opts.slotTitle (slot) -> string
   * opts.rows      optional (slot, index) -> extra tooltip rows
   */
  function bars(opts) {
    var slots = opts.slots;
    var n = slots.length;
    var wrap = el('div', 'strip');
    var row = el('div', 'bars');
    var nodes = [];

    wrap.setAttribute('role', 'img');
    wrap.setAttribute('aria-label', opts.ariaLabel || 'Uptime');

    for (var i = 0; i < n; i++) {
      var bar = el('div', barClass(slots[i].uptime));
      nodes.push(bar);
      row.appendChild(bar);
    }

    wrap.appendChild(row);

    var incidents = opts.incidents || [];
    if (incidents.length) {
      var track = el('div', 'incident-track');
      var span = opts.end - opts.start;

      for (i = 0; i < incidents.length; i++) {
        var from = Math.max(incidents[i].from, opts.start);
        var to = Math.min(incidents[i].to, opts.end);
        if (to > from) {
          var mark = el('span', 'incident-mark');
          mark.style.left = ((from - opts.start) / span * 100).toFixed(3) + '%';
          // wide enough to see on a 90 day strip, which a twenty minute incident otherwise is not
          mark.style.width = 'max(4px, ' + ((to - from) / span * 100).toFixed(3) + '%)';
          track.appendChild(mark);
        }
      }

      wrap.appendChild(track);
    }

    var tip = tooltip(wrap);
    var active = null;

    scrub(wrap, n, function (px) {
      var index = Math.floor((px / wrap.clientWidth) * n);
      return Math.min(n - 1, Math.max(0, index));
    }, function (index) {
      if (active != null) {
        nodes[active].classList.remove('bar-active');
      }
      active = index;

      if (index == null) {
        tip.hide();
        return;
      }

      nodes[index].classList.add('bar-active');

      var slot = slots[index];
      var rows = [];

      if (slot.uptime == null) {
        rows.push({value: 'No data', label: ''});
      } else {
        rows.push({value: pct(slot.uptime), label: 'uptime'});
        if (slot.uptime < 1) {
          rows.push({value: '~' + downtime(slot.uptime, slot.size), label: 'down'});
        }
      }

      if (opts.rows) {
        rows = rows.concat(opts.rows(slot, index));
      }

      var titles = overlapping(incidents, slot.t, slot.t + slot.size);
      for (var q = 0; q < titles.length; q++) {
        rows.push({value: 'Incident', label: titles[q]});
      }

      var center = ((index + 0.5) / n) * wrap.clientWidth;
      tip.show(opts.slotTitle(slot), rows, center);
    });

    return wrap;
  }

  window.StatusChart = {
    line: line,
    bars: bars,
    format: {pct: pct, ms: ms, downtime: downtime}
  };
}());

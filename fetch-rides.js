/* ===========================================================================
   CITI BIKE WRAPPED — fetch-rides.js
   ---------------------------------------------------------------------------
   Injected by a loader bookmarklet while you're on
   account.citibikenyc.com/ride-history. Because the bookmarklet appends this
   as a <script> tag to THAT page, this code runs in citibikenyc.com's origin,
   so everything it reads is already yours. Nothing is sent anywhere.

   HOW IT GETS THE DATA (determined by inspecting the live site)
     The page is Next.js + Apollo GraphQL. Two things rule out intercepting
     the network:
       1. the first 10 rides are server-rendered into __NEXT_DATA__, so no
          request happens for them at all
       2. Apollo binds its own `fetch` reference when the client is built at
          page load — a bookmarklet patching window.fetch afterwards never
          sees Apollo's traffic
     And the GraphQL query text is stripped by the production build, while the
     Apollo cache key is `rideHistory({})` — pagination arguments are hidden
     behind a keyArgs:[] merge policy, so they can't be recovered either.

     So: click "Show More" and read window.__APOLLO_CLIENT__.cache.extract()
     after each click. The app does its own authenticated paging; we just read
     the result. A best-effort fast path tries to reuse Apollo's own parsed
     query document with a bigger page size first, and falls back silently.

   FIELD MAPPING (exact, from the live schema — no guessing)
     startTimeMs  string, epoch MILLISECONDS
     endTimeMs    string, epoch MILLISECONDS
     duration     number, MILLISECONDS
     price        { formatted: "$0.30" }  — no numeric field exists
     rideableName the bike id
     (there are no station fields in this query)
   =========================================================================== */

(function () {
  "use strict";

  var YEAR = (window.__CBW_YEAR) || 2026;
  var MAX_CLICKS = 400;

  if (window.__CBW_RUNNING) { console.warn("[CBW] already running"); return; }
  window.__CBW_RUNNING = true;
  window.__CBW = { year: YEAR, rides: [], raw: [], source: null };

  function log() {
    console.log.apply(console, ["%c[CBW]", "color:#3987e5;font-weight:bold"].concat([].slice.call(arguments)));
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /* =======================================================================
     1. FINDING RIDE OBJECTS
     ======================================================================= */

  var HINT = /(start|end|began|ended|depart|arriv)|(duration|elapsed)|(price|amount|cost|fare|charge|total)|(station|dock)|(bike|vehicle|rideable)/i;

  function rideScore(o) {
    if (!o || typeof o !== "object" || Array.isArray(o)) return 0;
    var n = 0, hasTime = false;
    Object.keys(o).forEach(function (k) {
      if (HINT.test(k)) n++;
      if (/(start|begin|depart)/i.test(k)) hasTime = true;
    });
    return hasTime ? n : n - 2;
  }

  function findRideArray(root) {
    var best = null, bestScore = 0;
    var seen = new Set();
    (function walk(node, d) {
      if (!node || typeof node !== "object" || d > 8 || seen.has(node)) return;
      seen.add(node);
      if (Array.isArray(node)) {
        if (node.length && typeof node[0] === "object" && node[0]) {
          var sc = rideScore(node[0]);
          var score = sc * 1000 + node.length;
          if (sc >= 2 && score > bestScore) { bestScore = score; best = node; }
        }
        node.slice(0, 30).forEach(function (n) { walk(n, d + 1); });
        return;
      }
      Object.keys(node).forEach(function (k) { walk(node[k], d + 1); });
    })(root, 0);
    return best || [];
  }

  /* =======================================================================
     2. NORMALIZING  (exact mapping, with generic fallbacks)
     ======================================================================= */

  function toDate(v) {
    if (v === null || v === undefined) return null;
    var n = typeof v === "string" && /^\d+$/.test(v) ? parseInt(v, 10) : v;
    if (typeof n === "number") {
      if (n > 1e15) n = n / 1000;        // microseconds
      else if (n < 1e11) n = n * 1000;   // seconds
      var d = new Date(n);
      return isNaN(d.getTime()) ? null : d;
    }
    if (typeof v === "string") {
      var d2 = new Date(v);
      return isNaN(d2.getTime()) ? null : d2;
    }
    return null;
  }

  function moneyToNumber(s) {
    if (typeof s === "number") return s;
    if (typeof s !== "string") return null;
    var m = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  function deepFirst(obj, re, type, depth) {
    depth = depth || 0;
    if (!obj || typeof obj !== "object" || depth > 3) return null;
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      if (re.test(keys[i]) && typeof obj[keys[i]] === type) return obj[keys[i]];
    }
    for (var j = 0; j < keys.length; j++) {
      var v = obj[keys[j]];
      if (v && typeof v === "object" && !Array.isArray(v)) {
        var r = deepFirst(v, re, type, depth + 1);
        if (r !== null && r !== undefined) return r;
      }
    }
    return null;
  }

  function normalizeRide(raw) {
    // --- exact path first ---
    var start = toDate(raw.startTimeMs);
    var end = toDate(raw.endTimeMs);
    var minutes = typeof raw.duration === "number" ? raw.duration / 60000 : null;
    var price = raw.price && typeof raw.price.formatted === "string"
      ? moneyToNumber(raw.price.formatted) : null;
    var bike = typeof raw.rideableName === "string" ? raw.rideableName : null;

    // --- generic fallbacks, in case the schema shifts ---
    if (!start) start = toDate(deepFirst(raw, /^(start|started|begin|began|depart)/i, "string") ||
                               deepFirst(raw, /^(start|started|begin|began|depart)/i, "number"));
    if (!end) end = toDate(deepFirst(raw, /^(end|ended|finish|arriv)/i, "string") ||
                           deepFirst(raw, /^(end|ended|finish|arriv)/i, "number"));
    if (minutes === null) {
      var d = deepFirst(raw, /(duration|elapsed|ride_?time)/i, "number");
      if (typeof d === "number") minutes = d > 86400 ? d / 60000 : (d > 600 ? d / 60 : d);
      else if (start && end) minutes = (end - start) / 60000;
    }
    if (price === null) {
      var pf = deepFirst(raw, /(price|amount|cost|fare|total|formatted)/i, "string");
      if (pf) price = moneyToNumber(pf);
      if (price === null) {
        var pn = deepFirst(raw, /(price|amount|cost|fare|total)/i, "number");
        if (typeof pn === "number") price = Number.isInteger(pn) && pn >= 100 ? pn / 100 : pn;
      }
    }
    if (!bike) bike = deepFirst(raw, /(rideable|bike|vehicle).*(name|id|number)?/i, "string");

    return {
      start: start,
      end: end,
      minutes: (minutes !== null && isFinite(minutes)) ? minutes : null,
      price: price === null ? 0 : price,
      startStation: deepFirst(raw, /(start|from|origin).*(station|name)/i, "string"),
      endStation: deepFirst(raw, /(end|to|dest|arriv).*(station|name)/i, "string"),
      bike: bike,
      id: raw.rideId || deepFirst(raw, /(ride_?id|^id$)/i, "string") || null,
      _raw: raw
    };
  }

  function dedupe(list) {
    var seen = {}, out = [];
    list.forEach(function (r) {
      if (!r.start) return;
      var k = (r.id || "") + "|" + r.start.getTime() + "|" + (r.bike || "");
      if (seen[k]) return;
      seen[k] = 1;
      out.push(r);
    });
    return out.sort(function (a, b) { return a.start - b.start; });
  }

  /* =======================================================================
     3. READING THE APOLLO CACHE
     ======================================================================= */

  function apolloClient() {
    try { return window.__APOLLO_CLIENT__ || null; } catch (e) { return null; }
  }

  function ridesFromCache(client) {
    try { return findRideArray(client.cache.extract()); } catch (e) { return []; }
  }

  function ridesFromNextData() {
    try {
      var w = window.__NEXT_DATA__, nd = null;
      if (w && typeof w === "object" && !w.tagName) nd = w;
      else {
        var tag = document.getElementById("__NEXT_DATA__");
        if (tag && tag.textContent) nd = JSON.parse(tag.textContent);
      }
      return nd ? findRideArray(nd) : [];
    } catch (e) { return []; }
  }

  /* ---- the "Show More" button ---- */

  var PAGER = /^(show more|load more|next|next page|see more|older|view more|more)\b/i;

  function findPager() {
    var els = [].slice.call(document.querySelectorAll("button,a,[role=button],[type=button],div,span"));
    var hits = els.filter(function (b) {
      if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
      if (b.offsetParent === null) return false;
      var t = (b.innerText || b.textContent || "").trim();
      if (!t || t.length > 30 || !PAGER.test(t)) return false;
      var tag = b.tagName.toLowerCase();
      if (tag === "div" || tag === "span") {
        try { if (getComputedStyle(b).cursor !== "pointer") return false; } catch (e) { return false; }
      }
      return true;
    });
    return hits.filter(function (el) {
      return !hits.some(function (o) { return o !== el && el.contains(o); });
    })[0] || null;
  }

  /** Poll the cache until it grows past `from`, or we time out. */
  async function waitForGrowth(client, from, timeoutMs) {
    var deadline = Date.now() + (timeoutMs || 8000);
    while (Date.now() < deadline) {
      await sleep(200);
      if (ridesFromCache(client).length > from) return true;
    }
    return false;
  }

  function oldestStart(rawRides) {
    var oldest = null;
    for (var i = 0; i < rawRides.length; i++) {
      var d = toDate(rawRides[i] && (rawRides[i].startTimeMs !== undefined ? rawRides[i].startTimeMs : null));
      if (!d) { var n = normalizeRide(rawRides[i]); d = n.start; }
      if (d && (!oldest || d < oldest)) oldest = d;
    }
    return oldest;
  }

  /** Click "Show More" until the target year is fully covered. */
  async function collectByClicking(client, onProgress) {
    var yearStart = new Date(YEAR, 0, 1);
    var stagnant = 0;

    for (var i = 0; i < MAX_CLICKS; i++) {
      var current = ridesFromCache(client);
      if (onProgress) onProgress(current.length);

      var oldest = oldestStart(current);
      if (oldest && oldest < yearStart) { log("covered", YEAR, "— oldest loaded:", oldest.toDateString()); break; }

      var btn = findPager();
      if (!btn) { log("no Show More button left — that's everything"); break; }

      btn.click();
      var grew = await waitForGrowth(client, current.length, 8000);
      if (!grew) {
        if (++stagnant >= 3) { log("cache stopped growing"); break; }
      } else {
        stagnant = 0;
      }
    }
    return ridesFromCache(client);
  }

  /* ---- best-effort fast path: reuse Apollo's own parsed query ---- */

  var PAGE_VAR = /^(first|limit|count|page_?size|per_?page|take|num|n)$/i;

  function rideQueryDoc(client) {
    try {
      var qm = client.queryManager;
      if (!qm || typeof qm.getObservableQueries !== "function") return null;
      var hit = null;
      qm.getObservableQueries("all").forEach(function (oq) {
        if (hit) return;
        var name = oq.queryName ||
          (oq.options && oq.options.query && oq.options.query.definitions &&
           oq.options.query.definitions[0] && oq.options.query.definitions[0].name &&
           oq.options.query.definitions[0].name.value);
        if (name && /ride/i.test(name)) hit = oq;
      });
      return hit;
    } catch (e) { return null; }
  }

  /** The query TEXT is stripped by the build, but the parsed AST survives —
      variable names can still be read straight off it. */
  async function tryFastPath(client) {
    try {
      var oq = rideQueryDoc(client);
      if (!oq || !oq.options || !oq.options.query) return null;
      var defs = oq.options.query.definitions || [];
      var varDefs = (defs[0] && defs[0].variableDefinitions) || [];
      var names = varDefs.map(function (v) {
        try { return v.variable.name.value; } catch (e) { return ""; }
      });
      var pageVar = names.filter(function (n) { return PAGE_VAR.test(n); })[0];
      log("ride query variables:", names.join(", ") || "(none)");
      if (!pageVar) return null;

      var vars = Object.assign({}, oq.options.variables || {});
      vars[pageVar] = 300;
      var res = await client.query({
        query: oq.options.query, variables: vars, fetchPolicy: "no-cache"
      });
      var got = findRideArray(res && res.data);
      log("fast path returned", got.length, "rides");
      return got.length ? got : null;
    } catch (e) {
      log("fast path unavailable:", e && e.message);
      return null;
    }
  }

  /* =======================================================================
     4. DOM FALLBACK (only if Apollo isn't reachable at all)
     ======================================================================= */

  function scrapeCards() {
    var txt = function (el) { return (el.innerText || "").replace(/\s+/g, " ").trim(); };
    var RE = {
      date: /([A-Z][a-z]+ \d{1,2},\s*\d{4})/,
      price: /Price:\s*\$?\s*([\d,]+\.?\d*)/i,
      start: /Start Time:\s*(\d{1,2}:\d{2}\s*[AP]\.?M\.?)/i,
      duration: /Duration:\s*((?:\d+\s*(?:hrs?|hours?)\s*)?\d+\s*min)/i,
      bike: /\b(\d{3}-\d{4})\b/
    };
    var all = [].slice.call(document.querySelectorAll("div,li,article,section,a"));
    var matches = all.filter(function (el) {
      var t = txt(el);
      return RE.price.test(t) && RE.duration.test(t) && t.length < 500;
    });
    var inner = matches.filter(function (el) {
      return !matches.some(function (o) { return o !== el && el.contains(o); });
    });
    var out = [];
    inner.forEach(function (el) {
      var t = txt(el);
      var dm = t.match(RE.date), pm = t.match(RE.price), sm = t.match(RE.start),
          um = t.match(RE.duration), bm = t.match(RE.bike);
      if (!dm) return;
      var mins = 0;
      if (um) {
        var h = um[1].match(/(\d+)\s*(?:hrs?|hours?)/i);
        if (h) mins += parseInt(h[1], 10) * 60;
        var mm = um[1].match(/(\d+)\s*min/i);
        if (mm) mins += parseInt(mm[1], 10);
      }
      var start = new Date(dm[1] + (sm ? " " + sm[1].replace(/\./g, "") : ""));
      if (isNaN(start.getTime())) return;
      out.push({
        start: start, end: null, minutes: mins || null,
        price: pm ? parseFloat(pm[1].replace(/,/g, "")) : 0,
        startStation: null, endStation: null, bike: bm ? bm[1] : null,
        id: null, _raw: { scraped: true }
      });
    });
    return out;
  }

  /* =======================================================================
     5. STATS
     ======================================================================= */

  function computeStats(rides) {
    var s = {
      count: rides.length, totalMinutes: 0, totalSpend: 0, days: {}, byMonth: {},
      byDow: [0, 0, 0, 0, 0, 0, 0], byDowSpend: [0, 0, 0, 0, 0, 0, 0],
      byHour: new Array(24).fill(0), bikes: {}, stations: {}, routes: {}, freeRides: 0
    };

    rides.forEach(function (r) {
      s.totalMinutes += r.minutes || 0;
      s.totalSpend += r.price || 0;
      if (!r.price) s.freeRides++;
      var d = r.start;
      var dayKey = d.getFullYear() + "-" + (d.getMonth() + 1) + "-" + d.getDate();
      s.days[dayKey] = (s.days[dayKey] || 0) + 1;
      var m = d.getMonth();
      if (!s.byMonth[m]) s.byMonth[m] = { rides: 0, spend: 0, minutes: 0 };
      s.byMonth[m].rides++;
      s.byMonth[m].spend += r.price || 0;
      s.byMonth[m].minutes += r.minutes || 0;
      s.byDow[d.getDay()]++;
      s.byDowSpend[d.getDay()] += r.price || 0;
      s.byHour[d.getHours()]++;
      if (r.bike) s.bikes[r.bike] = (s.bikes[r.bike] || 0) + 1;
      if (r.startStation) s.stations[r.startStation] = (s.stations[r.startStation] || 0) + 1;
      if (r.startStation && r.endStation) {
        var route = r.startStation + " → " + r.endStation;
        s.routes[route] = (s.routes[route] || 0) + 1;
      }
    });

    s.dayCount = Object.keys(s.days).length;
    s.avgMinutes = s.count ? s.totalMinutes / s.count : 0;
    s.avgPrice = s.count ? s.totalSpend / s.count : 0;

    var paid = rides.filter(function (r) { return r.price > 0 && r.minutes; });
    var rates = paid.map(function (r) { return r.price / r.minutes; }).sort(function (a, b) { return a - b; });
    s.medianRate = rates.length ? rates[Math.floor(rates.length / 2)] : null;
    s.rateSpread = rates.length > 1 ? rates[rates.length - 1] - rates[0] : 0;

    var dayList = Object.keys(s.days).map(function (k) {
      var p = k.split("-");
      return new Date(+p[0], +p[1] - 1, +p[2]).getTime();
    }).sort(function (a, b) { return a - b; });
    var longest = dayList.length ? 1 : 0, cur = longest;
    for (var i = 1; i < dayList.length; i++) {
      if (Math.round((dayList[i] - dayList[i - 1]) / 86400000) === 1) { cur++; longest = Math.max(longest, cur); }
      else cur = 1;
    }
    s.longestStreak = longest;

    s.first = rides[0].start;
    s.last = rides[rides.length - 1].start;
    var spanDays = Math.max(Math.round((s.last - s.first) / 86400000) + 1, 1);
    s.spanDays = spanDays;
    s.perWeek = s.totalSpend / spanDays * 7;
    s.perMonth = s.totalSpend / spanDays * 30.44;
    s.perYear = s.totalSpend / spanDays * 365;

    s.longestRide = rides.reduce(function (a, b) { return (b.minutes || 0) > (a.minutes || 0) ? b : a; }, rides[0]);
    s.priciestRide = rides.reduce(function (a, b) { return (b.price || 0) > (a.price || 0) ? b : a; }, rides[0]);
    var busiest = Object.keys(s.days).sort(function (a, b) { return s.days[b] - s.days[a]; })[0];
    s.busiestDay = busiest;
    s.busiestDayCount = s.days[busiest];
    s.peakHour = s.byHour.indexOf(Math.max.apply(null, s.byHour));
    return s;
  }

  /* =======================================================================
     6. UI
     ======================================================================= */

  var MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  var DOWS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  function money(n) { return "$" + (n || 0).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ","); }
  function hm(mins) {
    mins = Math.round(mins || 0);
    var h = Math.floor(mins / 60), m = mins % 60;
    return h ? h + "h " + m + "m" : m + "m";
  }
  function hourLabel(h) {
    var ap = h < 12 ? "AM" : "PM";
    var hh = h % 12 === 0 ? 12 : h % 12;
    return hh + " " + ap;
  }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  var CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  .wrap {
    position: fixed; inset: 0; z-index: 2147483647;
    background: #0d0d0d;
    color: #ffffff;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  .bars { display: flex; gap: 4px; padding: 14px 16px 0; flex: 0 0 auto; }
  .bar { flex: 1; height: 3px; border-radius: 2px; background: rgba(255,255,255,0.18); overflow: hidden; }
  .bar > i { display: block; height: 100%; width: 0; background: #ffffff; border-radius: 2px; transition: width .25s ease; }
  .bar.done > i { width: 100%; }
  .bar.active > i { width: 100%; }

  .topbar { display: flex; align-items: center; justify-content: space-between; padding: 12px 18px; flex: 0 0 auto; }
  .brand { font-size: 12px; letter-spacing: .14em; text-transform: uppercase; color: #898781; font-weight: 600; }
  .close {
    appearance: none; border: 0; background: rgba(255,255,255,.08); color: #fff;
    width: 30px; height: 30px; border-radius: 50%; font-size: 16px; cursor: pointer; line-height: 1;
  }
  .close:hover { background: rgba(255,255,255,.16); }

  .stage { flex: 1 1 auto; position: relative; overflow: hidden; }
  .card {
    position: absolute; inset: 0;
    display: none; flex-direction: column; justify-content: center; align-items: center;
    padding: 24px clamp(20px, 7vw, 76px);
    overflow-y: auto;
  }
  .card.on { display: flex; animation: rise .45s cubic-bezier(.2,.7,.3,1) both; }
  .inner { width: 100%; max-width: 760px; }
  @keyframes rise { from { opacity: 0; transform: translateY(14px); } to { opacity: 1; transform: none; } }

  .kicker { font-size: 13px; letter-spacing: .12em; text-transform: uppercase; color: #3987e5; font-weight: 700; margin-bottom: 14px; }
  .hero { font-size: clamp(56px, 13vw, 132px); font-weight: 800; line-height: .95; letter-spacing: -.03em; }
  .hero.sm { font-size: clamp(38px, 8vw, 80px); }
  .sub { font-size: clamp(16px, 2.4vw, 22px); color: #c3c2b7; margin-top: 16px; max-width: 34ch; line-height: 1.45; }
  .note { font-size: 14px; color: #898781; margin-top: 20px; line-height: 1.5; }
  .rows { margin-top: 22px; display: flex; flex-direction: column; gap: 12px; max-width: 560px; }
  .row { display: flex; justify-content: space-between; align-items: baseline; gap: 16px; padding-bottom: 10px; border-bottom: 1px solid rgba(255,255,255,.10); }
  .row .k { color: #c3c2b7; font-size: 15px; }
  .row .v { font-size: 20px; font-weight: 700; font-variant-numeric: tabular-nums; }

  /* charts */
  .chart { margin-top: 26px; max-width: 620px; }
  .cols { display: flex; align-items: flex-end; gap: 2px; height: 190px; }
  .col { flex: 1; display: flex; flex-direction: column; justify-content: flex-end; align-items: center; gap: 6px; height: 100%; position: relative; cursor: default; }
  .col .fill { width: 100%; background: #3987e5; border-radius: 4px 4px 0 0; min-height: 2px; transition: background .15s; }
  .col.peak .fill { background: #86b6ef; }
  .col:hover .fill { background: #cde2fb; }
  .col .tick { font-size: 11px; color: #898781; font-variant-numeric: tabular-nums; }
  .col .val { position: absolute; top: -18px; font-size: 12px; font-weight: 700; color: #ffffff; font-variant-numeric: tabular-nums; opacity: 0; transition: opacity .15s; white-space: nowrap; }
  .col.peak .val, .col:hover .val { opacity: 1; }
  .axisnote { font-size: 12px; color: #898781; margin-top: 10px; }
  .tablebtn { margin-top: 12px; background: none; border: 0; color: #898781; font-size: 12px; text-decoration: underline; cursor: pointer; padding: 0; font-family: inherit; }
  table { border-collapse: collapse; margin-top: 10px; font-size: 13px; }
  th, td { text-align: left; padding: 4px 14px 4px 0; color: #c3c2b7; font-variant-numeric: tabular-nums; }
  th { color: #898781; font-weight: 600; }

  .nav { position: absolute; inset: 0; display: flex; }
  .nav > div { flex: 1; cursor: pointer; }
  .foot { flex: 0 0 auto; padding: 14px 18px 20px; display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  .hint { font-size: 12px; color: #898781; }
  .btns { display: flex; gap: 8px; }
  .btn {
    appearance: none; border: 1px solid rgba(255,255,255,.20); background: rgba(255,255,255,.06);
    color: #fff; padding: 9px 14px; border-radius: 999px; font-size: 13px; font-weight: 600;
    cursor: pointer; font-family: inherit;
  }
  .btn:hover { background: rgba(255,255,255,.14); }
  .btn.primary { background: #2a78d6; border-color: #2a78d6; }
  .btn.primary:hover { background: #3987e5; }

  .loading { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 18px; text-align: center; padding: 30px; }
  .spinner { width: 34px; height: 34px; border: 3px solid rgba(255,255,255,.15); border-top-color: #3987e5; border-radius: 50%; animation: spin .8s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .err { max-width: 60ch; text-align: left; }
  .err code { display: block; background: #1a1a19; padding: 12px; border-radius: 8px; margin-top: 12px; font-size: 12px; color: #c3c2b7; white-space: pre-wrap; }
  `;

  var host, shadow, root;

  function mount() {
    host = document.createElement("div");
    host.id = "cbw-host";
    // Shadow DOM keeps Citi Bike's stylesheet from leaking into our UI and vice versa
    shadow = host.attachShadow({ mode: "open" });
    var style = document.createElement("style");
    style.textContent = CSS;
    shadow.appendChild(style);
    root = document.createElement("div");
    root.className = "wrap";
    shadow.appendChild(root);
    document.documentElement.appendChild(host);
    document.documentElement.style.overflow = "hidden";
  }

  function unmount() {
    if (host) host.remove();
    document.documentElement.style.overflow = "";
    window.__CBW_RUNNING = false;
  }

  function showLoading(msg) {
    root.innerHTML =
      '<div class="loading"><div class="spinner"></div><div class="sub" id="m">' + esc(msg) + "</div></div>";
  }
  function setLoadingMsg(msg) {
    var m = shadow.getElementById ? shadow.getElementById("m") : root.querySelector("#m");
    if (m) m.textContent = msg;
  }

  function showError(title, detail) {
    root.innerHTML =
      '<div class="loading"><div class="err"><div class="kicker">Citi Bike Wrapped</div>' +
      '<div class="hero sm">' + esc(title) + "</div>" +
      '<div class="note">' + esc(detail) + "</div>" +
      '<code>' + esc(JSON.stringify({
        capturedEndpoints: captures.map(function (c) { return c.method + " " + c.url.split("?")[0]; }).slice(0, 12),
        domCardsFound: scrapeCards().length
      }, null, 2)) + "</code>" +
      '<div class="btns" style="margin-top:16px"><button class="btn" id="x">Close</button></div>' +
      "</div></div>";
    root.querySelector("#x").onclick = unmount;
  }

  function barChart(items, opts) {
    // items: [{label, value, display}]
    opts = opts || {};
    var max = Math.max.apply(null, items.map(function (i) { return i.value; }).concat([1]));
    var peakIdx = items.reduce(function (best, it, i) { return it.value > items[best].value ? i : best; }, 0);
    var cols = items.map(function (it, i) {
      var pct = Math.max((it.value / max) * 100, it.value > 0 ? 3 : 0.6);
      return (
        '<div class="col' + (i === peakIdx && it.value > 0 ? " peak" : "") + '" title="' +
        esc(it.label + ": " + (it.display || it.value)) + '">' +
        '<span class="val">' + esc(it.display || it.value) + "</span>" +
        '<div class="fill" style="height:' + pct.toFixed(1) + '%"></div>' +
        '<span class="tick">' + esc(it.label) + "</span>" +
        "</div>"
      );
    }).join("");

    var rows = items.map(function (it) {
      return "<tr><td>" + esc(it.label) + "</td><td>" + esc(it.display || it.value) + "</td></tr>";
    }).join("");

    var id = "t" + Math.random().toString(36).slice(2, 8);
    return (
      '<div class="chart"><div class="cols">' + cols + "</div>" +
      (opts.axisnote ? '<div class="axisnote">' + esc(opts.axisnote) + "</div>" : "") +
      '<button class="tablebtn" data-toggle="' + id + '">Show data table</button>' +
      '<table id="' + id + '" style="display:none"><thead><tr><th>' +
      esc(opts.labelHead || "") + "</th><th>" + esc(opts.valueHead || "") +
      "</th></tr></thead><tbody>" + rows + "</tbody></table></div>"
    );
  }

  function buildCards(stats, rides, source) {
    var cards = [];

    cards.push(
      '<div class="kicker">Citi Bike Wrapped</div>' +
      '<div class="hero">' + YEAR + "</div>" +
      '<div class="sub">You took <strong>' + stats.count + "</strong> rides this year. Let's go through it.</div>" +
      '<div class="note">Tap the right side or press → to continue.</div>'
    );

    cards.push(
      '<div class="kicker">Rides</div>' +
      '<div class="hero">' + stats.count + "</div>" +
      '<div class="sub">rides across <strong>' + stats.dayCount + "</strong> different days.</div>" +
      '<div class="rows">' +
      '<div class="row"><span class="k">Longest streak</span><span class="v">' + stats.longestStreak + " days</span></div>" +
      '<div class="row"><span class="k">Most in one day</span><span class="v">' + stats.busiestDayCount + "</span></div>" +
      (stats.freeRides ? '<div class="row"><span class="k">$0.00 rides</span><span class="v">' + stats.freeRides + "</span></div>" : "") +
      "</div>"
    );

    cards.push(
      '<div class="kicker">Time in the saddle</div>' +
      '<div class="hero sm">' + hm(stats.totalMinutes) + "</div>" +
      '<div class="sub">That\'s <strong>' + (stats.totalMinutes / 60).toFixed(1) + " hours</strong> on a Citi Bike.</div>" +
      '<div class="rows">' +
      '<div class="row"><span class="k">Average ride</span><span class="v">' + hm(stats.avgMinutes) + "</span></div>" +
      '<div class="row"><span class="k">Longest ride</span><span class="v">' + hm(stats.longestRide.minutes) + "</span></div>" +
      "</div>"
    );

    cards.push(
      '<div class="kicker">What it cost</div>' +
      '<div class="hero sm">' + money(stats.totalSpend) + "</div>" +
      '<div class="sub">spent on rides in ' + YEAR + ".</div>" +
      '<div class="rows">' +
      '<div class="row"><span class="k">Per ride</span><span class="v">' + money(stats.avgPrice) + "</span></div>" +
      '<div class="row"><span class="k">Per week</span><span class="v">' + money(stats.perWeek) + "</span></div>" +
      '<div class="row"><span class="k">Per month</span><span class="v">' + money(stats.perMonth) + "</span></div>" +
      '<div class="row"><span class="k">Annualized at this pace</span><span class="v">' + money(stats.perYear) + "</span></div>" +
      "</div>"
    );

    if (stats.medianRate) {
      var consistent = stats.rateSpread < 0.02;
      cards.push(
        '<div class="kicker">Your rate</div>' +
        '<div class="hero sm">$' + stats.medianRate.toFixed(4) + "<span style=\"font-size:.34em;color:#898781\">/min</span></div>" +
        '<div class="sub">' +
        (consistent
          ? "Every paid ride bills at the same per-minute rate, so your spend is purely a function of minutes ridden."
          : "Your per-minute rate varies across rides — likely a mix of bike types or rate changes.") +
        "</div>" +
        '<div class="note">Every extra 10 minutes on a bike costs you about ' + money(stats.medianRate * 10) + ".</div>"
      );
    }

    var monthItems = MONTHS.map(function (m, i) {
      var d = stats.byMonth[i] || { rides: 0, spend: 0 };
      return { label: m[0], value: d.rides, display: d.rides + " rides · " + money(d.spend) };
    });
    cards.push(
      '<div class="kicker">Your year, month by month</div>' +
      '<div class="hero sm">' + MONTHS[monthItems.reduce(function (b, it, i) { return it.value > monthItems[b].value ? i : b; }, 0)] + "</div>" +
      '<div class="sub">was your biggest month.</div>' +
      barChart(monthItems, { axisnote: "Rides per month. Hover a bar for spend.", labelHead: "Month", valueHead: "Rides · spend" })
    );

    var dowItems = DOWS.map(function (d, i) {
      return { label: d, value: stats.byDow[i], display: stats.byDow[i] + " rides · " + money(stats.byDowSpend[i]) };
    });
    var topDow = stats.byDow.indexOf(Math.max.apply(null, stats.byDow));
    var weekend = stats.byDow[0] + stats.byDow[6];
    cards.push(
      '<div class="kicker">Your week</div>' +
      '<div class="hero sm">' + ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][topDow] + "</div>" +
      '<div class="sub">is your biggest riding day. Weekday vs weekend: <strong>' +
      (stats.count - weekend) + "</strong> / <strong>" + weekend + "</strong>.</div>" +
      barChart(dowItems, { axisnote: "Rides by day of week.", labelHead: "Day", valueHead: "Rides · spend" })
    );

    var hourItems = stats.byHour.map(function (v, h) {
      return { label: (h % 3 === 0 ? String(h) : ""), value: v, display: hourLabel(h) + ": " + v + " rides" };
    });
    cards.push(
      '<div class="kicker">Your clock</div>' +
      '<div class="hero sm">' + hourLabel(stats.peakHour) + "</div>" +
      '<div class="sub">is when you ride most.</div>' +
      barChart(hourItems, { axisnote: "Rides by hour of day (24h).", labelHead: "Hour", valueHead: "Rides" })
    );

    var topStations = Object.keys(stats.stations).sort(function (a, b) { return stats.stations[b] - stats.stations[a]; }).slice(0, 5);
    var topRoutes = Object.keys(stats.routes).sort(function (a, b) { return stats.routes[b] - stats.routes[a]; }).slice(0, 5);
    if (topStations.length) {
      cards.push(
        '<div class="kicker">Your places</div>' +
        '<div class="hero sm">' + esc(topStations[0]) + "</div>" +
        '<div class="sub">is the station you started from most.</div>' +
        '<div class="rows">' +
        topRoutes.map(function (r) {
          return '<div class="row"><span class="k">' + esc(r) + '</span><span class="v">' + stats.routes[r] + "×</span></div>";
        }).join("") +
        "</div>"
      );
    }

    var topBikes = Object.keys(stats.bikes).filter(function (b) { return stats.bikes[b] > 1; })
      .sort(function (a, b) { return stats.bikes[b] - stats.bikes[a]; }).slice(0, 5);
    cards.push(
      '<div class="kicker">Standouts</div>' +
      '<div class="hero sm">' + money(stats.priciestRide.price) + "</div>" +
      '<div class="sub">was your priciest single ride — ' +
      stats.priciestRide.start.toLocaleDateString(undefined, { month: "long", day: "numeric" }) +
      ", " + hm(stats.priciestRide.minutes) + ".</div>" +
      '<div class="rows">' +
      '<div class="row"><span class="k">Longest ride</span><span class="v">' + hm(stats.longestRide.minutes) + "</span></div>" +
      '<div class="row"><span class="k">Busiest day</span><span class="v">' + stats.busiestDayCount + " rides</span></div>" +
      (topBikes.length
        ? '<div class="row"><span class="k">Bike you rode most</span><span class="v">' + esc(topBikes[0]) + " (" + stats.bikes[topBikes[0]] + "×)</span></div>"
        : "") +
      "</div>"
    );

    cards.push(
      '<div class="kicker">That\'s ' + YEAR + "</div>" +
      '<div class="hero sm">' + stats.count + " rides · " + hm(stats.totalMinutes) + " · " + money(stats.totalSpend) + "</div>" +
      '<div class="sub">Take the raw data with you — it never left your browser.</div>' +
      '<div class="btns" style="margin-top:24px">' +
      '<button class="btn primary" data-act="csv">Download CSV</button>' +
      '<button class="btn" data-act="json">Download JSON</button>' +
      "</div>" +
      '<div class="note">Source: ' + esc(source) + ". " + rides.length + " rides in " + YEAR + ".</div>"
    );

    return cards;
  }

  function render(stats, rides, source) {
    var cards = buildCards(stats, rides, source);
    var idx = 0;

    root.innerHTML =
      '<div class="bars">' + cards.map(function () { return '<div class="bar"><i></i></div>'; }).join("") + "</div>" +
      '<div class="topbar"><span class="brand">Citi Bike Wrapped · ' + YEAR + '</span><button class="close" title="Close">×</button></div>' +
      '<div class="stage">' +
      cards.map(function (c, i) {
        return '<section class="card' + (i === 0 ? " on" : "") + '"><div class="inner">' + c + "</div></section>";
      }).join("") +
      '<div class="nav"><div data-nav="prev"></div><div data-nav="next"></div></div>' +
      "</div>" +
      '<div class="foot"><span class="hint">← → to move · Esc to close</span>' +
      '<div class="btns"><button class="btn" data-act="csv">CSV</button><button class="btn" data-act="json">JSON</button></div></div>';

    var barEls = [].slice.call(root.querySelectorAll(".bar"));
    var cardEls = [].slice.call(root.querySelectorAll(".card"));

    function show(i) {
      if (i < 0 || i >= cardEls.length) return;
      cardEls[idx].classList.remove("on");
      idx = i;
      cardEls[idx].classList.add("on");
      barEls.forEach(function (b, j) {
        b.classList.toggle("done", j < idx);
        b.classList.toggle("active", j === idx);
      });
      cardEls[idx].scrollTop = 0;
    }
    show(0);

    root.querySelector(".close").onclick = unmount;
    root.querySelectorAll("[data-nav]").forEach(function (el) {
      el.onclick = function () { show(el.getAttribute("data-nav") === "next" ? idx + 1 : idx - 1); };
    });

    // chart data-table toggles + download buttons (delegated: cards re-render text only)
    root.addEventListener("click", function (e) {
      var t = e.target.closest("[data-toggle]");
      if (t) {
        e.stopPropagation();
        var tbl = root.querySelector("#" + t.getAttribute("data-toggle"));
        var open = tbl.style.display !== "none";
        tbl.style.display = open ? "none" : "table";
        t.textContent = open ? "Show data table" : "Hide data table";
        return;
      }
      var a = e.target.closest("[data-act]");
      if (a) {
        e.stopPropagation();
        download(a.getAttribute("data-act"), rides);
      }
    });

    var keyHandler = function (e) {
      if (e.key === "ArrowRight" || e.key === " ") { show(idx + 1); e.preventDefault(); }
      else if (e.key === "ArrowLeft") { show(idx - 1); e.preventDefault(); }
      else if (e.key === "Escape") { document.removeEventListener("keydown", keyHandler, true); unmount(); }
    };
    document.addEventListener("keydown", keyHandler, true);
  }

  function download(kind, rides) {
    var blob, name;
    if (kind === "json") {
      blob = new Blob([JSON.stringify(rides.map(function (r) {
        return {
          start: r.start ? r.start.toISOString() : null,
          end: r.end ? r.end.toISOString() : null,
          minutes: r.minutes, price: r.price,
          start_station: r.startStation, end_station: r.endStation, bike: r.bike
        };
      }), null, 2)], { type: "application/json" });
      name = "citibike_" + YEAR + ".json";
    } else {
      var cols = ["start", "end", "minutes", "price", "start_station", "end_station", "bike"];
      var q = function (v) {
        if (v === null || v === undefined) return "";
        var s = String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      var lines = [cols.join(",")].concat(rides.map(function (r) {
        return [
          r.start ? r.start.toISOString() : "",
          r.end ? r.end.toISOString() : "",
          r.minutes != null ? r.minutes.toFixed(1) : "",
          r.price != null ? r.price.toFixed(2) : "",
          r.startStation, r.endStation, r.bike
        ].map(q).join(",");
      }));
      blob = new Blob([lines.join("\n")], { type: "text/csv" });
      name = "citibike_" + YEAR + ".csv";
    }
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  /* =======================================================================
     7. RUN
     ======================================================================= */

  async function run() {
    mount();
    showLoading("Reading your " + YEAR + " rides…");

    var client = apolloClient();
    var rawRides = [];
    var source = "";

    if (client) {
      // seed: whatever is already in the cache / server-rendered into the page
      rawRides = ridesFromCache(client);
      if (!rawRides.length) rawRides = ridesFromNextData();
      log("starting with", rawRides.length, "rides");

      // fast path — reuse Apollo's own parsed query with a bigger page size
      setLoadingMsg("Asking for your history…");
      var fast = await tryFastPath(client);
      if (fast && fast.length > rawRides.length) {
        rawRides = fast;
        source = "Apollo query";
        log("fast path won:", fast.length);
      }

      // if that didn't cover the year, drive the UI and read the cache
      var yearStart = new Date(YEAR, 0, 1);
      var oldest = oldestStart(rawRides);
      if (!oldest || oldest >= yearStart) {
        setLoadingMsg("Loading your history (clicking through the list)…");
        rawRides = await collectByClicking(client, function (n) {
          setLoadingMsg("Loaded " + n + " rides…");
        });
        source = source ? source + " + Show More" : "Apollo cache";
      }
    }

    var rides = rawRides.map(normalizeRide).filter(function (r) { return r.start; });

    // last resort: read what's rendered on screen
    if (rides.length < 3) {
      setLoadingMsg("Falling back to reading the page…");
      var scraped = scrapeCards();
      if (scraped.length > rides.length) { rides = scraped; source = "page cards"; }
    }

    rides = dedupe(rides);
    var final = rides.filter(function (r) { return r.start.getFullYear() === YEAR; });

    window.__CBW.rides = final;
    window.__CBW.raw = rawRides;
    window.__CBW.source = source;

    if (!final.length) {
      showError(
        "Couldn't read your " + YEAR + " rides",
        "Found " + rides.length + " rides overall but none in " + YEAR + ". " +
        "window.__CBW.raw has the raw objects — paste one back and the mapping can be corrected."
      );
      return;
    }

    log("done:", final.length, "rides in", YEAR, "via", source);
    render(computeStats(final), final, source);
  }

  run().catch(function (e) {
    console.error("[CBW]", e);
    try { showError("Something broke", String((e && e.message) || e)); } catch (_) { unmount(); }
  });
})();

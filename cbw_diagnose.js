/* ===========================================================================
   CITI BIKE WRAPPED — DIAGNOSTIC v4
   ---------------------------------------------------------------------------
   v1 only saw network calls made AFTER it was pasted. On a Next.js page the
   first batch of rides is usually already in the HTML, so nothing was left to
   catch. v2 uses four strategies instead of one:

     A. window.__NEXT_DATA__      — rides Next.js embedded at render time
     B. Resource Timing           — every URL the page already requested,
                                    even before this script existed; the
                                    promising ones get re-fetched same-origin
     C. live capture              — fetch/XHR hook, now accepting any response
                                    that parses as JSON (not just
                                    content-type: application/json)
     D. auto-scroll               — triggers the app's own paging, so you
                                    don't have to time anything by hand

   It prints a SCHEMA, not your data: numbers and timestamps come through
   (needed to tell cents from dollars and seconds from minutes); station
   names, bike ids, account ids, emails and lat/lon are always redacted.

   RUN:  paste, press Enter, then run   await CBD.report()
   =========================================================================== */

(function () {
  "use strict";

  var caps = [];
  var origFetch = window.fetch;
  window.CBD_CAPS = caps;

  function note(url, method, text, reqBody, how) {
    if (!text || text.length < 80) return;
    try {
      caps.push({
        url: String(url), method: method || "GET",
        json: JSON.parse(text), reqBody: reqBody || null, how: how || "live"
      });
    } catch (e) {}
  }

  /* ---------- C. live capture (any JSON-parseable body) ---------- */

  window.fetch = function () {
    var a = arguments, r = a[0];
    var url = typeof r === "string" ? r : (r && r.url);
    var m = (a[1] && a[1].method) || (r && r.method) || "GET";
    var rb = (a[1] && a[1].body) || null;
    return origFetch.apply(this, a).then(function (res) {
      try { res.clone().text().then(function (t) { note(url, m, t, rb); }).catch(function () {}); } catch (e) {}
      return res;
    });
  };

  var oo = XMLHttpRequest.prototype.open, os = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, u) { this.__m = m; this.__u = u; return oo.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (b) {
    var s = this;
    this.addEventListener("load", function () {
      try { note(s.__u, s.__m, s.responseText || "", b); } catch (e) {}
    });
    return os.apply(this, arguments);
  };

  /* ---------- redaction ---------- */

  var UNSAFE = /(lat|lng|long|lon\b|coord|geo|address|street|email|phone|name|first_?name|last_?name|firstname|lastname|user|member|account|customer|profile|token|auth|key|secret|url|uri|href|photo|avatar|image|zip|postal|city|state|region|_id$|^id$|uuid|guid)/i;
  var SAFE = /(time|date|start|end|began|ended|depart|arriv|duration|elapsed|second|minute|hour|price|amount|cost|fare|charge|total|subtotal|fee|tax|currency|type|kind|category|status|state$|count|num|limit|offset|page|cursor|next|prev|has_more|is_|electric|classic|ebike|rideable|distance|miles|km)/i;

  function pattern(s) {
    if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return "ISO8601 datetime";
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return "ISO date";
    if (/^\d{10}$/.test(s)) return "epoch seconds (as string)";
    if (/^\d{13}$/.test(s)) return "epoch millis (as string)";
    if (/^[0-9a-f-]{32,40}$/i.test(s)) return "uuid/hash";
    if (/^\$?\d+\.\d{2}$/.test(s)) return "money string";
    if (/^\d+$/.test(s)) return "numeric string";
    return null;
  }

  var TYPENAME = /^__typename$|typename$/i;

  function describe(key, val) {
    if (val === null) return "null";
    if (TYPENAME.test(key) && typeof val === "string") return 'string "' + val + '"';
    var t = typeof val;
    if (t === "boolean") return "boolean " + val;
    if (t === "number") return UNSAFE.test(key) ? "number [redacted]" : "number " + val;
    if (t === "string") {
      var p = pattern(val);
      if (UNSAFE.test(key)) return "string(len " + val.length + ")" + (p ? " — " + p : "") + " [redacted]";
      if (SAFE.test(key) || p) return 'string "' + (val.length > 40 ? val.slice(0, 40) + "…" : val) + '"';
      return "string(len " + val.length + ") [redacted]";
    }
    return t;
  }

  function schema(obj, prefix, depth, out) {
    prefix = prefix || ""; depth = depth || 0; out = out || [];
    if (depth > 4 || !obj || typeof obj !== "object") return out;
    Object.keys(obj).slice(0, 40).forEach(function (k) {
      var v = obj[k], path = prefix ? prefix + "." + k : k;
      if (v && typeof v === "object" && !Array.isArray(v)) schema(v, path, depth + 1, out);
      else if (Array.isArray(v)) {
        out.push("  " + path + "[]: array(" + v.length + ")");
        if (v.length && typeof v[0] === "object") schema(v[0], path + "[0]", depth + 1, out);
        else if (v.length) out.push("  " + path + "[0]: " + describe(k, v[0]));
      } else out.push("  " + path + ": " + describe(k, v));
    });
    return out;
  }

  /* ---------- ride detection ---------- */

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

  function findRides(root) {
    var best = null, bestScore = 0, bestPath = "";
    (function walk(node, path, d) {
      if (!node || typeof node !== "object" || d > 8) return;
      if (Array.isArray(node)) {
        if (node.length && typeof node[0] === "object") {
          var s = rideScore(node[0]);
          var score = s * 100 + Math.min(node.length, 200);
          if (s >= 2 && score > bestScore) { bestScore = score; best = node; bestPath = path; }
        }
        node.slice(0, 10).forEach(function (n, i) { walk(n, path + "[" + i + "]", d + 1); });
        return;
      }
      Object.keys(node).forEach(function (k) { walk(node[k], path ? path + "." + k : k, d + 1); });
    })(root, "$", 0);
    return best ? { rides: best, path: bestPath, score: bestScore } : null;
  }

  function dig(x) {
    var dur = null, price = null;
    (function walk(n, d) {
      if (!n || typeof n !== "object" || d > 3) return;
      Object.keys(n).forEach(function (k) {
        var v = n[k];
        if (typeof v === "number") {
          if (dur === null && /(duration|elapsed|second|minute)/i.test(k)) dur = { k: k, v: v };
          if (price === null && /(price|amount|cost|fare|total)/i.test(k) && !/tax|fee/i.test(k)) price = { k: k, v: v };
        } else if (typeof v === "string") {
          // e.g. price: { formatted: "$0.30" } — the only price the site exposes
          if (price === null && /^\$?-?[\d,]+\.\d{2}$/.test(v.trim())) price = { k: k, v: v };
        } else if (v && typeof v === "object") walk(v, d + 1);
      });
    })(x, 0);
    return { dur: dur, price: price };
  }

  /* ---------- B. replay URLs the page already requested ---------- */

  // Never re-request anything that might change state.
  var DANGEROUS = /(logout|signout|sign_out|delete|remove|cancel|unsubscribe|revoke|reset|pay|charge|refund)/i;

  function pastRequestUrls() {
    var out = [];
    try {
      performance.getEntriesByType("resource").forEach(function (e) {
        if (e.initiatorType !== "fetch" && e.initiatorType !== "xmlhttprequest") return;
        var u;
        try { u = new URL(e.name); } catch (err) { return; }
        if (u.origin !== location.origin) return;
        if (DANGEROUS.test(u.pathname)) return;
        if (out.indexOf(e.name) === -1) out.push(e.name);
      });
    } catch (err) {}
    return out;
  }

  async function replayPast(urls) {
    for (var i = 0; i < Math.min(urls.length, 25); i++) {
      try {
        var res = await origFetch(urls[i], { credentials: "include", headers: { accept: "application/json" } });
        var text = await res.text();
        note(urls[i], "GET", text, null, "replayed");
      } catch (e) {}
    }
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // The real page paginates by button, not by scrolling.
  var PAGER = /^(next|next page|load more|show more|see more|older|view more|more)\b/i;

  function findPager() {
    var els = [].slice.call(document.querySelectorAll("button,a,[role=button],[type=button],div,span"));
    var hits = els.filter(function (b) {
      if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
      if (b.offsetParent === null) return false;                 // hidden
      var t = (b.innerText || b.textContent || "").trim();
      if (!t || t.length > 30 || !PAGER.test(t)) return false;
      // a plain div/span only counts if it's actually clickable
      var tag = b.tagName.toLowerCase();
      if (tag === "div" || tag === "span") {
        try { if (getComputedStyle(b).cursor !== "pointer") return false; } catch (e) { return false; }
      }
      return true;
    });
    // innermost wins — a <button><span>Show More</span></button> matches twice
    return hits.filter(function (el) {
      return !hits.some(function (o) { return o !== el && el.contains(o); });
    });
  }

  async function autoPaginate(rounds) {
    var clicked = 0;
    for (var i = 0; i < (rounds || 3); i++) {
      var pagers = findPager();
      if (!pagers.length) break;
      pagers[0].click();
      clicked++;
      await sleep(1600);
    }
    return clicked;
  }


  /* ---------- E. Apollo client introspection ----------
     The page's Apollo client captured its own `fetch` reference when it was
     constructed at page load, so patching window.fetch afterwards never sees
     its traffic. Talking to the client directly sidesteps that entirely. */

  function apolloClient() {
    try { return window.__APOLLO_CLIENT__ || null; } catch (e) { return null; }
  }

  function linkChain(link, depth, out) {
    out = out || []; depth = depth || 0;
    if (!link || depth > 6) return out;
    var name = "(anon)";
    try { name = link.constructor && link.constructor.name; } catch (e) {}
    var uri = null;
    try {
      uri = link.options && link.options.uri;
      if (!uri && typeof link.uri === "string") uri = link.uri;
      if (!uri && link.options && typeof link.options.fetch === "function" && link.options.baseUri) uri = link.options.baseUri;
    } catch (e) {}
    out.push({ name: name, uri: uri || null });
    ["left", "right", "link", "request"].forEach(function (k) {
      try { if (link[k] && typeof link[k] === "object") linkChain(link[k], depth + 1, out); } catch (e) {}
    });
    return out;
  }

  function docText(doc) {
    try {
      if (!doc) return null;
      if (doc.loc && doc.loc.source && doc.loc.source.body) return doc.loc.source.body;
      if (typeof doc === "string") return doc;
    } catch (e) {}
    return null;
  }

  /** Pull every query document Apollo currently knows about. */
  function apolloQueries(client) {
    var found = [];
    if (!client) return found;
    var qm = null;
    try { qm = client.queryManager || (client.__actionHookForDevTools && client.queryManager); } catch (e) {}
    if (!qm) return found;

    // Apollo 3.x: getObservableQueries('all') -> Map
    try {
      if (typeof qm.getObservableQueries === "function") {
        var m = qm.getObservableQueries("all");
        m.forEach(function (oq) {
          try {
            found.push({
              from: "observableQuery",
              name: (oq.queryName || (oq.options && oq.options.query && oq.options.query.definitions &&
                     oq.options.query.definitions[0] && oq.options.query.definitions[0].name &&
                     oq.options.query.definitions[0].name.value) || "(unnamed)"),
              text: docText(oq.options && oq.options.query),
              variables: (oq.options && oq.options.variables) || (oq.variables) || null,
              doc: oq.options && oq.options.query
            });
          } catch (e) {}
        });
      }
    } catch (e) {}

    // Older/alternate: qm.queries is a Map of QueryInfo with .document
    try {
      if (qm.queries && typeof qm.queries.forEach === "function") {
        qm.queries.forEach(function (qi) {
          try {
            var t = docText(qi.document);
            if (t && !found.some(function (f) { return f.text === t; })) {
              found.push({ from: "queryInfo", name: "(from queryInfo)", text: t,
                           variables: qi.variables || null, doc: qi.document });
            }
          } catch (e) {}
        });
      }
    } catch (e) {}

    return found;
  }

  /** Count ride-like objects currently sitting in the Apollo cache. */
  function cacheRideCount(client) {
    try {
      var data = client.cache.extract();
      var f = findRides(data);
      return f ? f.rides.length : 0;
    } catch (e) { return -1; }
  }

  function cacheArgFields(client) {
    var out = [];
    try {
      var data = client.cache.extract();
      Object.keys(data).forEach(function (ek) {
        Object.keys(data[ek] || {}).forEach(function (f) {
          if (/\(/.test(f)) out.push(ek.replace(/:[0-9a-f]+/i, ":<id>") + " . " + f);
        });
      });
    } catch (e) {}
    return out;
  }

  /* ---------- report ---------- */

  window.CBD = {
    async report() {
      var lines = [], P = function (s) { lines.push(s == null ? "" : s); };

      P("=== CITI BIKE WRAPPED — DIAGNOSTIC v4 ===");
      P("page: " + location.origin + location.pathname);

      // --- CSP ---
      try {
        var h = await origFetch(location.href, { credentials: "include" });
        var csp = h.headers.get("content-security-policy") || h.headers.get("content-security-policy-report-only");
        if (csp) {
          var sd = (csp.match(/script-src[^;]*/i) || [""])[0];
          P("CSP: present — script-src: " + (sd || "(default-src applies)"));
        } else P("CSP: none => loader bookmarklet should work");
      } catch (e) { P("CSP: check failed (" + e.message + ")"); }

      // --- A. __NEXT_DATA__ ---
      var nextData = null;
      try {
        // Careful: <script id="__NEXT_DATA__"> makes window.__NEXT_DATA__ resolve
        // to the ELEMENT via named access, not to the parsed payload.
        var w = window.__NEXT_DATA__;
        if (w && typeof w === "object" && !w.tagName && !(typeof Element !== "undefined" && w instanceof Element)) {
          nextData = w;
        } else {
          var tag = document.getElementById("__NEXT_DATA__");
          if (tag && tag.textContent) nextData = JSON.parse(tag.textContent);
        }
      } catch (e) {}
      if (nextData) {
        P("__NEXT_DATA__: found (buildId " + (nextData.buildId || "?") + ", page " + (nextData.page || "?") + ")");
        var nf = findRides(nextData);
        if (nf) {
          P("  -> rides embedded in the HTML at: " + nf.path + " (" + nf.rides.length + ")");
          caps.push({ url: location.pathname + " [__NEXT_DATA__]", method: "EMBEDDED", json: nextData, how: "next_data" });
        } else {
          P("  -> no ride array inside it");
        }

        // Apollo normalized cache: the field KEYS encode the GraphQL arguments,
        // e.g. rideHistory({}) vs rideHistory({"first":10,"after":"..."}).
        try {
          var apollo = nextData.props && nextData.props.pageProps && nextData.props.pageProps.apolloState;
          if (apollo) {
            P("  apolloState entity keys: " + Object.keys(apollo).map(function (k) {
              return k.replace(/:\d+/, ":<id>");
            }).slice(0, 10).join(", "));
            Object.keys(apollo).forEach(function (ek) {
              var fields = Object.keys(apollo[ek] || {}).filter(function (f) { return /\(/.test(f); });
              if (fields.length) P("  argument-bearing fields on " + ek.replace(/:\d+/, ":<id>") + ": " + fields.join(", "));
            });
          }
        } catch (e) {}
      } else {
        P("__NEXT_DATA__: not present");
      }

      // --- E. Apollo client ---
      var client = apolloClient();
      var cacheBefore = -1;
      if (client) {
        P("");
        P("=== APOLLO CLIENT ===");
        P("present: yes");
        try { P("client keys: " + Object.keys(client).slice(0, 20).join(", ")); } catch (e) {}
        try {
          var qmk = client.queryManager ? Object.keys(client.queryManager).slice(0, 20).join(", ") : "(no queryManager)";
          P("queryManager keys: " + qmk);
          if (client.queryManager) {
            P("  getObservableQueries: " + (typeof client.queryManager.getObservableQueries));
            P("  queries map: " + (client.queryManager.queries ? "yes (size " + (client.queryManager.queries.size || "?") + ")" : "no"));
          }
        } catch (e) {}

        var chain = linkChain(client.link);
        P("link chain: " + chain.map(function (l) { return l.name + (l.uri ? " [uri: " + l.uri + "]" : ""); }).join(" -> "));

        cacheBefore = cacheRideCount(client);
        P("rides currently in Apollo cache: " + cacheBefore);

        var qs = apolloQueries(client);
        P("query documents Apollo knows: " + qs.length);
        qs.forEach(function (q, i) {
          P("");
          P("  [" + (i + 1) + "] " + q.name + "  (via " + q.from + ")");
          if (q.variables) {
            P("      variables:");
            Object.keys(q.variables).forEach(function (k) { P("        " + k + ": " + describe(k, q.variables[k])); });
          }
          if (q.text) {
            P("      document:");
            q.text.split("\n").slice(0, 45).forEach(function (l) { P("        " + l); });
          } else {
            P("      document: (not readable — query text stripped by the build)");
          }
        });
      } else {
        P("__APOLLO_CLIENT__: not exposed");
      }

      // --- D. auto-scroll to make the app page itself ---
      P("");
      P("nudging the page to load more…");
      var before = caps.length;
      for (var i = 0; i < 3; i++) {
        window.scrollTo(0, document.body.scrollHeight);
        await sleep(700);
      }
      var pagerLabels = findPager().map(function (b) { return '"' + (b.innerText || "").trim() + '"'; });
      P("  pagination controls found: " + (pagerLabels.length ? pagerLabels.join(", ") : "(none)"));
      var clicks = await autoPaginate(3);
      P("  clicked pagination " + clicks + " time(s)");
      window.scrollTo(0, 0);
      P("  captured " + (caps.length - before) + " new response(s) via fetch/XHR hook");
      if (client) {
        var cacheAfter = cacheRideCount(client);
        P("  rides in Apollo cache: " + cacheBefore + " -> " + cacheAfter +
          (cacheAfter > cacheBefore ? "  (clicks WORKED — cache is the way in)" : "  (no growth)"));
        var af = cacheArgFields(client);
        if (af.length) {
          P("  argument-bearing cache fields now:");
          af.slice(0, 12).forEach(function (x) { P("    " + x); });
        }
      }

      // --- B. replay past requests if we still have nothing ---
      var past = pastRequestUrls();
      P("past fetch/XHR URLs seen by Resource Timing: " + past.length);
      if (!caps.some(function (c) { return findRides(c.json); })) {
        P("  no rides yet — replaying those URLs same-origin…");
        await replayPast(past);
      }

      // --- GraphQL requests (the real pagination mechanism) ---
      var gql = caps.filter(function (c) {
        if (!c.reqBody) return false;
        try {
          var b = JSON.parse(String(c.reqBody));
          return !!(b.query || b.operationName || b.variables);
        } catch (e) { return false; }
      });
      if (gql.length) {
        P("");
        P("=== GRAPHQL REQUESTS CAPTURED (" + gql.length + ") ===");
        var shownOps = {};
        gql.forEach(function (c) {
          var b = JSON.parse(String(c.reqBody));
          var op = b.operationName || "(anonymous)";
          if (shownOps[op]) return;
          shownOps[op] = 1;
          var u = null; try { u = new URL(c.url, location.origin); } catch (e) {}
          P("");
          P("endpoint: " + c.method + " " + (u ? u.pathname : c.url));
          P("operationName: " + op);
          if (b.variables) {
            P("variables:");
            Object.keys(b.variables).forEach(function (k) {
              P("  " + k + ": " + describe(k, b.variables[k]));
            });
          }
          if (b.query) {
            P("query document:");
            String(b.query).split("\n").slice(0, 60).forEach(function (l) { P("  " + l); });
          }
          var rf = findRides(c.json);
          if (rf) P("response rides at: " + rf.path + " (" + rf.rides.length + ")");
        });
        P("");
      }

      // --- rank ---
      var ranked = caps.map(function (c) {
        var f = findRides(c.json);
        return f ? { c: c, f: f } : null;
      }).filter(Boolean).sort(function (a, b) { return b.f.score - a.f.score; });

      P("");
      if (!ranked.length) {
        P("NO RIDE DATA FOUND BY ANY METHOD.");
        P("URLs the page has requested:");
        past.slice(0, 30).forEach(function (u) { P("  " + u.replace(location.origin, "")); });
        P("");
        P("All JSON responses captured: " + caps.length);
        caps.slice(0, 20).forEach(function (c) {
          P("  " + c.how + " " + c.method + " " + String(c.url).split("?")[0] +
            "  top-level keys: " + Object.keys(c.json).slice(0, 8).join(", "));
        });
      }

      ranked.slice(0, 2).forEach(function (r, idx) {
        var u = null;
        try { u = new URL(r.c.url, location.origin); } catch (e) {}
        P("--- candidate " + (idx + 1) + (idx === 0 ? "  (best)" : "") + " ---");
        P("discovered via: " + r.c.how);
        P("method: " + r.c.method);
        P("path: " + (u ? u.pathname : r.c.url));
        if (u && u.search) {
          var names = [];
          u.searchParams.forEach(function (v, k) { names.push(k + "=<" + (/^\d+$/.test(v) ? "int:" + v : "str") + ">"); });
          P("query: " + names.join("&"));
        }
        if (r.c.reqBody) {
          try {
            var pb = JSON.parse(String(r.c.reqBody));
            P("request body keys: " + Object.keys(pb).join(", "));
            if (pb.variables) P("  graphql variables: " + JSON.stringify(Object.keys(pb.variables)));
            if (pb.operationName) P("  graphql operation: " + pb.operationName);
          } catch (e) { P("request body: (non-json, len " + String(r.c.reqBody).length + ")"); }
        }
        P("rides at: " + r.f.path + "  (" + r.f.rides.length + " in this response)");
        P("response top-level keys: " + Object.keys(r.c.json).join(", "));

        var pag = [];
        (function scan(n, d) {
          if (!n || typeof n !== "object" || d > 4) return;
          Object.keys(n).forEach(function (k) {
            if (/(next|cursor|offset|page|total|count|has_?more)/i.test(k) && typeof n[k] !== "object") {
              pag.push(k + " = " + describe(k, n[k]));
            }
            if (n[k] && typeof n[k] === "object" && !Array.isArray(n[k])) scan(n[k], d + 1);
          });
        })(r.c.json, 0);
        P("pagination signals: " + (pag.length ? pag.join(" | ") : "(none found)"));

        var sample = r.f.rides.find(function (x) { var p = dig(x).price; return p && p.v > 0; }) || r.f.rides[0];
        P("");
        P("sample ride schema:");
        schema(sample, "", 0, []).forEach(P);
        P("");
        P("duration/price pairs (for unit detection):");
        r.f.rides.slice(0, 6).forEach(function (x) {
          var g = dig(x);
          P("  " + (g.dur ? g.dur.k + "=" + g.dur.v : "duration=?") + "   " + (g.price ? g.price.k + "=" + g.price.v : "price=?"));
        });
        P("");
      });

      if (ranked.length) {
        P("--- other endpoints seen ---");
        var paths = [];
        past.forEach(function (x) {
          var pth = x.replace(location.origin, "").split("?")[0];
          if (paths.indexOf(pth) === -1) paths.push(pth);
        });
        paths.slice(0, 20).forEach(function (x) { P("  " + x); });
      }

      var out = lines.join("\n");
      console.log(out);
      try { copy(out); console.log("%c↑ copied to clipboard", "font-weight:bold;color:#3987e5"); }
      catch (e) { console.log("(select the text above and copy it)"); }
      return out;
    }
  };

  console.log("%c[CBD v2] armed.", "color:#3987e5;font-weight:bold");
  console.log("Now run:  await CBD.report()      (it scrolls for you — takes ~10s)");
})();

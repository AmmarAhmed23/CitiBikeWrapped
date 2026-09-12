# Citi Bike Wrapped — the bookmarklet build

Same architecture citibikewrapped.com used, minus the part where your ride
history goes to someone else's server. Nothing leaves your browser.

```
  bookmark click
        │
        ▼
  loader bookmarklet ── 4 lines, injects a <script> tag
        │
        ▼
  fetch-rides.js ── runs INSIDE citibikenyc.com's origin
        │
        ├─ read window.__APOLLO_CLIENT__.cache.extract()
        ├─ click "Show More", poll the cache until 2026 is covered
        ├─ normalize → filter to 2026 → compute stats
        └─ render a story overlay in a Shadow DOM
```

## Why it reads the Apollo cache instead of the network

Three things about the live site, each found by diagnostics rather than guessed:

1. **The first 10 rides are server-rendered** into `__NEXT_DATA__`. No request
   happens for them, so there is nothing to intercept.
2. **Apollo binds its own `fetch`** when the client is constructed at page load.
   A bookmarklet patching `window.fetch` afterwards holds a different function
   than Apollo does, and never sees a single Apollo call. This is the one that
   wastes the most time if you don't know about it — the network tab shows
   traffic while your hook reports nothing.
3. **The GraphQL query text is stripped** by the production build
   (`loc.source.body` is gone), and the Apollo cache key is `rideHistory({})`
   — pagination arguments are hidden behind a `keyArgs: []` merge policy. So
   the query can't be reconstructed from either the document or the cache.

What IS reachable: `window.__APOLLO_CLIENT__`. Click the page's own "Show More"
button and read `client.cache.extract()` after each click. The app does its own
authenticated paging; the script just reads the result. Slower than a direct
API call — about a second per 10 rides — but it needs no knowledge of the
schema at all, which also makes it the most durable option.

There's a fast path that tries first: Apollo's parsed query AST survives
minification even though the text doesn't, so if the ride query exposes a
page-size variable it gets reused with `300`. It fails silently to the click
loop, which is what actually runs today.

## The exact field mapping

| field | type | meaning |
|---|---|---|
| `startTimeMs` / `endTimeMs` | string | epoch **milliseconds** |
| `duration` | number | **milliseconds** (÷60000 for minutes) |
| `price.formatted` | string | `"$0.30"` — there is no numeric price field |
| `rideableName` | string | bike id |

No station fields exist in this query, so there's no routes or map card.

---

## Setup (once)

**1. Host `fetch-rides.js` somewhere public.** GitHub Pages is the closest
equivalent to what he did — it serves the correct `application/javascript`
MIME type and honors the `?t=` cache-buster:

```bash
# new public repo, e.g. citibike-wrapped
git init && git add fetch-rides.js && git commit -m "wrapped payload"
git branch -M main && git remote add origin git@github.com:YOURNAME/citibike-wrapped.git
git push -u origin main
# then: repo Settings → Pages → Source: main branch, / (root)
```

Your file lands at `https://YOURNAME.github.io/citibike-wrapped/fetch-rides.js`.

jsDelivr also works (`https://cdn.jsdelivr.net/gh/YOURNAME/citibike-wrapped@main/fetch-rides.js`)
but it caches aggressively, so GitHub Pages is friendlier while you're iterating.

**2. Build the bookmarklet:**

```bash
python3 build_bookmarklet.py --url https://YOURNAME.github.io/citibike-wrapped/fetch-rides.js
```

**3. Make the bookmark.** Bookmark manager → Add new bookmark → name it
"Get My Wrapped" → paste the contents of `loader.txt` as the URL.

## Use it

Log into `account.citibikenyc.com/ride-history`, click the bookmark, wait a few
seconds. Arrow keys or click to move through the cards, Esc to close, and the
last card downloads your rides as CSV or JSON.

To do a different year, rebuild with `--year 2025`.

---

## When it breaks (it will, by design)

**Nothing happens, console says "Refused to load the script … Content Security
Policy".** Citi Bike shipped a CSP that blocks third-party script injection.
That kills the loader pattern entirely. Use `inline.txt` instead — same code,
encoded into the bookmark URL itself so nothing is loaded from outside. It's
~56KB of URL and you have to re-paste it after every change, which is exactly
the tradeoff the loader pattern exists to avoid.

**The overlay says "Couldn't read your rides".** `window.__CBW.raw` holds the
raw ride objects it saw and `.rides` what it normalized. Run `cbw_diagnose.js`
again — it re-derives the schema from scratch and will show what moved.

**Numbers look wrong.** `normalizeRide()` reads the exact fields first and only
falls back to name-matching. Check one object from `window.__CBW.raw`: the
traps are `duration` (ms, not seconds) and `price` (only a formatted string).

**It only found ~10 rides.** The click loop couldn't find or drive the "Show
More" button — the label or markup changed. The `PAGER` regex and `findPager()`
are what to adjust.

**It stops partway through the year.** `MAX_CLICKS` or the 8s growth timeout in
`waitForGrowth` ran out on a slow connection. Both are constants at the top.

---

## Files

| file | what it is |
|---|---|
| `fetch-rides.js` | the payload — data layer + UI, ~1000 lines, no dependencies |
| `build_bookmarklet.py` | generates `loader.txt` and `inline.txt` |
| `cbw_diagnose.js` | schema prober — re-derives the data shape if the site changes |
| `mock/server.py` | faithful replica: Next.js + Apollo + captured-fetch trap |
| `mock/test_wrapped.py` | headless-Chromium end-to-end test, screenshots every card |

Run the test suite without touching your real account:

```bash
pip install playwright && playwright install chromium
python3 mock/test_wrapped.py     # asserts ride count and total spend, writes mock/shots/
```

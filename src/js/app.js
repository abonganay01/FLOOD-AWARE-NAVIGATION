/*
 app.js — UPDATED: integrates AccuWeather (via /api/accuweather proxy) and NOAH proxy (/api/noah)
 - Uses MapLibre + OSRM (as before)
 - Attempts to fetch NOAH GeoJSON via proxy; falls back to previous direct attempt if proxy missing
 - Route scoring now includes AccuWeather precipitation/alerts sampled at route midpoints
 - Map click still records local flood reports; clicking a point will also show AccuWeather info (if available)
 - Developer-provided local screenshot path (for fallback UI) is included below:
   file:///mnt/data/d5f06fea-e14b-42ea-bbf4-41e4e35224db.png
*/

console.log("app.js (with AccuWeather + NOAH proxy support) loaded.");

/* -------------------------
   Configuration
   ------------------------- */
const NOAH_TILE_URL = "https://noah.up.edu.ph/api/tiles/{z}/{x}/{y}.png";
const NOAH_GEOJSON_DIRECT = "https://noah.up.edu.ph/api/flood-geojson.json";
const NOAH_GEOJSON_PROXY = "/api/noah"; // serverless proxy (recommended)
const ACCUWEATHER_PROXY = "/api/accuweather"; // serverless proxy: /api/accuweather?lat=..&lng=..
const CARTO_STYLE = "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";
const MAPLIBRE_DEMO = "https://demotiles.maplibre.org/style.json";
const OSRM_SERVER = "https://router.project-osrm.org"; // public demo server

// local developer screenshot path (from uploaded files)
const FOLDER_SCREENSHOT_LOCAL = "file:///mnt/data/d5f06fea-e14b-42ea-bbf4-41e4e35224db.png";

/* -------------------------
   FloodLearner (same shim)
   ------------------------- */
const FloodLearner = {
  _key(lat, lng, p = 3) { return `${Number(lat).toFixed(p)}|${Number(lng).toFixed(p)}`; },
  all() { try { return JSON.parse(localStorage.getItem("flood_grid") || "{}"); } catch(e){ return {}; } },
  increment(lat, lng) { const k = this._key(lat,lng); const g = this.all(); g[k] = (g[k]||0)+1; localStorage.setItem("flood_grid", JSON.stringify(g)); return g[k]; },
  score(lat, lng) { const g = this.all(); return g[this._key(lat,lng)]||0; },
  clear() { localStorage.removeItem("flood_grid"); }
};

/* -------------------------
   Utility / status
   ------------------------- */
function setStatus(msg) {
  const el = document.getElementById("status");
  if (el) el.textContent = msg;
  console.log("[STATUS]", msg);
}

function safeFetchJSON(url, opts = {}) {
  return fetch(url, opts).then(r => {
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    return r.json();
  });
}

/* -------------------------
   Map & init
   ------------------------- */
let map;
let routeSources = [];

async function testNoahTileAvailability() {
  const testURL = NOAH_TILE_URL.replace("{z}", "10").replace("{x}", "865").replace("{y}", "512");
  try {
    // HEAD may be blocked on some servers, fallback to GET with no-cache
    const r = await fetch(testURL, { method: "GET", cache: "no-store" });
    return r.ok && r.headers.get("content-type") && r.headers.get("content-type").startsWith("image");
  } catch (e) {
    console.warn("NOAH tiles test failed:", e);
    return false;
  }
}

async function initMap() {
  setStatus("Checking NOAH tiles...");
  const noahTilesOK = await testNoahTileAvailability();

  let chosenStyle = MAPLIBRE_DEMO;
  if (noahTilesOK) {
    // create an ad-hoc style using NOAH raster tiles
    chosenStyle = {
      version: 8,
      sources: {
        noah: {
          type: "raster",
          tiles: [ NOAH_TILE_URL ],
          tileSize: 256
        }
      },
      layers: [
        { id: "noah-basemap", type: "raster", source: "noah" }
      ]
    };
    console.log("Using NOAH raster tiles as basemap.");
  } else {
    chosenStyle = CARTO_STYLE; // prefer Carto Voyager as fallback
    console.log("NOAH tiles not available; using Carto Voyager style.");
  }

  map = new maplibregl.Map({
    container: "map",
    style: chosenStyle,
    center: [120.9842, 14.5995],
    zoom: 12
  });

  map.addControl(new maplibregl.NavigationControl());

  // click to record flood and show AccuWeather popup if available
  map.on("click", async (ev) => {
    const lat = ev.lngLat.lat;
    const lng = ev.lngLat.lng;
    const count = FloodLearner.increment(lat, lng);
    setStatus(`Flood report recorded (count=${count})`);

    // add a simple marker
    const el = document.createElement("div");
    el.className = "flood-marker";
    const marker = new maplibregl.Marker(el).setLngLat([lng, lat]).addTo(map);

    // try fetch AccuWeather info for this point (via proxy)
    const accu = await fetchAccuWeatherProxy(lat, lng);
    if (accu && accu.current) {
      const cur = accu.current;
      const html = `<strong>Weather</strong><br/>
                    ${cur.WeatherText || "N/A"}<br/>
                    Precip (past hour): ${cur.PrecipitationSummary?.PastHour?.Metric?.Value ?? "N/A"} ${cur.PrecipitationSummary?.PastHour?.Metric?.Unit ?? ""}`;
      new maplibregl.Popup({ offset: 12 }).setLngLat([lng, lat]).setHTML(html).addTo(map);
    }
  });

  // attempt to load NOAH hazard polygons via proxy (preferred) or direct if proxy missing
  await attemptLoadNoahGeoJSON();

  setStatus("Map ready.");
}

/* -------------------------
   NOAH GeoJSON loading helper (prefers /api/noah)
   ------------------------- */
async function attemptLoadNoahGeoJSON() {
  setStatus("Loading NOAH hazard polygons...");
  // Try proxy first
  try {
    const gj = await fetchNoahGeojsonProxy();
    if (gj) {
      addNoahHazardLayer(gj);
      setStatus("NOAH hazard polygons loaded (via proxy).");
      return;
    }
  } catch (e) {
    console.warn("NOAH proxy failed:", e);
  }

  // Fallback: attempt direct fetch (may be blocked by CORS)
  try {
    const gjDirect = await safeFetchJSON(NOAH_GEOJSON_DIRECT);
    addNoahHazardLayer(gjDirect);
    setStatus("NOAH hazard polygons loaded (direct).");
    return;
  } catch (e) {
    console.warn("Direct NOAH GeoJSON fetch failed:", e);
    setStatus("NOAH hazard polygons unavailable.");
  }
}

/* -------------------------
   Add NOAH hazard layer styling (expects GeoJSON)
   ------------------------- */
function addNoahHazardLayer(geojson) {
  try {
    if (map.getSource("noahHazard")) {
      map.getSource("noahHazard").setData(geojson);
    } else {
      map.addSource("noahHazard", { type: "geojson", data: geojson });
      map.addLayer({
        id: "noahHazard-fill",
        type: "fill",
        source: "noahHazard",
        paint: {
          // use 'risk' property if present; fallback to a single color
          "fill-color": [
            "interpolate",
            ["linear"],
            ["coalesce", ["get", "risk"], 0],
            0, "#ffffb2",
            1, "#fecc5c",
            2, "#fd8d3c",
            3, "#f03b20"
          ],
          "fill-opacity": 0.35
        }
      });
      map.addLayer({
        id: "noahHazard-line",
        type: "line",
        source: "noahHazard",
        paint: { "line-color": "#990000", "line-width": 1 }
      });

      // optional labels: show risk property if present
      map.addLayer({
        id: "noahHazard-labels",
        type: "symbol",
        source: "noahHazard",
        layout: {
          "text-field": ["coalesce", ["get", "label"], ["concat", ["to-string", ["coalesce", ["get", "risk"], 0]], " risk"]],
          "text-size": 12,
          "text-allow-overlap": false
        },
        paint: { "text-color": "#600000" }
      });
    }
  } catch (e) {
    console.warn("Failed to add NOAH hazard layer:", e);
  }
}

/* -------------------------
   Proxies: fetch NOAH and AccuWeather via server endpoints (if available)
   ------------------------- */
async function fetchNoahGeojsonProxy() {
  try {
    const r = await fetch(NOAH_GEOJSON_PROXY, { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error(`Proxy returned ${r.status}`);
    return await r.json();
  } catch (e) {
    console.warn("NOAH proxy fetch error:", e);
    return null;
  }
}

async function fetchAccuWeatherProxy(lat, lng) {
  try {
    // call serverless endpoint; server should return { locationKey, current: {...} }
    const url = `${ACCUWEATHER_PROXY}?lat=${encodeURIComponent(lat)}&lng=${encodeURIComponent(lng)}`;
    const r = await fetch(url, { headers: { "Accept": "application/json" } });
    if (!r.ok) throw new Error(`Accu proxy ${r.status}`);
    return await r.json();
  } catch (e) {
    console.warn("Accu proxy fetch failed:", e);
    return null;
  }
}

/* -------------------------
   Geocoding (Nominatim fallback)
   ------------------------- */
async function resolveLocation(text) {
  if (!text) return null;
  const parts = text.split(",").map(s => s.trim());
  if (parts.length === 2) {
    const lat = parseFloat(parts[0]), lng = parseFloat(parts[1]);
    if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
  }
  // Nominatim search (rate-limited)
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(text)}`;
    const r = await safeFetchJSON(url);
    if (Array.isArray(r) && r.length > 0) return { lat: parseFloat(r[0].lat), lng: parseFloat(r[0].lon) };
  } catch (e) {
    console.warn("Nominatim geocode failed:", e);
  }
  return null;
}

/* -------------------------
   OSRM routing request
   ------------------------- */
async function requestOSRMRoute(origin, destination) {
  const coords = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
  const url = `${OSRM_SERVER}/route/v1/driving/${coords}?overview=full&alternatives=true&geometries=geojson`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`OSRM ${r.status}`);
  return await r.json();
}

/* -------------------------
   Scoring: combine learned + NOAH feature + AccuWeather
   - learned: FloodLearner average over sampled points
   - noahRisk: if NOAH polygons present, compute intersection count or co-locate sample -> simplified here
   - weather: fetch AccuWeather via proxy at midpoint, derive rainScore & alertScore
   ------------------------- */
function sampleCoordsFromGeojson(geojson, maxSamples = 30) {
  if (!geojson || !geojson.coordinates) return [];
  const coords = geojson.coordinates;
  const step = Math.max(1, Math.floor(coords.length / maxSamples));
  const out = [];
  for (let i = 0; i < coords.length; i += step) {
    const [lng, lat] = coords[i];
    out.push({ lat, lng });
  }
  return out;
}

// compute learned average
function computeLearnedScore(geojson) {
  const samples = sampleCoordsFromGeojson(geojson, 30);
  if (samples.length === 0) return 0;
  let sum = 0;
  samples.forEach(p => { sum += FloodLearner.score(p.lat, p.lng); });
  return sum / samples.length;
}

// optionally compute NOAH polygon overlap score by sampling points and checking if they fall within a hazard feature
// (lightweight client-side approach: use map.queryRenderedFeatures if the noahHazard source/layer exists)
function computeNoahScore(geojson) {
  if (!map || !map.getSource || !map.getLayer) return 0;
  if (!map.getSource("noahHazard")) return 0;
  const samples = sampleCoordsFromGeojson(geojson, 20);
  let hits = 0;
  samples.forEach(p => {
    // queryRenderedFeatures expects [point] in pixel coordinates; we can use map.queryRenderedFeatures with bbox small around point
    try {
      const bbox = [
        map.project([p.lng - 0.0001, p.lat - 0.0001]),
        map.project([p.lng + 0.0001, p.lat + 0.0001])
      ];
      const features = map.queryRenderedFeatures([bbox[0], bbox[1]], { layers: ["noahHazard-fill", "noahHazard-line"] });
      if (features && features.length > 0) hits++;
    } catch (e) {
      // ignore
    }
  });
  // return normalized hit rate
  return samples.length > 0 ? hits / samples.length : 0;
}

// fetch weather for a sample point and compute a small score
async function computeWeatherScoreForPoint(lat, lng) {
  const accu = await fetchAccuWeatherProxy(lat, lng);
  if (!accu || !accu.current) return { rainScore: 0, alertScore: 0, raw: null };
  const cur = accu.current;
  // sample fields (AccuWeather's schema may differ; adapt as needed)
  // HasPrecipitation, PrecipitationSummary.PastHour.Metric.Value
  const pastHour = cur.PrecipitationSummary && cur.PrecipitationSummary.PastHour && cur.PrecipitationSummary.PastHour.Metric && cur.PrecipitationSummary.PastHour.Metric.Value;
  const rainMM = pastHour ? Number(pastHour) : 0;
  const rainScore = Math.min(10, rainMM); // simple clamp
  let alertScore = 0;
  if (cur.WeatherText && /thunderstorm|tornado|flood|severe/i.test(cur.WeatherText)) alertScore = 5;
  return { rainScore, alertScore, raw: cur };
}

// combined scoring for a route geometry (async)
async function scoreRouteCombinedAsync(geojson) {
  // learned
  const learned = computeLearnedScore(geojson); // avg count
  // noah
  const noah = computeNoahScore(geojson); // 0..1
  // weather: sample midpoint
  const coords = geojson.coordinates;
  const midIdx = Math.floor(coords.length / 2);
  const [midLng, midLat] = coords[midIdx] || coords[0];
  let weather = { rainScore: 0, alertScore: 0, raw: null };
  try {
    weather = await computeWeatherScoreForPoint(midLat, midLng);
  } catch (e) { console.warn("Weather score failed:", e); }

  // combine with weights (tunable)
  const wLearned = 1.0;        // per-count weight
  const wNoah = 3.0;          // noah presence heavy weight
  const wRain = 0.2;          // rain mm scaling
  const wAlert = 2.0;         // alert importance

  // normalize noah (0..1) to 0..3
  const noahNorm = noah * 3.0;

  const combined = (wLearned * learned) + (wNoah * noahNorm) + (wRain * weather.rainScore) + (wAlert * weather.alertScore);
  return { combined, breakdown: { learned, noah, weather } };
}

/* -------------------------
   Draw/clear routes (helpers)
   ------------------------- */
let drawnRouteIds = [];
function clearRoutes() {
  drawnRouteIds.forEach(id => {
    try {
      if (map.getLayer(id)) map.removeLayer(id);
      if (map.getSource(id)) map.removeSource(id);
    } catch (e) {}
  });
  drawnRouteIds = [];
}

function drawGeojsonRoute(geojson, idSuffix, isBest=false) {
  const srcId = `route-src-${idSuffix}`;
  const lineId = `route-line-${idSuffix}`;
  // cleanup if exists
  if (map.getLayer(lineId)) map.removeLayer(lineId);
  if (map.getSource(srcId)) map.removeSource(srcId);
  map.addSource(srcId, { type: "geojson", data: geojson });
  map.addLayer({
    id: lineId,
    type: "line",
    source: srcId,
    paint: {
      "line-color": isBest ? "#007cbf" : "#888",
      "line-width": isBest ? 6 : 3,
      "line-opacity": isBest ? 0.95 : 0.5
    }
  });
  drawnRouteIds.push(lineId);
}

/* -------------------------
   Main routing flow (async)
   ------------------------- */
async function handleRouting() {
  setStatus("Resolving origin & destination...");
  const originText = document.getElementById("origin").value;
  const destText = document.getElementById("destination").value;
  const threshold = Number(document.getElementById("threshold").value) || 2;

  const o = await resolveLocation(originText);
  const d = await resolveLocation(destText);
  if (!o || !d) { setStatus("Could not resolve origin or destination. Use lat,lng or a valid address."); return; }

  setStatus("Requesting OSRM routes...");
  try {
    const osrm = await requestOSRMRoute(o, d);
    if (!osrm || !osrm.routes || osrm.routes.length === 0) { setStatus("No routes found."); return; }

    clearRoutes();
    // evaluate all routes in parallel (scoreRouteCombinedAsync)
    const evaluations = await Promise.all(osrm.routes.map(async (r, idx) => {
      const geo = r.geometry;
      const scoreObj = await scoreRouteCombinedAsync(geo);
      return { idx, geo, score: scoreObj.combined, details: scoreObj.breakdown };
    }));

    // sort by score ascending (safer = lower)
    evaluations.sort((a,b) => a.score - b.score);

    // draw alternatives and best
    evaluations.forEach((ev, i) => {
      drawGeojsonRoute({ type: "Feature", geometry: ev.geo }, `alt-${i}`, false);
    });

    const best = evaluations[0];
    if (best) {
      drawGeojsonRoute({ type: "Feature", geometry: best.geo }, `best`, true);
      setStatus(`Best route selected (risk ${best.score.toFixed(2)}).`);
      // popup with breakdown
      const mid = best.geo.coordinates[Math.floor(best.geo.coordinates.length/2)];
      const [lng, lat] = mid;
      const popupHtml = `<strong>Route risk: ${best.score.toFixed(2)}</strong><br/>
                         learned avg: ${best.details.learned.toFixed(2)}<br/>
                         NOAH overlap: ${(best.details.noah*100).toFixed(1)}%<br/>
                         weather sample rainScore: ${best.details.weather.rainScore} mm, alertScore: ${best.details.weather.alertScore}`;
      new maplibregl.Popup({ offset: 12 }).setLngLat([lng, lat]).setHTML(popupHtml).addTo(map);

      if (best.score >= threshold) {
        setStatus(`Warning: best route risk ${best.score.toFixed(2)} >= threshold ${threshold}. Consider detour.`);
      }
    }

  } catch (e) {
    console.error("Routing flow error:", e);
    setStatus("Routing failed (see console).");
  }
}

/* -------------------------
   Wire UI & init
   ------------------------- */
function wireUI() {
  const form = document.getElementById("route-form");
  if (form) form.addEventListener("submit", (ev) => { ev.preventDefault(); handleRouting(); });

  const clearBtn = document.getElementById("clear-memory");
  if (clearBtn) clearBtn.addEventListener("click", () => { FloodLearner.clear(); setStatus("Local flood memory cleared."); clearRoutes(); });
}

window.addEventListener("load", () => {
  wireUI();
  initMap().catch(e => {
    console.error("initMap failed:", e);
    setStatus("Map initialization failed. See console.");
    // show fallback panel with folder screenshot link for debugging
    const mapEl = document.getElementById("map");
    if (mapEl) {
      mapEl.innerHTML = `<div class="map-fallback"><div class="box"><h3>Map failed to initialize</h3>
        <p>Check console for errors. Folder screenshot (local):</p>
        <a href="${FOLDER_SCREENSHOT_LOCAL}" target="_blank">Open folder screenshot</a>
      </div></div>`;
    }
  });
});

/* -------------------------
   Reused helpers (resolveLocation, requestOSRMRoute, safeFetchJSON)
   These functions are expected to already be present in your code base from previous app.js.
   If not present, they are included below for completeness.
   ------------------------- */

async function safeFetchJSON(url, opts={}) {
  const r = await fetch(url, opts);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return await r.json();
}

async function resolveLocation(text) {
  if (!text) return null;
  const parts = text.split(",").map(s => s.trim());
  if (parts.length === 2) {
    const lat = parseFloat(parts[0]), lng = parseFloat(parts[1]);
    if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
  }
  // Nominatim lookup
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(text)}`;
    const arr = await safeFetchJSON(url);
    if (Array.isArray(arr) && arr.length > 0) return { lat: parseFloat(arr[0].lat), lng: parseFloat(arr[0].lon) };
  } catch (e) {
    console.warn("Nominatim failed:", e);
  }
  return null;
}

async function requestOSRMRoute(origin, destination) {
  const coords = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
  const url = `${OSRM_SERVER}/route/v1/driving/${coords}?overview=full&alternatives=true&geometries=geojson`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`OSRM ${r.status}`);
  return await r.json();
}

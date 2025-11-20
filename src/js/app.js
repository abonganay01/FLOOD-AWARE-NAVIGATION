/*
 app.js — Project NOAH basemap + fallback + OSRM routing + AI-ready FloodLearner
*/

console.log("app.js loaded: initializing diagnostics...");

/* ============================================================
   1. BASEMAP SOURCES (NOAH → Carto → MapLibre fallback)
   ============================================================ */
const NOAH_TILE_URL = "https://noah.up.edu.ph/api/tiles/{z}/{x}/{y}.png";
const CARTO_STYLE = "https://basemaps.cartocdn.com/gl/voyager-gl-style/style.json";
const MAPLIBRE_DEMO = "https://demotiles.maplibre.org/style.json";

let chosenStyle = MAPLIBRE_DEMO; // fallback default

/* ============================================================
   2. NOAH GeoJSON hazard data (if available)
   ============================================================ */
const NOAH_GEOJSON = "https://noah.up.edu.ph/api/flood-geojson.json";

/* ============================================================
   3. OSRM settings
   ============================================================ */
const OSRM_SERVER = "https://router.project-osrm.org"; // demo server

/* ============================================================
   4. AI-ready FloodLearner (local grid store)
   ============================================================ */
const FloodLearner = {
  _key(lat, lng, p = 3) {
    return `${lat.toFixed(p)}|${lng.toFixed(p)}`;
  },
  all() {
    try {
      return JSON.parse(localStorage.getItem("flood_grid")) || {};
    } catch {
      return {};
    }
  },
  increment(lat, lng) {
    const k = this._key(lat, lng);
    const grid = this.all();
    grid[k] = (grid[k] || 0) + 1;
    localStorage.setItem("flood_grid", JSON.stringify(grid));
    return grid[k];
  },
  score(lat, lng) {
    const grid = this.all();
    return grid[this._key(lat, lng)] || 0;
  },
  clear() {
    localStorage.removeItem("flood_grid");
  }
};

/* ============================================================
   Helper: Update status text
   ============================================================ */
function setStatus(msg) {
  const box = document.getElementById("status");
  if (box) box.textContent = msg;
  console.log("[STATUS]", msg);
}

/* ============================================================
   5. Test NOAH tile availability
   ============================================================ */
async function testNoahTiles() {
  const testURL = NOAH_TILE_URL
    .replace("{z}", "10")
    .replace("{x}", "865")
    .replace("{y}", "512");

  try {
    const r = await fetch(testURL, { method: "HEAD" });
    if (r.ok) {
      console.log("NOAH tiles are available.");
      return true;
    }
  } catch (e) {
    console.warn("NOAH tile test failed:", e);
  }
  return false;
}

/* ============================================================
   6. Initialize map
   ============================================================ */
let map;

async function initMap() {
  setStatus("Checking NOAH tiles...");

  const noahAvailable = await testNoahTiles();

  if (noahAvailable) {
    console.log("Using NOAH raster tiles as basemap...");
    chosenStyle = {
      version: 8,
      sources: {
        noah: {
          type: "raster",
          tiles: [NOAH_TILE_URL],
          tileSize: 256
        }
      },
      layers: [
        {
          id: "noah-basemap",
          type: "raster",
          source: "noah"
        }
      ]
    };
  } else {
    console.warn("NOAH tiles unavailable — using Carto Voyager...");
    chosenStyle = CARTO_STYLE;
  }

  map = new maplibregl.Map({
    container: "map",
    style: chosenStyle,
    center: [120.9842, 14.5995],
    zoom: 12
  });

  map.addControl(new maplibregl.NavigationControl());

  /* ============================================================
     Click → record flood report
     ============================================================ */
  map.on("click", (e) => {
    const lat = e.lngLat.lat;
    const lng = e.lngLat.lng;

    const count = FloodLearner.increment(lat, lng);
    setStatus(`Flood report added (count = ${count})`);

    const mark = document.createElement("div");
    mark.className = "flood-marker";

    new maplibregl.Marker(mark)
      .setLngLat([lng, lat])
      .addTo(map);
  });

  loadNoahGeoJSON();
}

/* ============================================================
   7. Load NOAH GeoJSON hazard polygons
   ============================================================ */
async function loadNoahGeoJSON() {
  setStatus("Loading NOAH hazard polygons...");
  try {
    const r = await fetch(NOAH_GEOJSON);
    if (!r.ok) throw new Error("NOAH geojson rejected");
    const gj = await r.json();

    map.addSource("noahHazard", {
      type: "geojson",
      data: gj
    });

    map.addLayer({
      id: "noahHazard-fill",
      type: "fill",
      source: "noahHazard",
      paint: {
        "fill-color": "#ff0000",
        "fill-opacity": 0.25
      }
    });

    map.addLayer({
      id: "noahHazard-outline",
      type: "line",
      source: "noahHazard",
      paint: {
        "line-color": "#990000",
        "line-width": 1
      }
    });

    setStatus("NOAH hazard polygons loaded.");
  } catch (e) {
    console.warn("NOAH GeoJSON unavailable:", e);
    setStatus("NOAH hazard polygons unavailable.");
  }
}

/* ============================================================
   8. Geocoding helper (Nominatim)
   ============================================================ */
async function resolveLocation(text) {
  text = text.trim();
  const raw = text.split(",").map(x => x.trim());
  if (raw.length === 2) {
    const lat = parseFloat(raw[0]);
    const lng = parseFloat(raw[1]);
    if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
  }

  try {
    const url =
      "https://nominatim.openstreetmap.org/search?format=json&q=" +
      encodeURIComponent(text);
    const r = await fetch(url);
    const j = await r.json();
    if (j.length > 0) {
      return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) };
    }
  } catch (e) {
    console.warn("Geocode failed:", e);
  }

  return null;
}

/* ============================================================
   9. Request OSRM route
   ============================================================ */
async function getOSRMRoute(o, d) {
  const coords = `${o.lng},${o.lat};${d.lng},${d.lat}`;
  const url = `${OSRM_SERVER}/route/v1/driving/${coords}?overview=full&alternatives=true&geometries=geojson`;

  const r = await fetch(url);
  if (!r.ok) throw new Error("OSRM request failed");
  return await r.json();
}

/* ============================================================
   10. Draw a route
   ============================================================ */
function drawRoute(geojson, id) {
  const src = `r-src-${id}`;
  const line = `r-line-${id}`;

  if (map.getLayer(line)) map.removeLayer(line);
  if (map.getSource(src)) map.removeSource(src);

  map.addSource(src, { type: "geojson", data: geojson });

  map.addLayer({
    id: line,
    type: "line",
    source: src,
    paint: {
      "line-color": "#007cbf",
      "line-width": id === "best" ? 6 : 3,
      "line-opacity": id === "best" ? 1.0 : 0.5
    }
  });
}

/* ============================================================
   11. Score route by local flood grid
   ============================================================ */
function scoreRoute(geojson) {
  let total = 0;
  let c = 0;

  const pts = geojson.coordinates;
  const step = Math.max(1, Math.floor(pts.length / 30));

  for (let i = 0; i < pts.length; i += step) {
    const [lng, lat] = pts[i];
    total += FloodLearner.score(lat, lng);
    c++;
  }

  return c > 0 ? total / c : 0;
}

/* ============================================================
   12. Main routing handler
   ============================================================ */
async function handleRouting() {
  const textO = document.getElementById("origin").value;
  const textD = document.getElementById("destination").value;
  const threshold = Number(document.getElementById("threshold").value) || 2;

  setStatus("Resolving locations...");

  const o = await resolveLocation(textO);
  const d = await resolveLocation(textD);

  if (!o || !d) {
    setStatus("Failed to resolve origin or destination.");
    return;
  }

  setStatus("Requesting OSRM routes...");

  try {
    const res = await getOSRMRoute(o, d);
    if (!res.routes || res.routes.length === 0) {
      setStatus("No routes returned.");
      return;
    }

    let best = null;
    let bestScore = Infinity;

    res.routes.forEach((r, idx) => {
      const geo = r.geometry;
      const sc = scoreRoute(geo);

      drawRoute({ type: "Feature", geometry: geo }, "alt-" + idx);

      if (sc < bestScore) {
        bestScore = sc;
        best = geo;
      }
    });

    if (best) {
      drawRoute({ type: "Feature", geometry: best }, "best");
      setStatus(`Best route selected (risk ${bestScore.toFixed(2)}).`);

      if (bestScore >= threshold) {
        setStatus(`Warning: route risk ${bestScore.toFixed(2)} exceeds threshold.`);
      }
    }
  } catch (e) {
    console.error(e);
    setStatus("Routing failed.");
  }
}

/* ============================================================
   13. Wire UI events
   ============================================================ */
function wireUI() {
  document
    .getElementById("route-form")
    .addEventListener("submit", (e) => {
      e.preventDefault();
      handleRouting();
    });

  document.getElementById("clear-memory").addEventListener("click", () => {
    FloodLearner.clear();
    setStatus("Local flood memory cleared.");
  });
}

/* ============================================================
   14. Initialize everything
   ============================================================ */
window.addEventListener("load", () => {
  wireUI();
  initMap();
  setStatus("Map loading...");
});

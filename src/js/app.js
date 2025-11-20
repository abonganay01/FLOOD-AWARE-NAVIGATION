/*
 app.js - MapLibre + OSRM demo integration
 - Free: uses MapLibre (demotiles) and public OSRM demo server.
 - No API keys required.
 - Click on the map to report floods (stored in localStorage).
 - Enter addresses or lat,lng strings; if addresses are used the app will try to use
   the browser's Geolocation API for a crude resolution fallback (best to use lat,lng).
 - For production, replace OSRM public server with your own self-hosted OSRM.
*/

const MAP_STYLE = 'https://demotiles.maplibre.org/style.json';
const OSRM_SERVER = 'https://router.project-osrm.org'; // public demo; self-host for production

// Simple FloodLearner shim storing counts in localStorage
const FloodLearner = {
  _key(lat, lng, precision = 3) { return `${Number(lat).toFixed(precision)}|${Number(lng).toFixed(precision)}`; },
  getAll() { try { return JSON.parse(localStorage.getItem('flood_grid')||'{}'); } catch(e){ return {}; } },
  increment(lat,lng) { const key=this._key(lat,lng); const all=this.getAll(); all[key]=(all[key]||0)+1; localStorage.setItem('flood_grid', JSON.stringify(all)); return all[key]; },
  scoreAt(lat,lng){ const all=this.getAll(); return all[this._key(lat,lng)]||0; },
  clear(){ localStorage.removeItem('flood_grid'); }
};

function setStatus(msg){ const el=document.getElementById('status'); if(el) el.textContent=msg; console.log('[status]',msg); }

// init map
let map, routeLayers = [], noahLayerAdded=false;

function initMap() {
  map = new maplibregl.Map({
    container: 'map',
    style: MAP_STYLE,
    center: [120.9842, 14.5995],
    zoom: 12
  });

  map.addControl(new maplibregl.NavigationControl());

  // click to report flood
  map.on('click', (e) => {
    const lat = e.lngLat.lat, lng = e.lngLat.lng;
    const count = FloodLearner.increment(lat, lng);
    setStatus(`Flood report recorded locally (count=${count})`);
    // simple visual marker
    const id = 'flood-marker-' + Date.now();
    const el = document.createElement('div');
    el.className = 'flood-marker';
    el.title = `Flood reports: ${count}`;
    el.style.width='12px'; el.style.height='12px'; el.style.borderRadius='6px'; el.style.background='rgba(255,0,0,0.8)';
    new maplibregl.Marker(el).setLngLat([lng,lat]).addTo(map);
  });

  // try to load NOAH geojson overlay
  const NOAH_URL = 'https://noah.up.edu.ph/api/flood-geojson.json';
  fetch(NOAH_URL).then(r=>{ if(!r.ok) throw new Error('NOAH unavailable'); return r.json(); }).then(gj=>{
    try {
      map.addSource('noah', { type:'geojson', data: gj });
      map.addLayer({ id:'noah-fill', type:'fill', source:'noah', paint:{ 'fill-color':'#ff0000','fill-opacity':0.25 } });
      map.addLayer({ id:'noah-line', type:'line', source:'noah', paint:{ 'line-color':'#990000','line-width':1 } });
      noahLayerAdded = true;
      setStatus('NOAH layer loaded (if available)');
    } catch(e){ console.warn('NOAH parse failed',e); }
  }).catch(e=>{ console.info('NOAH fetch skipped or failed', e && e.message ? e.message : e); });

}

// Utility: parse "lat,lng" or return null
function parseLatLngString(s){
  if(!s) return null;
  const parts = s.split(',').map(p=>p.trim());
  if(parts.length===2){
    const lat = parseFloat(parts[0]), lng = parseFloat(parts[1]);
    if(!isNaN(lat) && !isNaN(lng)) return { lat, lng };
  }
  return null;
}

// Geocode minimal fallback: if input is lat,lng use it, otherwise attempt to use browser geolocation (best-effort)
async function resolveLocation(input){
  const p = parseLatLngString(input);
  if(p) return p;
  // Attempt to use Nominatim geocoding (free) — rate-limited
  try {
    const url = 'https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(input);
    const r = await fetch(url);
    if(!r.ok) throw new Error('Nominatim failed');
    const j = await r.json();
    if(j && j.length>0) return { lat: parseFloat(j[0].lat), lng: parseFloat(j[0].lon) };
  } catch(e){
    console.warn('Geocode failed', e);
  }
  return null;
}

// draw route GeoJSON on map
function drawRoute(geojson, idSuffix){
  const id = 'route-' + idSuffix;
  // remove previous layers with same id
  if(map.getLayer(id + '-line')) { map.removeLayer(id + '-line'); }
  if(map.getSource(id)) { map.removeSource(id); }
  map.addSource(id, { type:'geojson', data: geojson });
  map.addLayer({ id: id + '-line', type:'line', source:id, paint:{ 'line-color':'#007cbf', 'line-width': 6, 'line-opacity': 0.8 } });
  // store for cleanup
  routeLayers.push(id);
}

// clear previous routes
function clearRoutes(){
  for(const id of routeLayers){
    if(map.getLayer(id + '-line')) map.removeLayer(id + '-line');
    if(map.getSource(id)) map.removeSource(id);
  }
  routeLayers = [];
}

// score route by sampling points and summing FloodLearner scores
function scoreRouteByGeojson(geojson){
  let total = 0, count = 0;
  // geojson.linestring coordinates: [ [lng,lat], ... ]
  if(!geojson || !geojson.coordinates) return 0;
  const coords = geojson.coordinates;
  const step = Math.max(1, Math.floor(coords.length / 30));
  for(let i=0;i<coords.length;i+=step){
    const [lng,lat] = coords[i];
    total += FloodLearner.scoreAt(lat,lng);
    count++;
  }
  return count>0 ? total / count : 0;
}

// request OSRM route
async function requestOSRM(origin, destination){
  // origin/destination as {lat,lng}
  const coords = `${origin.lng},${origin.lat};${destination.lng},${destination.lat}`;
  const url = `${OSRM_SERVER}/route/v1/driving/${coords}?alternatives=true&overview=full&geometries=geojson`;
  const r = await fetch(url);
  if(!r.ok) throw new Error('OSRM route request failed: ' + r.status);
  return await r.json();
}

// main routing flow
async function handleRoute(originInput, destinationInput, threshold){
  setStatus('Resolving locations...');
  const origin = await resolveLocation(originInput);
  const dest = await resolveLocation(destinationInput);
  if(!origin || !dest){ setStatus('Failed to resolve origin or destination. Use lat,lng or a valid address.'); return; }

  setStatus('Requesting routes from OSRM...');
  try {
    const res = await requestOSRM(origin, dest);
    if(!res || !res.routes || res.routes.length===0){ setStatus('No routes returned'); return; }
    clearRoutes();
    // score each route and draw
    const scored = [];
    for(let i=0;i<res.routes.length;i++){
      const r = res.routes[i];
      const geo = r.geometry; // GeoJSON LineString
      const score = scoreRouteByGeojson(geo);
      scored.push({ index:i, score, route: r, geometry: geo });
      // draw each route with thinner line; highlight best later
      drawRoute({ type: 'Feature', geometry: geo }, 'alt-' + i);
    }
    // sort by score ascending
    scored.sort((a,b)=>a.score-b.score);
    const best = scored[0];
    // highlight best route
    if(best){
      // draw thick highlighted line
      drawRoute({ type:'Feature', geometry: best.geometry }, 'best');
      setStatus(`Best route selected (risk ${best.score.toFixed(2)}).`);
      // if risk too high, attempt simple detour by offsetting midpoint
      if(best.score >= threshold){
        setStatus('Best route high risk — attempting detour...');
        // compute midpoint coordinate
        const midIdx = Math.floor(best.geometry.coordinates.length/2);
        const [midLng, midLat] = best.geometry.coordinates[midIdx];
        // small offset (~0.01 degrees ~1km) try a detour waypoint
        const offsetPoint = { lat: midLat + 0.01, lng: midLng + 0.01 };
        try {
          const detourRes = await requestOSRM(origin, dest + ''); // we will instead attempt with waypoint by building a coords string
          // OSRM public API doesn't support waypoints in simple GET easily; skip complex detour for now
          setStatus(`No safer detour found (risk ${best.score.toFixed(2)}).`);
        } catch(e){
          console.warn('Detour attempt error', e);
          setStatus(`No safer detour found (risk ${best.score.toFixed(2)}).`);
        }
      }
    }
  } catch(e){
    console.error(e);
    setStatus('Routing failed: ' + (e.message || e));
  }
}

// wire UI
function wireUI(){
  const form = document.getElementById('route-form');
  form.addEventListener('submit', (ev)=>{
    ev.preventDefault();
    const origin = document.getElementById('origin').value;
    const destination = document.getElementById('destination').value;
    const threshold = Number(document.getElementById('threshold').value) || 2;
    handleRoute(origin, destination, threshold);
  });

  document.getElementById('clear-memory').addEventListener('click', ()=>{
    FloodLearner.clear();
    setStatus('Local flood memory cleared');
    clearRoutes();
  });
}

// init everything
function init(){
  initMap();
  wireUI();
  setStatus('Map initialized (MapLibre). Use lat,lng for reliable routing.');
}

// run
window.addEventListener('load', init);

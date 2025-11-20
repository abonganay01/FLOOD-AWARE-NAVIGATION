# Flood Safe Website (MapLibre + OSRM)

This demo site uses MapLibre GL JS for map rendering and the public OSRM demo server for routing.
No API keys are required.

## Run locally

Option 1 (recommended): npm (uses npx http-server)
- Install Node.js
- From project root:
  npm install
  npm start
- Open http://localhost:5500/

Option 2: Python simple server
- cd src
- python -m http.server 5500
- Open http://localhost:5500/

Notes:
- OSRM demo server is public and rate-limited. For production, self-host OSRM.
- NOAH GeoJSON endpoint is attempted for overlays; if unavailable the map continues to function.

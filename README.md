# Sky Sector Planner

A web app for Starlink installers in the UK, laid out like a map app. Enter a postcode or address before a visit to:

- locate the property, and see how accurate that location is
- see the **likely sky sector** the terminal will face, drawn as a fan on the map and on a compass
- load mapped buildings and trees and see which fall in the northern sky
- add candidate mounting positions
- get a pre-visit assessment: *Planning estimate*, *Needs on-site verification* or *Insufficient data*
- save the job with notes, on-site findings and photos, and export a report

It is a planning aid. It does **not** replace the official Starlink app's obstruction check or alignment, and it never labels a property "suitable". It is not affiliated with Starlink or SpaceX.

## Run it

No build step and no dependencies. You need Node 20+ only for the dev server and tests.

```bash
npm start            # http://localhost:8080 (also prints a LAN address)
```

Opening `index.html` directly from disk will not work. The map tile servers require the page to be served over HTTP(S).

### On your phone

GPS ("Me"), the live compass and offline caching all need **HTTPS**. Host the folder on any static host:

- **GitHub Pages**: push this folder to a repo, then Settings → Pages → deploy from branch.
- **Netlify / Cloudflare Pages**: drag and drop the folder, or connect the repo. No build command; the publish directory is the repo root.

Then open the URL on the phone and choose **Add to Home Screen** (iOS Safari: Share → Add to Home Screen; Android Chrome: menu → Install app). It runs full-screen like an app.

## Using it

1. Type a postcode (any case or spacing) and, optionally, a house number or name. Tap search.
2. Pick the property. Results are labelled **Address point** or **Postcode centre (approximate)**.
3. If it is a postcode centre, tap **Place roof** and tap the customer's roof. The **Satellite** view helps here.
4. Read the **Sky sector** tab: the sector, confidence, geostationary-arc elevation and how the estimate was made.
5. Tap **Buildings & trees** to load OpenStreetMap features. Those in the northern bands are measured: distance, bearing, and the angle above an assumed mount height.
6. Tap **Add mount** to place candidate positions (M1, M2…), then label them in the **Assessment** tab.
7. Enter a job reference and **Save job**. After the visit, open the job and record the bearing and tilt the Starlink app showed. These recordings refine estimates for future jobs nearby.

## Tests

```bash
npm test             # 60 unit tests, Node's built-in runner, no network
npm run test:e2e     # end-to-end in headless Chromium with every external service mocked
```

The unit tests cover postcode validation, geocoding errors (not found, offline, rate limits, bad responses, ambiguity, other-postcode matches), coordinates, bearing normalisation and wrap-around, sector geometry, geostationary-arc maths, uncertainty and insufficient-data states, obstruction classification, assessment rules, and saving, loading, import and export of jobs.

The e2e test (`tests/e2e/run.mjs`) needs Playwright with Chromium. It runs the whole workflow (search, select, sector, features, mount, save, reload, edit, pin placement, offline search, phone layout) and fails on any console error. Screenshots go to `tests/e2e/screenshots/`.

## Data providers and terms

No API keys are needed for the defaults. Never commit keys; custom tile keys entered in Settings stay in that browser only.

| Purpose | Provider | Terms to respect |
|---|---|---|
| Postcode → centroid | [postcodes.io](https://postcodes.io) (ONS / OS open data) | Free. Contains OS and Royal Mail data © Crown copyright. Centroids only. |
| Address search | [Nominatim](https://nominatim.org) (OpenStreetMap) | [Usage policy](https://operations.osmfoundation.org/policies/nominatim/): at most 1 request/second (the app enforces this), no autocomplete, no bulk use. UK house coverage is incomplete. |
| Buildings and trees | [Overpass API](https://overpass-api.de) | Fair use; heavy users should run their own instance (set its URL in Settings). |
| Map tiles | OpenStreetMap | [Tile policy](https://operations.osmfoundation.org/policies/tiles/): light use only. For a team, use a commercial provider through **Settings → Custom tile URL**. |
| Satellite | Esri World Imagery | Attribution required. Commercial use needs an ArcGIS account. Check before rolling out to a company. |

**For precise UK addresses**, Ordnance Survey **OS Places API** (AddressBase, building-level points with UPRNs) is the authoritative source. It needs a key and is paid above the free tier. The geocoding interface in `js/geocoding.js` is designed for a new provider like this, but a key should be held by a small backend proxy, not shipped in the page.

## How the direction estimate works

In short, UK terminals face the northern sky, away from the geostationary arc. The exact bearing is set by the terminal and the official app, and no public dataset provides it. So the app shows a ±25° alignment band and a ±60° clearance band around true north, with its confidence and the evidence behind it. See **[docs/DIRECTION_MODEL.md](docs/DIRECTION_MODEL.md)**.

## Project layout

```
index.html, css/app.css      UI (map, panel/bottom sheet, tabs)
js/app.js                    controller: map drawing, rendering, events
js/direction.js              direction-estimation service (isolated, documented)
js/geo.js                    bearings, distances, sector polygons, GEO arc maths
js/postcode.js               UK postcode validation
js/geocoding.js              provider interface: postcodes.io, Nominatim
js/obstructions.js           Overpass fetch and feature analysis
js/assessment.js             pre-visit status rules
js/store.js                  job repository (localStorage) and settings
js/photos.js                 photos in IndexedDB (downscaled)
js/report.js                 text report
sw.js, manifest.webmanifest  offline shell and installable app
vendor/leaflet               Leaflet 1.9.4 (BSD-2), bundled
```

## Data and privacy

- Jobs are stored only in the browser on that device (localStorage; photos in IndexedDB). Use **Jobs → Export** for backups and moving to another device.
- Records hold a job reference, not customer names or phone numbers.
- Each record has `ownerId`, `syncState`, `revision` and `schemaVersion`, so cloud sync and multiple installer accounts can be added later without migrating data.
- Searches are sent to postcodes.io and Nominatim, and feature lookups to Overpass. Nothing else leaves the device.

## Limitations

- **Live services were not called during development.** The build environment blocked outbound access to postcodes.io, Nominatim, Overpass and the tile servers. All tests use recorded-format mock responses. Check a few real postcodes after deploying.
- **Physical-device testing is still needed**: GPS, the live compass (iOS asks for permission; Android needs `deviceorientationabsolute`), camera capture and add-to-home-screen.
- The compass shows a magnetic heading corrected by the declination you enter. UK declination is close to 0°; check the [BGS calculator](https://geomag.bgs.ac.uk/data_service/models_compass/wmm_calc.html).
- Map data rarely includes trees, hedges, chimneys or building heights. An empty band does not mean a clear view.
- Only the UK is covered. Elsewhere the app returns *Insufficient data*.
- The sector width is based on public evidence and reports, not a measured error bound. Recording on-site bearings is the way to tighten it.

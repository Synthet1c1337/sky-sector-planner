// End-to-end browser test with every external service mocked (tiles, postcodes.io,
// Nominatim, Overpass, fonts). Run: npm run test:e2e   (needs Playwright + Chromium)
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { destinationPoint } from '../../js/geo.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const root = new URL('../..', import.meta.url).pathname;
const shots = new URL('./screenshots/', import.meta.url).pathname;
await mkdir(shots, { recursive: true });

const PORT = 8765;
const server = spawn(process.execPath, [`${root}scripts/serve.mjs`, String(PORT)], { stdio: 'pipe' });
await new Promise((r) => server.stdout.once('data', r));
const BASE = `http://localhost:${PORT}/`;

// 1x1 PNG in a neutral map colour, stretched by Leaflet to each tile.
const TILE = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP48eMHAAWWAsoQo4jUAAAAAElFTkSuQmCC', 'base64');
const P = { lat: 52.41543, lon: -4.08291 };
const HOUSE = { lat: 52.41570, lon: -4.08250 };
const sq = (c, s) => { const g = (db, dn) => { const a = destinationPoint(c.lat, c.lon, 0, dn); return destinationPoint(a.lat, a.lon, 90, db); };
  const pts = [g(-s, -s), g(s, -s), g(s, s), g(-s, s)]; return [...pts, pts[0]]; };
const OVERPASS = { elements: [
  { type: 'way', id: 1, tags: { building: 'house', 'building:levels': '2' }, geometry: sq(HOUSE, 5) },
  { type: 'way', id: 2, tags: { building: 'apartments', name: 'Example House', height: '16' }, geometry: sq(destinationPoint(HOUSE.lat, HOUSE.lon, 8, 22), 6) },
  { type: 'way', id: 3, tags: { building: 'house' }, geometry: sq(destinationPoint(HOUSE.lat, HOUSE.lon, 300, 26), 5) },
  { type: 'way', id: 4, tags: { building: 'garage' }, geometry: sq(destinationPoint(HOUSE.lat, HOUSE.lon, 170, 18), 3) },
  { type: 'node', id: 5, ...destinationPoint(HOUSE.lat, HOUSE.lon, 40, 15), tags: { natural: 'tree' } },
  { type: 'node', id: 6, ...destinationPoint(HOUSE.lat, HOUSE.lon, 200, 20), tags: { natural: 'tree' } },
] };

let offline = false;
let overpassDown = false;
async function mockRoutes(context) {
  await context.route(/fonts\.(googleapis|gstatic)\.com/, (r) => r.abort());
  await context.route(/tile\.openstreetmap\.org|arcgisonline\.com/, (r) => offline ? r.abort() : r.fulfill({ body: TILE, contentType: 'image/png' }));
  await context.route(/api\.postcodes\.io/, (r) => {
    if (offline) return r.abort('internetdisconnected');
    const u = r.request().url();
    if (/SY231DE$/.test(u)) return r.fulfill({ json: { status: 200, result: { postcode: 'SY23 1DE', latitude: P.lat, longitude: P.lon, admin_district: 'Ceredigion' } } });
    return r.fulfill({ status: 404, json: { status: 404, error: 'Postcode not found' } });
  });
  await context.route(/nominatim\.openstreetmap\.org/, (r) => offline ? r.abort() : r.fulfill({ json: [
    { lat: String(HOUSE.lat), lon: String(HOUSE.lon), display_name: '14, Example Street, Aberystwyth, SY23 1DE, United Kingdom', category: 'place', type: 'house', addresstype: 'place', address: { house_number: '14', postcode: 'SY23 1DE' } },
  ] }));
  await context.route(/overpass-api\.de|overpass\.private\.coffee/, (r) => overpassDown ? r.fulfill({ status: 503, body: 'busy' }) : r.fulfill({ json: OVERPASS }));
}

const errors = [];
const browser = await chromium.launch();
const results = [];
const step = async (name, fn) => { try { await fn(); results.push(`PASS ${name}`); } catch (e) { results.push(`FAIL ${name}: ${e.message}`); } };

try {
  const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, deviceScaleFactor: 1 });
  await mockRoutes(context);
  const page = await context.newPage();
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|ERR_INTERNET_DISCONNECTED/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(BASE);

  await step('empty state renders', async () => {
    await page.getByText('Find a property to begin').waitFor();
  });

  await step('invalid postcode is rejected before any request', async () => {
    await page.fill('#q', 'SW1A 1C');
    await page.click('#search-btn');
    await page.locator('#search-msg.is-error').waitFor();
  });

  await step('unknown postcode shows not-found', async () => {
    await page.fill('#q', 'SW1A 9ZZ');
    await page.click('#search-btn');
    await page.getByText(/was not found/).waitFor();
  });

  await step('postcode + house number lists address and centroid', async () => {
    await page.fill('#q', 'sy231de');
    await page.fill('#house', '14');
    await page.click('#search-btn');
    await page.locator('.result').nth(1).waitFor();
    assert.equal(await page.locator('.result').count(), 2);
    assert.equal(await page.inputValue('#q'), 'SY23 1DE');
    await page.screenshot({ path: `${shots}01-results.png` });
    await page.locator('.result').first().click();
  });

  await step('sector, coordinates and accuracy are shown', async () => {
    await page.locator('#location-card').getByText('52.415700, -4.082500').waitFor();
    await page.locator('.readout .big').getByText(/335°.*025°/).waitFor();
    await page.getByText('Low · exact bearing').waitFor();
    assert.ok(await page.locator('path.leaflet-interactive, .leaflet-overlay-pane path').count() >= 2, 'sector polygons drawn');
  });

  await step('mapped buildings and trees are analysed', async () => {
    await page.click('#btn-features');
    await page.getByText(/mapped features nearby/).waitFor();
    await page.click('#tab-assess');
    await page.getByText(/Example House/).first().waitFor();
    await page.locator('.status-banner strong').getByText('Needs on-site verification').waitFor();
  });

  await step('a failed feature lookup is reported next to the map, not only on the Assessment tab', async () => {
    overpassDown = true;
    await page.click('#tab-sector');
    await page.click('#btn-features');
    await page.locator('#toast').getByText(/Buildings & trees: The map-feature service is busy/).waitFor();
    await page.click('#tab-assess');
    await page.getByRole('button', { name: 'Try again' }).waitFor();
    overpassDown = false;
    await page.click('#retry-features');
    await page.getByText(/Example House/).first().waitFor();
  });

  await step('candidate mount can be added', async () => {
    await page.click('#mode-mount');
    const box = await page.locator('#map').boundingBox();
    await page.mouse.click(box.x + box.width / 2 + 30, box.y + box.height / 2 - 20);
    await page.locator('.pin-mount').first().waitFor();
    await page.fill('[data-mount]', 'Gable end, east');
  });

  await step('job saves locally', async () => {
    await page.fill('#job-ref', 'JOB-E2E-1');
    await page.click('#save-job');
    await page.getByText('Job saved on this device').waitFor();
    assert.equal(await page.textContent('#jobs-count'), '1');
    await page.screenshot({ path: `${shots}02-assessment.png` });
    await page.click('#tab-sector');
    await page.screenshot({ path: `${shots}03-sector-desktop.png` });
  });

  await step('job persists after reload and records on-site findings', async () => {
    await page.reload();
    await page.click('#tab-jobs');
    await page.getByText('JOB-E2E-1').click();
    await page.fill('#jf-bearing', '352');
    await page.fill('#jf-notes', 'Ladder access from rear garden');
    await page.selectOption('#jf-status', 'installed');
    await page.click('#job-form button[type=submit]');
    await page.getByText('Job saved').first().waitFor();
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('slp.jobs.v1')));
    assert.equal(stored[0].onSite.observedBearing, 352);
    assert.equal(stored[0].mountingPositions[0].label, 'Gable end, east');
    assert.equal(stored[0].direction.alignment.from, 335);
    await page.screenshot({ path: `${shots}04-job-detail.png` });
  });

  await step('installer pin placement upgrades accuracy', async () => {
    await page.click('#job-show');
    await page.click('#mode-place');
    const box = await page.locator('#map').boundingBox();
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.locator('#location-card').getByText('Placed on the roof by you').waitFor();
  });

  await step('offline search fails gracefully', async () => {
    offline = true;
    await page.fill('#q', 'SY23 1DE');
    await page.fill('#house', '');
    await page.click('#search-btn');
    await page.getByText(/Check your connection/).waitFor();
    offline = false;
  });

  await step('phone layout renders the bottom sheet', async () => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await mockRoutes(phone);
    const m = await phone.newPage();
    m.on('pageerror', (e) => errors.push(`phone: ${e.message}`));
    await m.goto(BASE);
    await m.fill('#q', 'SY23 1DE');
    await m.fill('#house', '14');
    await m.click('#search-btn');
    await m.locator('.result').first().click();
    await m.locator('.readout .big').waitFor();
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    assert.equal(overflow, false, 'no horizontal scroll');
    await m.screenshot({ path: `${shots}05-phone.png` });
    await m.click('#sheet-handle');
    await m.waitForTimeout(400);
    await m.screenshot({ path: `${shots}06-phone-expanded.png` });
    await phone.close();
  });

  await step('no console or page errors', async () => { assert.deepEqual(errors, []); });
} finally {
  await browser.close();
  server.kill();
}
console.log(results.join('\n'));
console.log(`Screenshots: ${shots}`);
if (results.some((r) => r.startsWith('FAIL'))) process.exit(1);

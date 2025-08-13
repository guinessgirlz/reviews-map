/* GuinnessGirlz Reviews Map
   - Fetches published CSV (headers: Name, City, Country, Score, Instagram Link[, Lat, Lon])
   - Geocodes City/Country via Nominatim if Lat/Lon not provided
   - Caches geocodes in localStorage (key gg_geocode_cache_v1)
   - Throttles geocoding (~3/sec)
   - Renders Leaflet markers with custom pint icon and branded UI
*/

// Replace this with your published Google Sheets CSV URL.  If left as-is,
// the script will fall back to loading ./data/reviews.csv included in the repo.
const CSV_URL = "PASTE_CSV_URL_HERE";

const GEOCODE_CACHE_KEY = "gg_geocode_cache_v1";
const RATE_DELAY_MS = 350; // ~3 requests/second

// Load geocode cache from localStorage
const geocodeCache = (() => {
  try {
    return JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY) || "{}");
  } catch {
    return {};
  }
})();
function saveCache() {
  try {
    localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(geocodeCache));
  } catch {}
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function geocodeOnce(city, country) {
  const key = `${(city || '').trim().toLowerCase()},${(country || '').trim().toLowerCase()}`;
  if (geocodeCache[key]) return geocodeCache[key];
  await sleep(RATE_DELAY_MS);
  const query = [city, country].filter(Boolean).join(', ');
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(query)}`;
  const resp = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!resp.ok) throw new Error(`Geocode failed: ${resp.status}`);
  const data = await resp.json();
  if (!Array.isArray(data) || data.length === 0) throw new Error('No results');
  const { lat, lon } = data[0];
  const result = { lat: parseFloat(lat), lon: parseFloat(lon) };
  geocodeCache[key] = result;
  saveCache();
  return result;
}

// Normalise CSV row keys (case-insensitive, trimmed) and support alternative column names.
function normaliseRow(row) {
  const m = {};
  for (const k in row) if (Object.hasOwn(row, k)) m[k.trim().toLowerCase()] = row[k];
  let name = m['name'] || '';
  let city = m['city'] || '';
  let country = m['country'] || '';
  const score = m['score'] || m['score (out of 5)'] || '';
  const insta = m['instagram link'] || m['instagram'] || '';
  let lat = m['lat'] || m['latitude'] || '';
  let lon = m['lon'] || m['lng'] || m['longitude'] || '';
  // Support combined "Name, Location" or "Location" fields
  const nameLoc = m['name, location'] || m['name,location'];
  const location = m['location'] || m['city, country'];
  if (!name && nameLoc) {
    const parts = String(nameLoc).split(',');
    if (parts.length >= 2) {
      name = parts[0].trim();
      const loc = parts.slice(1).join(',').trim();
      if (!city && !country) {
        const locParts = loc.split(',');
        if (locParts.length >= 2) {
          country = locParts.pop().trim();
          city = locParts.join(',').trim();
        } else {
          city = loc;
        }
      }
    } else {
      name = String(nameLoc).trim();
    }
  }
  if (location && !city && !country) {
    const loc = String(location).trim();
    const parts = loc.split(',');
    if (parts.length >= 2) {
      country = parts.pop().trim();
      city = parts.join(',').trim();
    } else {
      city = loc;
    }
  }
  return { name, city, country, score, insta, lat, lon };
}

function csvToRows(csvText) {
  const parsed = Papa.parse(csvText, { header: true, skipEmptyLines: true });
  return parsed.data.map(normaliseRow).filter((r) => r.name && (r.city || (r.lat && r.lon)));
}

async function getLatLon(row) {
  if (row.lat && row.lon) {
    const lat = parseFloat(row.lat);
    const lon = parseFloat(row.lon);
    if (!Number.isNaN(lat) && !Number.isNaN(lon)) return { lat, lon };
  }
  return geocodeOnce(row.city, row.country);
}

function popupHTML(row) {
  const esc = (s) => String(s || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const score = row.score ? `${esc(row.score)} / 5` : '—';
  const link = row.insta
    ? `<a class="gg-btn" href="${esc(row.insta)}" target="_blank" rel="noopener">Open on Instagram</a>`
    : '';
  return `<div><div style="font-weight:700;margin-bottom:4px">${esc(row.name)}</div><div style="margin:2px 0">${esc(row.city)}${row.city && row.country ? ', ' : ''}${esc(row.country)}</div><div style="margin:6px 0">Score: <strong>${score}</strong></div>${link}</div>`;
}

async function main() {
  // Initialise map with base view over Ireland/UK
  const map = L.map('map', { zoomControl: true, scrollWheelZoom: true }).setView([53.5, -6], 5);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 19,
  }).addTo(map);
  // Logo control
  const LogoCtl = L.Control.extend({
    options: { position: 'topleft' },
    onAdd: function () {
      const div = L.DomUtil.create('div', 'leaflet-control gg-logo-ctl');
      const img = document.createElement('img');
      img.src = 'assets/logo.png';
      img.alt = 'GuinnessGirlz';
      img.className = 'gg-logo';
      div.appendChild(img);
      return div;
    },
  });
  map.addControl(new LogoCtl());
  // Optional search control
  if (L.Control.Geocoder) {
    L.Control.geocoder({ defaultMarkGeocode: false })
      .on('markgeocode', function (e) {
        const b = e.geocode.bbox;
        const bounds = L.latLngBounds(b._southWest, b._northEast);
        map.fitBounds(bounds);
      })
      .addTo(map);
  }
  // Custom marker icon
  const icon = L.icon({
    iconUrl: 'assets/pint.svg',
    iconSize: [36, 48],
    iconAnchor: [18, 48],
    popupAnchor: [0, -44],
  });
  // Load CSV
  let csvText = '';
  try {
    const url = CSV_URL && !CSV_URL.includes('PASTE_CSV_URL_HERE') ? CSV_URL : 'data/reviews.csv';
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`CSV fetch failed: ${r.status}`);
    csvText = await r.text();
  } catch (err) {
    console.error(err);
    alert('Could not load CSV. Check your CSV_URL or ensure data/reviews.csv exists.');
    return;
  }
  const rows = csvToRows(csvText);
  const markers = [];
  for (const row of rows) {
    try {
      const { lat, lon } = await getLatLon(row);
      const m = L.marker([lat, lon], { icon }).bindPopup(popupHTML(row));
      m.addTo(map);
      markers.push(m);
    } catch (err) {
      console.warn('Skipping row (no geocode):', row, err);
    }
  }
  if (markers.length) {
    const group = L.featureGroup(markers);
    map.fitBounds(group.getBounds().pad(0.2));
  }
}
main();
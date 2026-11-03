const scenarios = {
  success: { name: 'Safe delivery', temp: 5.2, location: true },
  breach: { name: 'Temperature excursion', temp: 10.4, location: true },
  overcap: { name: 'Over spend cap', temp: 5.2, amount: 12000, location: true },
};
const $ = (id) => document.getElementById(id);
const timeline = $('timeline');
const points = {
  pickup: { label: 'Pasig cold store', lat: 14.576, lon: 121.085 },
  delivery: { label: 'Philippine General Hospital, Ermita', lat: 14.5796, lon: 120.9882 },
};
const markers = {};
let activePoint = 'pickup';
let map;
let routeLine;
let lastSearchAt = 0;
let selectedScenario = 'success';

function shortPlaceName(name) {
  return name.split(',').slice(0, 2).join(',').trim();
}

function formatPHP(amount) {
  return new Intl.NumberFormat('en-PH', {
    style: 'currency',
    currency: 'PHP',
    maximumFractionDigits: 0,
  }).format(amount);
}

function compactPlaceName(name) {
  return name.split(',')[0].trim();
}

function routeDistanceKm(a, b) {
  const radians = (degrees) => degrees * Math.PI / 180;
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const lat1 = radians(a.lat);
  const lat2 = radians(b.lat);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function paymentAmount(scenario) {
  if (scenario.amount !== undefined) return scenario.amount;
  const km = routeDistanceKm(points.pickup, points.delivery);
  return Math.max(100, Math.round((80 + km * 10) / 10) * 10);
}

function updateRouteLabels() {
  $('pickup-label').textContent = points.pickup.label;
  $('delivery-label').textContent = points.delivery.label;
  $('recipient-label').textContent = points.delivery.label;
  $('dialog-recipient').textContent = points.delivery.label;
  $('geofence-label').textContent = `${points.delivery.label} · selected point`;
  $('policy-geofence-label').textContent = `${points.delivery.label} · selected point`;
  $('origin-summary').textContent = compactPlaceName(points.pickup.label);
  $('destination-summary').textContent = compactPlaceName(points.delivery.label);
  const km = routeDistanceKm(points.pickup, points.delivery);
  $('route-distance').textContent = `${km.toFixed(1)} km straight-line`;
  showScenario(selectedScenario);
}

function markerIcon(which) {
  const letter = which === 'pickup' ? 'P' : 'D';
  const kind = which === 'pickup' ? 'pickup' : 'delivery';
  return L.divIcon({
    className: 'aeropay-marker',
    html: `<span class="route-pin ${kind}">${letter}</span>`,
    iconSize: [26, 26],
    iconAnchor: [13, 13],
  });
}

function redrawRoute(fit = false) {
  updateRouteLabels();
  if (!map) return;
  for (const which of ['pickup', 'delivery']) {
    const point = points[which];
    const latlng = [point.lat, point.lon];
    const label = `${which === 'pickup' ? 'Pickup' : 'Delivery'} · ${point.label}`;
    if (!markers[which]) markers[which] = L.marker(latlng, { icon: markerIcon(which), keyboard: true }).addTo(map);
    else markers[which].setLatLng(latlng);
    markers[which].setIcon(markerIcon(which));
    markers[which].bindTooltip(label, { direction: 'top', offset: [0, -12] });
  }
  const locations = [
    [points.pickup.lat, points.pickup.lon],
    [points.delivery.lat, points.delivery.lon],
  ];
  if (routeLine) routeLine.setLatLngs(locations);
  else routeLine = L.polyline(locations, { color: '#668b4d', weight: 3, dashArray: '7 7', opacity: .9 }).addTo(map);
  if (fit) map.fitBounds(L.latLngBounds(locations), { padding: [38, 38], maxZoom: 14 });
}

function setLocation(which, label, lat, lon) {
  points[which] = { label: shortPlaceName(label), lat: Number(lat), lon: Number(lon) };
  redrawRoute(true);
  $('map-status').classList.remove('error');
  $('map-status').textContent = `${which === 'pickup' ? 'Pickup' : 'Delivery'} set to ${points[which].label}. Choose the other point to continue.`;
  $('place-results').replaceChildren();
}

function setActivePoint(which) {
  activePoint = which;
  document.querySelectorAll('.point-button').forEach((button) => {
    const selected = button.dataset.point === which;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  $('map-status').classList.remove('error');
  $('map-status').textContent = `Choose ${which} by searching for a place or clicking the map.`;
}

function initializeMap() {
  if (!globalThis.L) {
    $('map-loading').textContent = 'Could not load the map. Check your internet connection and refresh.';
    $('map-status').classList.add('error');
    $('map-status').textContent = 'The interactive map library did not load.';
    return;
  }
  map = L.map('route-map', { scrollWheelZoom: false }).setView([14.59, 121.035], 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>',
  }).addTo(map);
  map.on('click', (event) => {
    setLocation(activePoint, `Pinned · ${event.latlng.lat.toFixed(4)}, ${event.latlng.lng.toFixed(4)}`, event.latlng.lat, event.latlng.lng);
  });
  map.whenReady(() => {
    $('map-loading').hidden = true;
    redrawRoute(true);
  });
}

async function searchPlace(event) {
  event.preventDefault();
  const query = $('place-query').value.trim();
  if (!query) return;
  const button = $('place-search-button');
  const status = $('map-status');
  const results = $('place-results');
  button.disabled = true;
  button.textContent = 'Searching…';
  status.classList.remove('error');
  status.textContent = 'Searching for matching places…';
  results.replaceChildren();

  try {
    // Nominatim's public endpoint is intentionally called only after a user submits.
    // It does not support autocomplete; keep this app below one request per second.
    const delay = Math.max(0, 1100 - (Date.now() - lastSearchAt));
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    lastSearchAt = Date.now();
    const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: '5' });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error(`Place search returned ${response.status}. Try again shortly.`);
    const matches = await response.json();
    if (!matches.length) {
      status.textContent = 'No matching places found. Try a nearby city or landmark.';
      return;
    }
    status.textContent = `Choose a result to set the ${activePoint}.`;
    for (const match of matches) {
      const result = document.createElement('button');
      result.type = 'button';
      result.className = 'place-result';
      result.textContent = match.display_name;
      result.addEventListener('click', () => setLocation(activePoint, match.display_name, match.lat, match.lon));
      results.append(result);
    }
  } catch (error) {
    status.classList.add('error');
    status.textContent = `${error.message} You can still click a point on the map.`;
  } finally {
    button.disabled = false;
    button.textContent = 'Search';
  }
}

function setCheck(id, passing) {
  const mark = $(`check-${id}`);
  const result = $(`result-${id}`);
  mark.className = `check-mark ${passing ? 'good' : 'bad'}`;
  mark.textContent = passing ? '✓' : '!';
  result.className = `check-result ${passing ? 'good' : 'bad'}`;
  result.textContent = passing ? 'PASS' : 'FAIL';
}

function showScenario(key) {
  selectedScenario = key;
  const scenario = scenarios[key];
  const amount = paymentAmount(scenario);
  const tempOk = scenario.temp >= 2 && scenario.temp <= 8;
  const capOk = amount <= 10000;
  const allowed = tempOk && capOk && scenario.location;
  $('temperature').innerHTML = `${scenario.temp.toFixed(1)}<span>°C</span>`;
  $('temp-bar').style.width = `${Math.min(100, Math.max(8, scenario.temp * 9))}%`;
  $('temp-bar').style.background = tempOk ? 'var(--green)' : 'var(--red)';
  $('check-temp-detail').textContent = tempOk ? `${scenario.temp.toFixed(1)}°C within range` : `${scenario.temp.toFixed(1)}°C outside 2°–8°C`;
  $('amount-line').textContent = formatPHP(amount);
  $('payout-amount').textContent = formatPHP(amount);
  $('device-status').textContent = key === 'breach' ? 'Cold-chain alert' : key === 'overcap' ? 'Payment needs review' : 'Evidence received';
  setCheck('temp', tempOk);
  setCheck('cap', capOk);

  const box = $('decision-box');
  box.className = `decision-box ${allowed ? 'allow' : 'deny'}`;
  $('decision-icon').textContent = allowed ? '✓' : '!';
  $('decision-title').textContent = allowed ? 'Conditions satisfied' : 'Payment blocked';
  $('decision-copy').textContent = allowed
    ? 'The request fits the example policy. Review it before authorization.'
    : !tempOk ? 'Temperature exceeded the safe range. Escrow remains locked.' : 'This request exceeds the agent’s per-payment cap.';
  $('decision-state').textContent = allowed ? 'ALLOW' : 'DENY';
  $('settle-button').disabled = !allowed;
  $('settle-label').textContent = allowed ? 'Review authorization' : 'Escrow stays locked';
  $('button-note').textContent = allowed ? 'Demo only · no blockchain transaction will be sent.' : 'Denied by policy · no payment submitted.';
  timeline.innerHTML = `
    <div class="event"><span class="event-icon">01</span><div><b>Reading received</b><small>Cold-chain tag · ${scenario.temp.toFixed(1)}°C · sample data</small></div><span class="event-state">${tempOk ? 'IN RANGE' : 'BREACH'}</span></div>
    <div class="event"><span class="event-icon">02</span><div><b>Destination reached</b><small>${points.delivery.label} · sample location</small></div><span class="event-state">REACHED</span></div>
    <div class="event"><span class="event-icon">03</span><div><b>Policy checked</b><small>${capOk ? `${formatPHP(amount)} is within the ₱10,000 cap` : `${formatPHP(amount)} exceeds the ₱10,000 cap`}</small></div><span class="event-state">${allowed ? 'ALLOW' : 'DENY'}</span></div>
    <div class="event last"><span class="event-icon">04</span><div><b>${allowed ? 'Authorization preview' : 'Escrow remains locked'}</b><small>${allowed ? 'Simulation only · no transaction submitted' : 'The request failed the example policy'}</small></div><span class="event-state ${allowed ? 'pending' : ''}">${allowed ? 'PREVIEW' : 'BLOCKED'}</span></div>`;
  $('trail-count').textContent = '4 steps';
  document.querySelectorAll('.scenario-btn').forEach((button) => {
    const selected = button.dataset.scenario === key;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}

document.querySelectorAll('.point-button').forEach((button) => {
  button.addEventListener('click', () => setActivePoint(button.dataset.point));
});
$('place-search-form').addEventListener('submit', searchPlace);
document.querySelectorAll('.scenario-btn').forEach((button) => {
  button.addEventListener('click', () => showScenario(button.dataset.scenario));
});
$('settle-button').addEventListener('click', () => {
  if ($('settle-button').disabled) return;
  $('dialog-amount').textContent = formatPHP(paymentAmount(scenarios[selectedScenario]));
  $('payment-dialog').showModal();
});
updateRouteLabels();
initializeMap();

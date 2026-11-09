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
let apiServices = null;
let veloPollTimer = null;

function shortHash(hash) {
  return hash.length > 14 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}

document.addEventListener('keydown', (event) => {
  if ((event.key === 'Enter' || event.key === ' ') && event.target.matches('[data-copy]')) {
    event.preventDefault();
    event.target.click();
  }
});

document.addEventListener('click', async (event) => {
  const chip = event.target.closest('[data-copy]');
  if (!chip) return;
  try {
    await navigator.clipboard.writeText(chip.dataset.copy);
    chip.classList.add('copied');
    setTimeout(() => chip.classList.remove('copied'), 1200);
  } catch { /* clipboard unavailable: hash stays selectable */ }
});

function currentShipmentId() {
  let id = sessionStorage.getItem('aeropay.shipmentId');
  if (!id) {
    id = `shp_${crypto.randomUUID()}`;
    sessionStorage.setItem('aeropay.shipmentId', id);
  }
  return id;
}

const STEP_LABELS = { done: 'Done', active: 'Active', waiting: 'Waiting', blocked: 'Blocked', pending: 'Pending' };
const stepState = { booking: 'active', velo: 'waiting', agent: 'waiting', noir: 'waiting', claim: 'waiting' };
const stepNotes = { booking: 'Waiting for booking', velo: 'Waiting for ledger confirmation', agent: 'Ready for the agent', noir: 'Noir payout in progress', claim: 'Payout authorized. Merchant can claim.', blocked: 'Payout blocked. Escrow stays locked.' };

function setSteps(next, note) {
  Object.assign(stepState, next);
  document.querySelectorAll('#stepper li').forEach((li) => {
    const state = stepState[li.dataset.step] || 'waiting';
    li.classList.remove('done', 'active', 'blocked', 'pending');
    if (state !== 'waiting') li.classList.add(state);
    li.querySelector('.step-state').textContent = STEP_LABELS[state];
    if (state === 'active') li.setAttribute('aria-current', 'step'); else li.removeAttribute('aria-current');
  });
  const noteEl = document.getElementById('stepper-note');
  if (noteEl && note) noteEl.textContent = note;
}

function setVeloStatus(message, tone = '') {
  if (tone === 'good') setSteps({ booking: 'done', velo: 'done', agent: stepState.agent === 'waiting' ? 'active' : stepState.agent }, stepNotes.agent);
  else if (tone === 'wait') setSteps({ booking: 'done', velo: 'active' }, stepNotes.velo);
  else if (tone === 'bad') setSteps({ velo: stepState.velo === 'done' ? 'done' : 'waiting' }, message);
  const note = $('velo-status');
  const pill = $('velo-pill');
  note.textContent = message;
  pill.className = `live-pill ${tone}`.trim();
  pill.textContent = tone === 'good' ? 'CONFIRMED' : tone === 'wait' ? 'PENDING' : tone === 'bad' ? 'ACTION NEEDED' : 'TESTNET';
}

async function loadServiceStatus() {
  try {
    const response = await fetch('/api/health');
    if (!response.ok) throw new Error('API unavailable');
    apiServices = await response.json();
    $('service-status').innerHTML = `<span class="status-dot"></span> ${apiServices.velo.configured ? 'Velo Testnet' : 'Server connected'}`;
    const checkoutButton = $('velo-checkout-button');
    const checkoutAmount = apiServices.velo.checkoutAmount;
    const checkoutAsset = apiServices.velo.checkoutAsset;
    checkoutButton.textContent = apiServices.velo.configured
      ? `Pay booking fee · ${checkoutAmount} ${checkoutAsset} on Testnet`
      : 'Velo Testnet key needed on server';
    checkoutButton.disabled = !apiServices.velo.configured;
    if (!apiServices.velo.configured) {
      setVeloStatus('Add VELO_API_KEY to the server .env file to enable Testnet checkout.', 'bad');
    } else {
      setVeloStatus('Booking fee is separate from the PHP route estimate and the Noir carrier payout.');
    }
    $('dialog-amount').textContent = apiServices.noir.configured
      ? `${apiServices.noir.payoutAmount} ${apiServices.noir.payoutAssetLabel} · Testnet`
      : 'Noir Testnet key not configured';
    if (!apiServices.noir.configured && apiServices.noir.missing?.length) {
      $('button-note').textContent = `Noir payout needs these server settings: ${apiServices.noir.missing.join(', ')}.`;
    }
    if (apiServices.noir.configured && apiServices.velo.configured) {
      $('service-status').classList.add('services-ready');
    }
  } catch {
    $('service-status').innerHTML = '<span class="status-dot"></span> Server unavailable';
    $('velo-checkout-button').disabled = true;
    setVeloStatus('Start the AeroPay full-stack server to connect Velo and Noir.', 'bad');
  }
}

function stepsForDecision(decision) {
  if (decision === 'authorized') return [{ booking: 'done', velo: 'done', agent: 'done', noir: 'done', claim: 'pending' }, stepNotes.claim];
  if (decision === 'approved') return [{ agent: 'done', noir: 'waiting', claim: 'waiting' }, 'Policy passed. No payment was sent.'];
  if (decision === 'denied') return [{ agent: 'done', noir: 'blocked', claim: 'waiting' }, stepNotes.blocked];
  if (decision === 'waiting_for_velo') return [{ velo: 'active', agent: 'waiting', noir: 'waiting', claim: 'waiting' }, stepNotes.velo];
  if (decision === 'unknown') return [{ agent: 'done', noir: 'blocked', claim: 'waiting' }, 'Check Stellar Testnet before retrying'];
  return [{ agent: 'blocked' }, 'The agent needs setup'];
}

function showAgentResult(result) {
  const [stepNext, stepNote] = stepsForDecision(result.decision);
  setSteps(stepNext, stepNote);
  const icon = $('agent-result-icon');
  const title = $('dialog-title');
  const copy = $('agent-result-copy');
  const link = $('agent-transaction-link');
  const labels = {
    authorized: ['Payment authorized', 'good', '✓'],
    approved: ['Policy passed · no payment sent', 'good', '✓'],
    denied: ['Payment refused', 'bad', '!'],
    waiting_for_velo: ['Waiting for Velo booking', 'wait', '…'],
    needs_setup: ['Testnet setup is incomplete', 'wait', '…'],
    unknown: ['Transaction status unknown', 'wait', '?'],
  };
  const [heading, tone, glyph] = labels[result.decision] || ['Agent decision', '', 'A'];
  icon.className = `dialog-check ${tone}`.trim();
  icon.textContent = glyph;
  title.textContent = heading;
  copy.textContent = result.reason || result.error || 'The server returned an agent decision.';
  $('dialog-booking-status').textContent = result.veloStatus || ($('velo-pill').textContent === 'CONFIRMED' ? 'Confirmed by Velo' : 'See booking status in panel');
  if (result.transactionHash) {
    link.href = `https://stellar.expert/explorer/testnet/tx/${encodeURIComponent(result.transactionHash)}`;
    link.hidden = false;
    link.textContent = `View Testnet transaction ${shortHash(result.transactionHash)} ↗`;
  } else {
    link.hidden = true;
    link.removeAttribute('href');
  }
  const lastEvent = document.querySelector('#timeline .event.last');
  if (lastEvent) {
    lastEvent.querySelector('b').textContent = result.decision === 'authorized'
      ? 'Noir authorized the payout'
      : result.decision === 'denied'
        ? 'Escrow remains locked'
        : result.decision === 'waiting_for_velo'
          ? 'Waiting for Velo confirmation'
          : result.decision === 'unknown'
            ? 'Check Testnet before retrying'
            : 'Agent decision recorded';
    const lastSmall = lastEvent.querySelector('small');
    if (result.transactionHash) {
      lastSmall.textContent = 'Stellar Testnet · ';
      const chip = document.createElement('code');
      chip.className = 'hash';
      chip.dataset.copy = result.transactionHash;
      chip.title = 'Click to copy full hash';
      chip.textContent = shortHash(result.transactionHash);
      lastSmall.append(chip);
    } else {
      lastSmall.textContent = result.reason || 'No transaction was submitted.';
    }
    const state = lastEvent.querySelector('.event-state');
    state.textContent = result.decision.toUpperCase().replaceAll('_', ' ');
    state.classList.toggle('pending', result.decision === 'waiting_for_velo' || result.decision === 'needs_setup');
    state.classList.toggle('bad', result.decision === 'denied');
  }
}

// ---- Autonomous agent: the tag signs a reading, the server verifies it, the agent acts.
let feedAfter = 0;
let feedTimer = null;
let claimTxShown = false;

function clockTime(iso) {
  return new Date(iso).toLocaleTimeString('en-GB', { hour12: false });
}

function addFeedItem(event) {
  const list = $('agent-feed');
  list.querySelector('.feed-empty')?.remove();
  const item = document.createElement('li');
  item.className = `feed-item ${event.type.split('.')[0]} ${event.type.replace('.', '-')}`;
  const time = document.createElement('time');
  time.dateTime = event.ts;
  time.textContent = clockTime(event.ts);
  const text = document.createElement('span');
  text.textContent = event.message;
  item.append(time, text);
  const hash = event.data?.transactionHash || event.data?.signature;
  if (hash) {
    const chip = document.createElement('code');
    chip.className = 'hash';
    chip.dataset.copy = hash;
    chip.tabIndex = 0;
    chip.setAttribute('role', 'button');
    chip.title = 'Click to copy';
    chip.textContent = shortHash(hash);
    item.append(chip);
  }
  list.append(item);
  list.scrollTop = list.scrollHeight;
  $('feed-count').textContent = `${list.querySelectorAll('.feed-item').length} events`;
}

function showClaimBox(show) {
  $('claim-box').hidden = !show;
}

async function loadPending() {
  const note = $('claim-note');
  const button = $('claim-button');
  try {
    const response = await fetch('/api/noir/pending');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    $('claim-pending').textContent = data.pending === null ? '—' : `${data.pending} ${data.label}`;
    button.disabled = !data.claimConfigured;
    note.textContent = data.claimConfigured
      ? 'The merchant collects the pending balance. This signs a second Testnet transaction.'
      : 'The merchant claims with its own wallet. From a terminal: npm run merchant:claim';
  } catch {
    $('claim-pending').textContent = '—';
    button.disabled = true;
    note.textContent = 'Could not read the pending balance right now.';
  }
}

function applyAgentEvent(event, { restore }) {
  const data = event.data || {};
  if (event.type === 'telemetry.accepted') {
    setSteps({ agent: 'active' }, 'The agent is checking the reading');
  } else if (event.type === 'agent.waiting') {
    setSteps({ agent: 'waiting', velo: stepState.velo === 'done' ? 'done' : 'active' }, 'Holding the payout until Velo confirms');
    if (!restore && $('payment-dialog').open) showAgentResult(data);
  } else if (event.type === 'velo.confirmed') {
    setSteps({ booking: 'done', velo: 'done' }, 'Velo confirmed. The agent is paying.');
  } else if (['agent.authorized', 'agent.denied', 'agent.unknown', 'agent.needs_setup'].includes(event.type)) {
    showAgentResult(data);
    if (!restore) {
      const dialog = $('payment-dialog');
      if (!dialog.open) dialog.showModal();
    }
    if (event.type === 'agent.authorized') { showClaimBox(true); loadPending(); }
  } else if (event.type === 'merchant.claimed') {
    claimTxShown = true;
    setSteps({ claim: 'done' }, 'The merchant claimed the pending balance.');
    showClaimBox(true);
    $('claim-button').disabled = true;
    $('claim-button').textContent = 'Claimed';
    $('claim-note').textContent = '';
    const holder = $('claim-note');
    holder.textContent = 'Claim transaction · ';
    const chip = document.createElement('code');
    chip.className = 'hash';
    chip.dataset.copy = data.transactionHash;
    chip.tabIndex = 0;
    chip.setAttribute('role', 'button');
    chip.textContent = shortHash(data.transactionHash);
    holder.append(chip);
  }
}

async function pollEvents({ restore = false } = {}) {
  const shipmentId = sessionStorage.getItem('aeropay.shipmentId');
  if (!shipmentId) return null;
  try {
    const response = await fetch(`/api/shipments/${encodeURIComponent(shipmentId)}/events?after=${feedAfter}`);
    if (!response.ok) return null;
    const data = await response.json();
    for (const event of data.events) {
      feedAfter = Math.max(feedAfter, event.id);
      addFeedItem(event);
      applyAgentEvent(event, { restore });
    }
    return data;
  } catch {
    return null;
  }
}

function startPolling() {
  if (feedTimer) return;
  let idle = 0;
  feedTimer = setInterval(async () => {
    const data = await pollEvents();
    idle += 1;
    const state = data?.run?.state;
    // Keep watching while the agent is waiting or working; stop shortly after a final decision.
    const finished = state && !['waiting', 'processing'].includes(state);
    if (finished || idle > 400) { clearInterval(feedTimer); feedTimer = null; }
  }, 1500);
}

async function startDelivery() {
  const scenario = scenarios[selectedScenario];
  const dialog = $('payment-dialog');
  $('agent-transaction-link').hidden = true;
  $('agent-result-icon').className = 'dialog-check wait';
  $('agent-result-icon').textContent = '…';
  $('dialog-title').textContent = 'The tag is sending a signed reading.';
  $('agent-result-copy').textContent = 'The server verifies the Ed25519 signature, then the agent decides on its own.';
  $('dialog-booking-status').textContent = $('velo-pill').textContent;
  if (!dialog.open) dialog.showModal();
  $('settle-button').disabled = true;
  try {
    const response = await fetch('/api/demo/device-reading', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        shipmentId: currentShipmentId(),
        scenario: selectedScenario,
        temperatureC: scenario.temp,
        checkpointMatched: scenario.location,
      }),
    });
    const result = await response.json();
    if (!response.ok) {
      if (result.settled) {
        $('agent-result-icon').className = 'dialog-check wait';
        $('agent-result-icon').textContent = '!';
        $('dialog-title').textContent = 'This shipment is already settled.';
        $('agent-result-copy').textContent = 'Each shipment is paid at most once. Choose New shipment to run another delivery.';
        return;
      }
      showAgentResult({
        decision: result.missing ? 'needs_setup' : 'unknown',
        reason: result.missing ? `The server is missing: ${result.missing.join(', ')}.` : (result.error || 'The reading was not accepted.'),
      });
      return;
    }
    await pollEvents();
    startPolling();
  } catch {
    showAgentResult({ decision: 'unknown', reason: 'Could not reach the AeroPay server. No result was confirmed.' });
  } finally {
    setTimeout(() => { $('settle-button').disabled = false; }, 1200);
  }
}

async function claimAsMerchant() {
  const shipmentId = sessionStorage.getItem('aeropay.shipmentId');
  const button = $('claim-button');
  button.disabled = true;
  $('claim-note').textContent = 'Signing the claim on Stellar Testnet…';
  try {
    const response = await fetch(`/api/shipments/${encodeURIComponent(shipmentId)}/claim`, { method: 'POST' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The claim did not complete.');
    await pollEvents();
  } catch (error) {
    $('claim-note').textContent = error.message;
    button.disabled = false;
  }
}

async function restoreShipment() {
  const data = await pollEvents({ restore: true });
  if (!data) return;
  const state = data.run?.state;
  if (state === 'waiting' || state === 'processing') startPolling();
  if (state === 'authorized') {
    const claimed = data.run.result?.claimTransactionHash;
    if (claimed && !claimTxShown) applyAgentEvent({ type: 'merchant.claimed', data: { transactionHash: claimed } }, { restore: true });
  }
}

async function checkVeloBooking({ poll = false } = {}) {
  const shipmentId = sessionStorage.getItem('aeropay.shipmentId');
  if (!shipmentId) return false;
  try {
    const response = await fetch(`/api/velo/shipments/${encodeURIComponent(shipmentId)}`);
    if (response.status === 404) return false;
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Velo status check failed.');
    $('dialog-booking-status').textContent = data.status;
    if (data.confirmed) {
      setVeloStatus(`Velo confirmed ${data.amount} ${data.asset} on Stellar Testnet.`, 'good');
      $('velo-checkout-button').textContent = 'Velo booking paid · Testnet';
      $('velo-checkout-button').disabled = true;
      if (veloPollTimer) clearInterval(veloPollTimer);
      veloPollTimer = null;
      return true;
    }
    const failed = ['failed', 'canceled', 'cancelled'].includes(String(data.status).toLowerCase());
    setVeloStatus(`Velo booking status: ${data.status}. ${failed ? 'Create a new checkout to retry.' : 'Waiting for ledger confirmation…'}`, failed ? 'bad' : 'wait');
    if (poll && !veloPollTimer && !failed) {
      let attempts = 0;
      veloPollTimer = setInterval(async () => {
        attempts += 1;
        await checkVeloBooking();
        if (attempts >= 18 && veloPollTimer) {
          clearInterval(veloPollTimer);
          veloPollTimer = null;
        }
      }, 2500);
    }
    return false;
  } catch (error) {
    setVeloStatus(error.message, 'bad');
    return false;
  }
}

async function createVeloCheckout() {
  const button = $('velo-checkout-button');
  button.disabled = true;
  setVeloStatus('Creating a Testnet booking session with Velo…', 'wait');
  try {
    const shipmentId = currentShipmentId();
    const response = await fetch('/api/velo/checkout', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shipmentId, idempotencyKey: `aeropay_${shipmentId}` }),
    });
    const session = await response.json();
    if (!response.ok) throw new Error(session.error || 'Could not create the Velo checkout.');
    setVeloStatus(`Opening Velo Testnet checkout for ${session.amount} ${session.asset}…`, 'wait');
    window.location.assign(session.checkoutUrl);
  } catch (error) {
    setVeloStatus(error.message, 'bad');
    button.disabled = !apiServices?.velo.configured;
  }
}

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
  $('settle-button').disabled = false;
  $('settle-label').textContent = key === 'success' ? 'Start delivery' : 'Start delivery (refusal check)';
  $('button-note').textContent = allowed
    ? 'The tag signs a reading. The agent verifies it, waits for the Velo booking, checks the Noir policy, then pays on its own.'
    : 'The tag signs the reading and the agent decides. No payout is sent for a failed check.';
  timeline.innerHTML = `
    <div class="event"><span class="event-icon">01</span><div><b>Reading received</b><small>Cold-chain tag · ${scenario.temp.toFixed(1)}°C · sample data</small></div><span class="event-state${tempOk ? '' : ' bad'}">${tempOk ? 'IN RANGE' : 'BREACH'}</span></div>
    <div class="event"><span class="event-icon">02</span><div><b>Destination reached</b><small>${points.delivery.label} · sample location</small></div><span class="event-state">REACHED</span></div>
    <div class="event"><span class="event-icon">03</span><div><b>Policy checked</b><small>${capOk ? `${formatPHP(amount)} is within the ₱10,000 cap` : `${formatPHP(amount)} exceeds the ₱10,000 cap`}</small></div><span class="event-state${allowed ? '' : ' bad'}">${allowed ? 'ALLOW' : 'DENY'}</span></div>
    <div class="event last"><span class="event-icon">04</span><div><b>Waiting for agent decision</b><small>${allowed ? 'The agent will check Velo booking and Noir policy' : 'No payout will be sent unless every check passes'}</small></div><span class="event-state pending">READY</span></div>`;
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
$('settle-button').addEventListener('click', startDelivery);
$('claim-button').addEventListener('click', claimAsMerchant);
$('new-shipment').addEventListener('click', () => {
  sessionStorage.removeItem('aeropay.shipmentId');
  window.location.assign(window.location.pathname);
});
$('velo-checkout-button').addEventListener('click', createVeloCheckout);
updateRouteLabels();
initializeMap();
loadServiceStatus().then(async () => {
  restoreShipment();
  const query = new URLSearchParams(window.location.search);
  if (query.get('velo') === 'return') {
    setVeloStatus('Returned from Velo. Checking the Testnet ledger…', 'wait');
    await checkVeloBooking({ poll: true });
    history.replaceState({}, '', window.location.pathname);
  } else if (query.get('velo') === 'cancel') {
    setVeloStatus('Checkout was canceled. No Velo payment was confirmed.', 'bad');
    history.replaceState({}, '', window.location.pathname);
  } else {
    await checkVeloBooking({ poll: true });
  }
});

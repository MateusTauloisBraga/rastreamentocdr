const map = L.map('map', { zoomControl: false }).setView([-15.8, -47.9], 5);
L.control.zoom({ position: 'bottomright' }).addTo(map);

L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '&copy; OpenStreetMap',
}).addTo(map);

const layers = {
  routeRemaining: L.polyline([], { color: '#8e6a35', weight: 5, opacity: 0.78 }).addTo(map),
  routeDone: L.polyline([], { color: '#2f8b57', weight: 7, opacity: 0.96 }).addTo(map),
  marker: null,
};

const el = {
  lastUpdate: document.querySelector('#last-update'),
  targetName: document.querySelector('#target-name'),
  progressTitle: document.querySelector('#progress-title'),
  progressBar: document.querySelector('#progress-bar'),
  doneDistance: document.querySelector('#done-distance'),
  remainingDistance: document.querySelector('#remaining-distance'),
  totalDistance: document.querySelector('#total-distance'),
  avgSpeed: document.querySelector('#avg-speed'),
  avgPace: document.querySelector('#avg-pace'),
  eta: document.querySelector('#eta'),
  pointCount: document.querySelector('#point-count'),
  routeSummary: document.querySelector('#route-summary'),
  statusMessage: document.querySelector('#status-message'),
  refreshButton: document.querySelector('#refresh-button'),
};

let route = [];
let routeDistances = [];
let fallbackTargetDistanceKm = null;
let fitted = false;
const offRouteThresholdMeters = 800;

el.refreshButton.addEventListener('click', async () => {
  el.refreshButton.disabled = true;
  await fetch('/api/refresh', { method: 'POST' }).catch(() => null);
  await update();
  el.refreshButton.disabled = false;
});

await loadConfig();
await update();
setInterval(update, 30_000);

async function loadConfig() {
  const config = await fetchJson('/api/config');
  el.targetName.textContent = config.targetName || 'Caminhos de Rosa';
  fallbackTargetDistanceKm = config.targetDistanceKm || null;
  route = parseRoute(config.routeFormat, config.routeText);
  routeDistances = cumulativeDistances(route);

  if (route.length) {
    layers.routeRemaining.setLatLngs(route);
    el.routeSummary.textContent = `Percurso calculado pelo GPX: ${formatKm(routeDistances.at(-1) || 0)} em ${route.length.toLocaleString('pt-BR')} pontos.`;
    fitMap(route);
  } else {
    el.routeSummary.textContent = 'Percurso GPX aguardando carregamento.';
  }
}

async function update() {
  const status = await fetchJson('/api/status');
  const points = status.points || [];
  const latest = status.latestPoint;
  const progress = calculateProgress(latest, points);
  paintRoute(progress);

  if (latest) {
    const liveTrail = points.map((point) => [point.lat, point.lon]);
    const markerPosition = route.length ? progress.projectedPoint : [latest.lat, latest.lon];
    setMarker(markerPosition);
    if (!fitted) fitMap(route.length ? route : liveTrail);
  }

  renderStatus(status, progress);
}

function fetchJson(url) {
  return fetch(url).then((response) => {
    if (!response.ok) throw new Error(`Erro ${response.status}`);
    return response.json();
  });
}

function parseRoute(format, text) {
  if (!format || !text) return [];
  try {
    if (format === 'geojson') return parseGeoJson(JSON.parse(text));
    if (format === 'gpx') return parseGpx(text);
  } catch (error) {
    el.statusMessage.textContent = `Não consegui ler o trajeto: ${error.message}`;
  }
  return [];
}

function parseGeoJson(geojson) {
  const coords = [];
  const collect = (geometry) => {
    if (!geometry) return;
    if (geometry.type === 'LineString') coords.push(...geometry.coordinates.map(toLatLon));
    if (geometry.type === 'MultiLineString') geometry.coordinates.forEach((line) => coords.push(...line.map(toLatLon)));
  };
  if (geojson.type === 'FeatureCollection') geojson.features.forEach((feature) => collect(feature.geometry));
  if (geojson.type === 'Feature') collect(geojson.geometry);
  collect(geojson);
  return coords.filter(Boolean);
}

function parseGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const points = [...doc.querySelectorAll('trkpt, rtept')].map((node) => [
    Number(node.getAttribute('lat')),
    Number(node.getAttribute('lon')),
  ]);
  return points.filter(([lat, lon]) => Number.isFinite(lat) && Number.isFinite(lon));
}

function toLatLon(coord) {
  const lon = Number(coord?.[0]);
  const lat = Number(coord?.[1]);
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
}

function cumulativeDistances(points) {
  const distances = [0];
  for (let index = 1; index < points.length; index += 1) {
    distances[index] = distances[index - 1] + haversine(points[index - 1], points[index]);
  }
  return distances;
}

function calculateProgress(latest, points) {
  const totalRouteMeters = routeDistances.at(-1) || 0;
  const fallbackTotalMeters = fallbackTargetDistanceKm ? fallbackTargetDistanceKm * 1000 : 0;
  let doneMeters = latest?.totalDistanceMeters || trailDistance(points);
  let routeIndex = -1;
  let projectedPoint = null;
  let distanceFromRouteMeters = null;
  let isOffRoute = false;

  if (route.length > 1) {
    const routeProgress = progressFromRoute(points);
    doneMeters = routeProgress.doneMeters;
    routeIndex = routeProgress.routeIndex;
    projectedPoint = routeProgress.projectedPoint;
    distanceFromRouteMeters = routeProgress.distanceFromRouteMeters;
    isOffRoute = Boolean(latest && distanceFromRouteMeters != null && distanceFromRouteMeters > offRouteThresholdMeters);
  }

  const totalMeters = totalRouteMeters || fallbackTotalMeters;
  if (totalMeters) doneMeters = Math.min(Math.max(doneMeters, 0), totalMeters);
  const remainingMeters = totalMeters ? Math.max(0, totalMeters - doneMeters) : null;
  const durationSecs = latest?.durationSecs || durationFromPoints(points);
  const avgMetersPerSec = durationSecs > 0 ? doneMeters / durationSecs : latest?.speedMetersPerSec || null;
  const etaDate = avgMetersPerSec && remainingMeters != null ? new Date(Date.now() + (remainingMeters / avgMetersPerSec) * 1000) : null;

  return {
    doneMeters,
    remainingMeters,
    totalMeters,
    durationSecs,
    avgMetersPerSec,
    etaDate,
    routeIndex,
    projectedPoint,
    distanceFromRouteMeters,
    isOffRoute,
    percent: totalMeters ? Math.min(100, Math.max(0, (doneMeters / totalMeters) * 100)) : 0,
  };
}

function progressFromRoute(points) {
  const projections = points
    .map((point) => projectOnRoute([point.lat, point.lon]))
    .filter(Boolean);
  const onRoute = projections.filter((projection) => projection.distanceMeters <= offRouteThresholdMeters);
  const chosen = onRoute.at(-1) || projections[0] || null;

  if (!chosen) {
    return {
      doneMeters: 0,
      routeIndex: -1,
      projectedPoint: null,
      distanceFromRouteMeters: null,
    };
  }

  return {
    doneMeters: onRoute.length ? chosen.distanceAlongMeters : 0,
    routeIndex: onRoute.length ? chosen.routeIndex : -1,
    projectedPoint: onRoute.length ? chosen.projectedPoint : null,
    distanceFromRouteMeters: projections.at(-1)?.distanceMeters ?? chosen.distanceMeters,
  };
}

function projectOnRoute(position) {
  let best = null;
  for (let index = 1; index < route.length; index += 1) {
    const projected = projectOnSegment(position, route[index - 1], route[index]);
    const distanceAlongMeters = routeDistances[index - 1] + projected.segmentDistanceMeters;
    if (!best || projected.distanceMeters < best.distanceMeters) {
      best = {
        ...projected,
        distanceAlongMeters,
        routeIndex: index,
      };
    }
  }
  return best;
}

function projectOnSegment(position, start, end) {
  const metersPerLat = 111320;
  const latRef = toRad((start[0] + end[0] + position[0]) / 3);
  const metersPerLon = Math.cos(latRef) * metersPerLat;
  const ax = start[1] * metersPerLon;
  const ay = start[0] * metersPerLat;
  const bx = end[1] * metersPerLon;
  const by = end[0] * metersPerLat;
  const px = position[1] * metersPerLon;
  const py = position[0] * metersPerLat;
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
  const projectedX = ax + t * dx;
  const projectedY = ay + t * dy;
  const projectedPoint = [projectedY / metersPerLat, projectedX / metersPerLon];

  return {
    projectedPoint,
    segmentDistanceMeters: haversine(start, projectedPoint),
    distanceMeters: haversine(position, projectedPoint),
  };
}

function paintRoute(progress) {
  if (!route.length) return;
  if (progress.routeIndex < 0 || !progress.projectedPoint) {
    layers.routeDone.setLatLngs([]);
    layers.routeRemaining.setLatLngs(route);
    return;
  }
  layers.routeDone.setLatLngs([...route.slice(0, progress.routeIndex), progress.projectedPoint]);
  layers.routeRemaining.setLatLngs([progress.projectedPoint, ...route.slice(progress.routeIndex)]);
}

function trailDistance(points) {
  return points.reduce((total, point, index) => {
    if (index === 0) return 0;
    return total + haversine([points[index - 1].lat, points[index - 1].lon], [point.lat, point.lon]);
  }, 0);
}

function durationFromPoints(points) {
  if (points.length < 2) return null;
  return Math.max(0, (points.at(-1).timestamp - points[0].timestamp) / 1000);
}

function renderStatus(status, progress) {
  const latest = status.latestPoint;
  el.lastUpdate.textContent = status.lastSuccessAt ? `Atualizado ${formatRelative(status.lastSuccessAt)}` : 'Aguardando primeira leitura';
  el.progressTitle.textContent = latest ? `${progress.percent.toFixed(1)}% concluído` : 'Sem ponto ainda';
  el.progressBar.style.width = `${progress.percent}%`;
  el.doneDistance.textContent = formatKm(progress.doneMeters);
  el.remainingDistance.textContent = progress.remainingMeters == null ? '--' : formatKm(progress.remainingMeters);
  el.totalDistance.textContent = progress.totalMeters ? formatKm(progress.totalMeters) : '--';
  el.avgSpeed.textContent = progress.avgMetersPerSec ? `${(progress.avgMetersPerSec * 3.6).toFixed(1)} km/h` : '--';
  el.avgPace.textContent = progress.avgMetersPerSec ? formatPace(progress.avgMetersPerSec) : '--';
  el.eta.textContent = progress.etaDate ? progress.etaDate.toLocaleString('pt-BR', { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : '--';
  el.pointCount.textContent = String(status.pointCount || 0);

  if (status.error) {
    el.statusMessage.textContent = 'Rastreador conectado. Aguardando uma posição válida.';
  } else if (!status.hasGarminUrl) {
    el.statusMessage.textContent = 'Configure o link do rastreador na página oculta.';
  } else if (!route.length) {
    el.statusMessage.textContent = 'Link salvo. Cole o GPX ou GeoJSON para pintar o trajeto completo.';
  } else if (progress.isOffRoute) {
    el.statusMessage.textContent = 'Rastreador conectado. O progresso avança quando a posição entra no percurso.';
  } else {
    el.statusMessage.textContent = 'Linha verde mostra o trecho já percorrido; a linha de terra mostra o percurso completo.';
  }
}

function setMarker(position) {
  if (!position) {
    if (layers.marker) {
      map.removeLayer(layers.marker);
      layers.marker = null;
    }
    return;
  }

  if (!layers.marker) {
    layers.marker = L.marker(position, {
      icon: L.divIcon({ className: 'live-marker', iconSize: [22, 22] }),
      title: 'Posição mais recente',
    }).addTo(map);
  } else {
    layers.marker.setLatLng(position);
  }
}

function fitMap(points) {
  if (!points.length) return;
  fitted = true;
  map.fitBounds(L.latLngBounds(points), { padding: [42, 42], maxZoom: 15 });
}

function haversine(a, b) {
  const radius = 6371000;
  const lat1 = toRad(a[0]);
  const lat2 = toRad(b[0]);
  const dLat = toRad(b[0] - a[0]);
  const dLon = toRad(b[1] - a[1]);
  const value = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radius * Math.atan2(Math.sqrt(value), Math.sqrt(1 - value));
}

function toRad(value) {
  return (value * Math.PI) / 180;
}

function formatKm(meters) {
  if (!Number.isFinite(meters)) return '--';
  return `${(meters / 1000).toFixed(1)} km`;
}

function formatMeters(meters) {
  if (!Number.isFinite(meters)) return '--';
  return meters >= 1000 ? formatKm(meters) : `${Math.round(meters)} m`;
}

function formatPace(metersPerSec) {
  const secondsPerKm = 1000 / metersPerSec;
  const minutes = Math.floor(secondsPerKm / 60);
  const seconds = Math.round(secondsPerKm % 60).toString().padStart(2, '0');
  return `${minutes}:${seconds}/km`;
}

function formatRelative(iso) {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return 'agora';
  if (seconds < 3600) return `há ${Math.round(seconds / 60)} min`;
  return new Date(iso).toLocaleString('pt-BR', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit' });
}

import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const publicDir = join(__dirname, 'public');
const dataDir = join(__dirname, 'data');
const defaultRoutePath = join(__dirname, 'GPXBASE.gpx');
const configPath = join(dataDir, 'tracker-config.json');
const statePath = join(dataDir, 'tracker-state.json');
const port = Number(process.env.PORT || 3000);
const pollMs = Number(process.env.POLL_MS || 15 * 60 * 1000);

const jsonHeaders = { 'content-type': 'application/json; charset=utf-8' };
const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const garminHeaders = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  accept: 'application/json,text/plain,*/*',
  referer: 'https://livetrack.garmin.com/',
};

let config = {
  garminUrl: '',
  routeFormat: '',
  routeText: '',
  targetName: 'Caminhos de Rosa',
  targetDistanceKm: null,
};

let state = {
  lastFetchAt: null,
  lastSuccessAt: null,
  error: '',
  session: null,
  latestPoint: null,
  points: [],
};

await ensureDataFiles();
config = await loadJson(configPath, config);
state = await loadJson(statePath, state);
config = await withDefaultRoute(config);

if (config.garminUrl) {
  refreshGarmin().catch((error) => updateError(error));
}

setInterval(() => {
  if (config.garminUrl) {
    refreshGarmin().catch((error) => updateError(error));
  }
}, pollMs);

createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'GET' && url.pathname === '/api/status') {
      return sendJson(res, publicStatus());
    }

    if (req.method === 'GET' && url.pathname === '/api/config') {
      return sendJson(res, publicConfig());
    }

    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req);
      const next = JSON.parse(body || '{}');
      config = normalizeConfig(next, config);
      await writeJson(configPath, config);
      state.error = '';
      if (config.garminUrl) {
        await refreshGarmin().catch((error) => updateError(error));
      } else {
        await writeJson(statePath, state);
      }
      return sendJson(res, { ok: true, config: publicConfig(), status: publicStatus() });
    }

    if (req.method === 'POST' && url.pathname === '/api/refresh') {
      await refreshGarmin().catch((error) => updateError(error));
      return sendJson(res, publicStatus());
    }

    if (req.method === 'GET' && (url.pathname === '/configurar-rastreador' || url.pathname === '/configurar-garmin')) {
      return serveFile(res, join(publicDir, 'admin.html'));
    }

    if (req.method === 'GET') {
      const path = url.pathname === '/' ? '/index.html' : url.pathname;
      return serveFile(res, join(publicDir, path));
    }

    res.writeHead(405, jsonHeaders);
    res.end(JSON.stringify({ error: 'Method not allowed' }));
  } catch (error) {
    res.writeHead(500, jsonHeaders);
    res.end(JSON.stringify({ error: error.message || 'Unexpected error' }));
  }
}).listen(port, () => {
  console.log(`Rastreamento Caminhos de Rosa em http://localhost:${port}`);
  console.log(`Configuracao oculta em http://localhost:${port}/configurar-rastreador`);
});

async function ensureDataFiles() {
  await mkdir(dataDir, { recursive: true });
  if (!existsSync(configPath)) await writeJson(configPath, config);
  if (!existsSync(statePath)) await writeJson(statePath, state);
}

async function loadJson(path, fallback) {
  try {
    return { ...fallback, ...JSON.parse(await readFile(path, 'utf8')) };
  } catch {
    return fallback;
  }
}

async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2), 'utf8');
}

async function withDefaultRoute(value) {
  if (value.routeText || !existsSync(defaultRoutePath)) return value;
  return {
    ...value,
    routeFormat: 'gpx',
    routeText: await readFile(defaultRoutePath, 'utf8'),
  };
}

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

function sendJson(res, payload) {
  res.writeHead(200, jsonHeaders);
  res.end(JSON.stringify(payload));
}

async function serveFile(res, requestedPath) {
  const safePath = normalize(requestedPath);
  if (!safePath.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end('Forbidden');
  }

  try {
    const content = await readFile(safePath);
    res.writeHead(200, { 'content-type': mimeTypes[extname(safePath)] || 'application/octet-stream' });
    res.end(content);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

function normalizeConfig(input, current = config) {
  const garminUrl = String(input.garminUrl || '').trim();
  const nextRouteFormat = Object.hasOwn(input, 'routeFormat')
    ? String(input.routeFormat || '').trim().toLowerCase()
    : current.routeFormat;
  const nextRouteText = Object.hasOwn(input, 'routeText')
    ? String(input.routeText || '').trim()
    : current.routeText;
  return {
    garminUrl: garminUrl || current.garminUrl || '',
    routeFormat: nextRouteFormat,
    routeText: nextRouteText,
    targetName: String(input.targetName || 'Caminhos de Rosa').trim() || 'Caminhos de Rosa',
    targetDistanceKm: input.targetDistanceKm ? Number(input.targetDistanceKm) : null,
  };
}

function publicConfig() {
  return {
    routeFormat: config.routeFormat,
    routeText: config.routeText,
    targetName: config.targetName,
    targetDistanceKm: config.targetDistanceKm,
    hasGarminUrl: Boolean(config.garminUrl),
    garminPreview: config.garminUrl ? maskUrl(config.garminUrl) : '',
    pollMs,
  };
}

function publicStatus() {
  return {
    ...state,
    session: publicSession(state.session),
    error: publicError(state.error),
    pointCount: state.points.length,
    pollMs,
    hasGarminUrl: Boolean(config.garminUrl),
    targetDistanceKm: config.targetDistanceKm,
  };
}

function publicSession(session) {
  if (!session) return null;
  const { token, sessionToken, ...safeSession } = session;
  return safeSession;
}

function publicError(error) {
  if (!error) return '';
  return 'Nao foi possivel ler uma posicao valida do rastreador.';
}

function maskUrl(url) {
  return url.replace(/token\/([^/?#]+)/i, (_, token) => `token/${token.slice(0, 6)}...${token.slice(-4)}`);
}

async function refreshGarmin() {
  const parsed = parseGarminUrl(config.garminUrl);
  if (!parsed) throw new Error('Link do rastreador invalido.');

  state.lastFetchAt = new Date().toISOString();
  const errors = [];
  const nextState = await fetchGraphql(parsed)
    .catch((error) => {
      errors.push(`GraphQL: ${error.message}`);
      return fetchLegacyServices(parsed);
    })
    .catch((error) => {
      errors.push(`services: ${error.message}`);
      return fetchHydratedPage(parsed);
    })
    .catch((error) => {
      errors.push(`pagina: ${error.message}`);
      throw new Error(errors.join(' | '));
    });
  state = mergePoints({
    ...state,
    ...nextState,
    error: '',
    lastSuccessAt: new Date().toISOString(),
  });
  await writeJson(statePath, state);
}

function parseGarminUrl(url) {
  const match = String(url).match(/livetrack\.garmin\.com\/session\/([^/?#]+)\/token\/([^/?#]+)/i);
  if (!match) return null;
  return { sessionId: decodeURIComponent(match[1]), token: decodeURIComponent(match[2]) };
}

async function fetchTrackLog({ sessionId, token }) {
  const from = state.points.at(-1)?.timestamp || 0;
  const requestTime = Date.now();
  const base = `https://livetrack.garmin.com/services/trackLog/${sessionId}/token/${token}`;
  const response = await garminFetch(`${base}?requestTime=${requestTime}&from=${from}`);
  const payload = await response.json();
  const points = Array.isArray(payload) ? payload.map(pointFromTrackLog).filter(Boolean) : [];
  return { session: state.session, points };
}

async function fetchLegacyServices(parsed) {
  const [session, track] = await Promise.all([
    fetchSession(parsed).catch((error) => ({ error: error.message })),
    fetchTrackLog(parsed),
  ]);
  return { session: session.error ? state.session : session, points: track.points };
}

async function fetchHydratedPage({ sessionId, token }) {
  const response = await garminFetch(`https://livetrack.garmin.com/session/${sessionId}/token/${token}`);
  const html = await response.text();
  const points = extractTrackPointsFromHtml(html).map(pointFromGraphql).filter(Boolean);
  const session = extractSessionFromHtml(html) || state.session;
  if (!points.length) throw new Error('nenhum trackPoint encontrado no HTML.');
  return { session, points };
}

async function fetchSession({ sessionId, token }) {
  const requestTime = Date.now();
  const base = `https://livetrack.garmin.com/services/session/${sessionId}/token/${token}`;
  const response = await garminFetch(`${base}?requestTime=${requestTime}`);
  return response.json();
}

async function fetchGraphql({ sessionId, token }) {
  const begin = state.points.at(-1)?.dateTime || state.session?.start || null;
  const response = await fetch('https://livetrack.garmin.com/apollo/graphql', {
    method: 'POST',
    headers: { ...garminHeaders, 'content-type': 'application/json' },
    body: JSON.stringify({
      query: `query sessionAndPoints($sessionId:String!,$token:String!,$begin:String){
        session:sessionById(sessionId:$sessionId,token:$token){start end sessionId sessionName sessionStatus}
        points:trackPointsBySessionId(sessionId:$sessionId,token:$token,begin:$begin){
          trackPoints{
            dateTime speed altitude
            position{lat lon}
            fitnessPointData{totalDurationSecs speedMetersPerSec totalDistanceMeters distanceMeters durationSecs eventTypes}
          }
        }
      }`,
      variables: { sessionId, token, begin },
    }),
  });

  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await responseSnippet(response)}`);
  const payload = await response.json();
  if (payload.errors?.length) throw new Error(payload.errors[0].message || 'Erro no Garmin GraphQL.');
  const trackPoints = payload.data?.points?.trackPoints || [];
  return {
    session: payload.data?.session || state.session,
    points: trackPoints.map(pointFromGraphql).filter(Boolean),
  };
}

async function garminFetch(url) {
  const response = await fetch(url, { headers: garminHeaders });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${await responseSnippet(response)}`);
  }
  return response;
}

function extractTrackPointsFromHtml(html) {
  const decoded = decodeNextPayload(html);
  const points = [];
  let startAt = 0;

  while (startAt < decoded.length) {
    const keyIndex = decoded.indexOf('"trackPoints":[', startAt);
    if (keyIndex === -1) break;
    const arrayStart = decoded.indexOf('[', keyIndex);
    const arrayText = readBalancedArray(decoded, arrayStart);
    if (!arrayText) break;
    try {
      const parsed = JSON.parse(arrayText);
      if (Array.isArray(parsed)) points.push(...parsed);
    } catch {
      // Keep scanning; the page can contain several serialized fragments.
    }
    startAt = arrayStart + arrayText.length;
  }

  return points;
}

function extractSessionFromHtml(html) {
  const decoded = decodeNextPayload(html);
  const sessionIndex = decoded.indexOf('"sessionId":');
  if (sessionIndex === -1) return null;
  const objectStart = decoded.lastIndexOf('{', sessionIndex);
  const objectText = readBalancedObject(decoded, objectStart);
  if (!objectText) return null;
  try {
    const parsed = JSON.parse(objectText);
    return {
      sessionId: parsed.sessionId,
      token: parsed.sessionToken,
      start: parsed.start,
      end: parsed.end,
      sessionName: parsed.sessionName,
      sessionStatus: parsed.end ? 'Complete' : 'InProgress',
      sessionType: parsed.sessionType,
    };
  } catch {
    return null;
  }
}

function decodeNextPayload(html) {
  return html
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function readBalancedArray(text, start) {
  return readBalanced(text, start, '[', ']');
}

function readBalancedObject(text, start) {
  return readBalanced(text, start, '{', '}');
}

function readBalanced(text, start, open, close) {
  if (start < 0 || text[start] !== open) return '';
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === open) depth += 1;
    if (char === close) depth -= 1;
    if (depth === 0) return text.slice(start, index + 1);
  }

  return '';
}

async function responseSnippet(response) {
  const text = await response.text().catch(() => '');
  return text.trim().slice(0, 220) || response.statusText || 'sem corpo de resposta';
}

function pointFromTrackLog(raw) {
  const lat = Number(raw?.latitude);
  const lon = Number(raw?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const meta = raw.metaData || {};
  return {
    lat,
    lon,
    timestamp: Number(raw.timestamp || Date.now()),
    dateTime: new Date(Number(raw.timestamp || Date.now())).toISOString(),
    speedMetersPerSec: numberOrNull(meta.SPEED),
    totalDistanceMeters: numberOrNull(meta.TOTAL_DISTANCE),
    durationSecs: numberOrNull(meta.TOTAL_DURATION) ? numberOrNull(meta.TOTAL_DURATION) / 1000 : null,
    source: 'trackLog',
  };
}

function pointFromGraphql(raw) {
  const lat = Number(raw?.position?.lat);
  const lon = Number(raw?.position?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const fitness = raw.fitnessPointData || {};
  return {
    lat,
    lon,
    timestamp: Date.parse(raw.dateTime || '') || Date.now(),
    dateTime: raw.dateTime || new Date().toISOString(),
    speedMetersPerSec: numberOrNull(fitness.speedMetersPerSec ?? raw.speed),
    totalDistanceMeters: numberOrNull(fitness.totalDistanceMeters),
    durationSecs: numberOrNull(fitness.totalDurationSecs),
    source: 'graphql',
  };
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mergePoints(nextState) {
  const seen = new Map();
  for (const point of [...state.points, ...(nextState.points || [])]) {
    seen.set(`${point.timestamp}-${point.lat.toFixed(7)}-${point.lon.toFixed(7)}`, point);
  }
  const points = [...seen.values()].sort((a, b) => a.timestamp - b.timestamp);
  return {
    ...nextState,
    points,
    latestPoint: points.at(-1) || null,
  };
}

async function updateError(error) {
  state.lastFetchAt = new Date().toISOString();
  state.error = error.message || 'Erro ao atualizar Garmin.';
  await writeJson(statePath, state);
}

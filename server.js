require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const path = require("path");
const fs = require("fs/promises");
const { MongoClient } = require("mongodb");

const app = express();
const PORT = process.env.PORT || 3000;
const AEMET_API_KEY = process.env.AEMET_API_KEY;
const AEMET_BASE = "https://opendata.aemet.es/opendata";
// En produccion CACHE_DIR debe apuntar a un volumen persistente; el disco de la aplicacion suele borrarse en cada despliegue/reinicio.
const CACHE_DIR = process.env.CACHE_DIR ? path.resolve(process.env.CACHE_DIR) : path.join(__dirname, ".cache");
const STATION_CACHE_DIR = path.join(CACHE_DIR, "stations");
const STATIONS_CACHE_FILE = path.join(CACHE_DIR, "stations_inventory_v2.json");
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENT_DATA_TTL_HOURS = Number(process.env.RECENT_DATA_TTL_HOURS || "12");
const RECENT_DATA_TTL_MS =
  Number.isFinite(RECENT_DATA_TTL_HOURS) && RECENT_DATA_TTL_HOURS > 0 ? RECENT_DATA_TTL_HOURS * 60 * 60 * 1000 : 12 * 60 * 60 * 1000;
// AEMET puede corregir los datos de las ultimas semanas; pasado este margen un bloque se considera definitivo.
const CHUNK_FINAL_AFTER_DAYS = 30;
const STATIONS_CACHE_TTL_HOURS = Number(process.env.STATIONS_CACHE_TTL_HOURS || "720");
const STATIONS_CACHE_TTL_MS =
  Number.isFinite(STATIONS_CACHE_TTL_HOURS) && STATIONS_CACHE_TTL_HOURS > 0
    ? STATIONS_CACHE_TTL_HOURS * 60 * 60 * 1000
    : 720 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || "20000");
const MAX_STATION_ID_LENGTH = 16;
// Rango que se descarga en primer plano mientras se explora el historico completo.
const DEFAULT_START_YEAR = 1976;
// AEMET no tiene datos diarios anteriores a 1920.
const MIN_HISTORY_YEAR = 1920;
// Anos seguidos sin datos que se toleran (p. ej. guerra civil) antes de dar por encontrado el primer registro.
const HISTORY_GAP_TOLERANCE_YEARS = 5;
const WINDOW_HALF_DAYS = 7;
const MIN_WINDOW_DAYS = 10;
const EVOLUTION_JOB_RETENTION_MINUTES = Math.max(5, Number(process.env.EVOLUTION_JOB_RETENTION_MINUTES || "45"));
const EVOLUTION_JOB_RETENTION_MS = EVOLUTION_JOB_RETENTION_MINUTES * 60 * 1000;
const AEMET_REQUEST_DELAY_MS = Math.max(300, Number(process.env.AEMET_REQUEST_DELAY_MS || "1000"));
const AEMET_MAX_BACKOFF_MS = 30000;
const EVOLUTION_SYNC_LIMIT_PER_MIN = Math.max(4, Number(process.env.EVOLUTION_SYNC_LIMIT_PER_MIN || "12"));
const EVOLUTION_ENQUEUE_LIMIT_PER_MIN = Math.max(10, Number(process.env.EVOLUTION_ENQUEUE_LIMIT_PER_MIN || "40"));
const EVOLUTION_STATUS_LIMIT_PER_MIN = Math.max(60, Number(process.env.EVOLUTION_STATUS_LIMIT_PER_MIN || "240"));

const refreshSecret = String(process.env.REFRESH_SECRET || "").trim();
const evolutionJobs = new Map();
let evolutionJobSequence = 0;

const chunkTasks = new Map();
const pendingHighChunks = [];
const pendingLowChunks = [];
let runningChunkTask = null;
let averageChunkMs = 3000;
let aemetThrottledUntil = 0;

const stationScans = new Map();

if (!AEMET_API_KEY) {
  console.warn("AEMET_API_KEY no esta definida. Crea un archivo .env a partir de .env.example");
}

// La web solo lee de Atlas (usuario de solo lectura); los datos los sube scripts/upload-to-mongo.js.
const MONGODB_URI_READ = process.env.MONGODB_URI_READ;
const MONGODB_DB = process.env.MONGODB_DB || "si_se_calienta";
let mongoDbPromise = null;

function getMongoDb() {
  if (!MONGODB_URI_READ) return null;
  if (!mongoDbPromise) {
    const client = new MongoClient(MONGODB_URI_READ, { serverSelectionTimeoutMS: 5000 });
    mongoDbPromise = client.connect().then(() => client.db(MONGODB_DB));
    // Si la conexion falla, el siguiente intento vuelve a probar en vez de quedarse con el error.
    mongoDbPromise.catch(() => {
      mongoDbPromise = null;
    });
  }
  return mongoDbPromise;
}

async function findInMongo(collection, id) {
  try {
    // Dentro del try: una URI mal escrita lanza al crear el cliente y no debe tumbar la peticion.
    const dbPromise = getMongoDb();
    if (!dbPromise) return null;
    return await (await dbPromise).collection(collection).findOne({ _id: id });
  } catch (error) {
    logServerError(`mongo.${collection}`, error);
    return null;
  }
}

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        connectSrc: ["'self'", "https://cdn.jsdelivr.net", "https://unpkg.com"],
        imgSrc: ["'self'", "https:", "data:", "blob:"],
        styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com", "https://unpkg.com"],
        fontSrc: ["'self'", "https://fonts.gstatic.com"],
        scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "https://unpkg.com"],
        // Safari aplica esta directiva tambien a http://localhost y rompe la carga de CSS/JS en local.
        upgradeInsecureRequests: null,
      },
    },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

const baseLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 80,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas solicitudes. Intenta de nuevo en un minuto." },
});

const evolutionLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: EVOLUTION_SYNC_LIMIT_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Limite temporal alcanzado para /api/evolution. Espera un minuto." },
});

const evolutionEnqueueLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: EVOLUTION_ENQUEUE_LIMIT_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas solicitudes de encolado. Espera un minuto." },
});

const evolutionStatusLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: EVOLUTION_STATUS_LIMIT_PER_MIN,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Demasiadas consultas de estado. Reduce la frecuencia de actualizacion." },
});

app.use(express.static(path.join(__dirname, "public")));
app.use(baseLimiter);

function isValidStationId(station) {
  return /^[A-Z0-9_]+$/.test(station) && station.length > 0 && station.length <= MAX_STATION_ID_LENGTH;
}

function safeApiError(message, statusCode = 500) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function createEvolutionJobId() {
  evolutionJobSequence += 1;
  return `job_${Date.now()}_${evolutionJobSequence}`;
}

function buildEvolutionJobKey(station, month, day, forceRefresh) {
  return `${station}_${month}_${day}_${forceRefresh ? "refresh" : "cached"}`;
}

function pruneOldEvolutionJobs() {
  const now = Date.now();
  for (const [jobId, job] of evolutionJobs.entries()) {
    if (job.status === "running") {
      continue;
    }

    const finishedAt = Number(job.finishedAt || 0);
    if (finishedAt > 0 && now - finishedAt > EVOLUTION_JOB_RETENTION_MS) {
      evolutionJobs.delete(jobId);
    }
  }
}

function redactErrorForClient(error, fallback) {
  if (!error) return fallback;
  if (
    error.statusCode === 400 ||
    error.statusCode === 401 ||
    error.statusCode === 403 ||
    error.statusCode === 404
  ) {
    return error.message || fallback;
  }
  return fallback;
}

function logServerError(context, error) {
  const status = error && error.status ? ` status=${error.status}` : "";
  const detail = error && error.message ? ` detail=${error.message}` : "";
  console.error(`[${context}]${status}${detail}`);
}

function buildAemetUrl(endpointPath) {
  const separator = endpointPath.includes("?") ? "&" : "?";
  return `${AEMET_BASE}${endpointPath}${separator}api_key=${encodeURIComponent(AEMET_API_KEY || "")}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aemetHttpError(response, body, label) {
  const error = new Error(`${label} (${response.status}): ${body}`);
  error.status = response.status;
  const retryAfter = Number(response.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    error.retryAfterMs = retryAfter * 1000;
  }
  return error;
}

// Los datos de AEMET vienen en ISO-8859-15; leerlos como UTF-8 rompe enes y tildes.
async function readAemetJson(response) {
  const contentType = String(response.headers.get("content-type") || "");
  const charsetMatch = contentType.match(/charset=([^;]+)/i);
  const charset = charsetMatch ? charsetMatch[1].trim().toLowerCase() : "utf-8";
  const buffer = await response.arrayBuffer();
  let text;
  try {
    text = new TextDecoder(charset).decode(buffer);
  } catch (_error) {
    text = new TextDecoder("latin1").decode(buffer);
  }
  return JSON.parse(text);
}

async function fetchAemetData(endpointPath) {
  const firstStepResponse = await fetch(buildAemetUrl(endpointPath), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

  if (!firstStepResponse.ok) {
    throw aemetHttpError(firstStepResponse, await firstStepResponse.text(), "Error AEMET");
  }

  const firstStepJson = await firstStepResponse.json();

  // AEMET responde HTTP 200 y pone el codigo real en "estado" (404 = sin datos, 429 = limite de peticiones).
  const estado = Number(firstStepJson.estado);
  if (estado === 404) {
    return [];
  }

  if (!firstStepJson.datos) {
    const error = new Error(firstStepJson.descripcion || "AEMET no devolvio URL de datos");
    if (Number.isFinite(estado)) error.status = estado;
    throw error;
  }

  const dataResponse = await fetch(firstStepJson.datos, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!dataResponse.ok) {
    throw aemetHttpError(dataResponse, await dataResponse.text(), "Error descargando datos AEMET");
  }

  return readAemetJson(dataResponse);
}

function isRetryableAemetError(error) {
  if (!error) return false;
  if (error.status === 429 || error.status >= 500) return true;
  if (/429/.test(error.message || "")) return true;
  return !error.status;
}

async function fetchAemetDataWithRetry(endpointPath, maxRetries = 5) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchAemetData(endpointPath);
    } catch (error) {
      if (!isRetryableAemetError(error) || attempt >= maxRetries) {
        throw error;
      }

      const backoffMs = Math.min(error.retryAfterMs || 2000 * 2 ** attempt, AEMET_MAX_BACKOFF_MS);
      if (error.status === 429) {
        aemetThrottledUntil = Math.max(aemetThrottledUntil, Date.now() + backoffMs);
      }
      await wait(backoffMs);
    }
  }
}

function parseNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const cleaned = String(value).replace(",", ".").trim();
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

async function readStationsCache({ allowExpired = false } = {}) {
  try {
    const raw = await fs.readFile(STATIONS_CACHE_FILE, "utf8");
    const cached = JSON.parse(raw);
    if (!cached || typeof cached !== "object") return null;
    if (!Array.isArray(cached.payload) || cached.payload.length === 0) return null;

    const createdAt = Number(cached.createdAt || 0);
    if (!Number.isFinite(createdAt) || createdAt <= 0) return null;

    const isExpired = Date.now() - createdAt > STATIONS_CACHE_TTL_MS;
    if (isExpired && !allowExpired) {
      return null;
    }

    return {
      createdAt,
      isExpired,
      payload: cached.payload,
    };
  } catch (_error) {
    return null;
  }
}

async function writeJsonAtomic(filePath, value) {
  const tmpFile = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(tmpFile, JSON.stringify(value), "utf8");
  await fs.rename(tmpFile, filePath);
}

async function writeStationsCache(payload) {
  await writeJsonAtomic(STATIONS_CACHE_FILE, { createdAt: Date.now(), payload });
}

function monthDayFromFecha(fecha) {
  if (!fecha || typeof fecha !== "string") return null;
  const parts = fecha.split("-");
  if (parts.length !== 3) return null;
  return `${parts[1]}-${parts[2]}`;
}

function isValidDateParts(year, month, day) {
  const monthNum = Number(month);
  const dayNum = Number(day);

  if (!Number.isInteger(monthNum) || !Number.isInteger(dayNum)) return false;
  if (monthNum < 1 || monthNum > 12 || dayNum < 1 || dayNum > 31) return false;

  const date = new Date(Date.UTC(year, monthNum - 1, dayNum));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === monthNum - 1 &&
    date.getUTCDate() === dayNum
  );
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function currentYear() {
  return new Date().getUTCFullYear();
}

function stationDir(station) {
  return path.join(STATION_CACHE_DIR, station.replace(/[^a-zA-Z0-9_-]/g, "_"));
}

// Un bloque = medio ano de una estacion; AEMET no admite rangos de mas de 6 meses por peticion.
function halfOfMonth(month) {
  return Number(month) <= 6 ? 1 : 2;
}

function chunkRange(year, half) {
  return half === 1 ? [`${year}-01-01`, `${year}-06-30`] : [`${year}-07-01`, `${year}-12-31`];
}

function chunkKey(station, year, half) {
  return `${station}_${year}_H${half}`;
}

function chunkFilePath(station, year, half) {
  return path.join(stationDir(station), `${year}-H${half}.json`);
}

function chunkHasStarted(year, half) {
  return chunkRange(year, half)[0] <= todayISO();
}

function isChunkUsable(chunk, year, half) {
  const endMs = Date.parse(`${chunkRange(year, half)[1]}T23:59:59Z`);
  const isFinal = chunk.fetchedAt - endMs > CHUNK_FINAL_AFTER_DAYS * DAY_MS;
  return isFinal || Date.now() - chunk.fetchedAt < RECENT_DATA_TTL_MS;
}

async function readChunk(station, year, half) {
  try {
    const cached = JSON.parse(await fs.readFile(chunkFilePath(station, year, half), "utf8"));
    if (!cached || !Number.isFinite(cached.fetchedAt) || !cached.rows || typeof cached.rows !== "object") return null;
    return cached;
  } catch (_error) {
    return null;
  }
}

async function readUsableChunk(station, year, half) {
  // Lo que esta en Atlas lo mantiene al dia la tarea diaria, asi que se da por bueno sin mirar su antiguedad.
  const stored = await findInMongo("chunks", chunkKey(station, year, half));
  if (stored && stored.rows) return { fetchedAt: stored.fetchedAt, rows: stored.rows };

  const chunk = await readChunk(station, year, half);
  return chunk && isChunkUsable(chunk, year, half) ? chunk : null;
}

async function downloadChunk(station, year, half) {
  const [start, end] = chunkRange(year, half);
  const today = todayISO();
  const clampedEnd = end > today ? today : end;
  const endpointPath = `/api/valores/climatologicos/diarios/datos/fechaini/${start}T00:00:00UTC/fechafin/${clampedEnd}T23:59:59UTC/estacion/${encodeURIComponent(station)}`;
  const rawData = await fetchAemetDataWithRetry(endpointPath);

  const rows = {};
  for (const item of Array.isArray(rawData) ? rawData : []) {
    const monthDay = monthDayFromFecha(item.fecha);
    if (!monthDay) continue;
    rows[monthDay] = {
      tmax: parseNumber(item.tmax),
      tmin: parseNumber(item.tmin),
      tmed: parseNumber(item.tmed),
      prec: parseNumber(item.prec),
    };
  }

  const chunk = { fetchedAt: Date.now(), rows };
  try {
    await writeJsonAtomic(chunkFilePath(station, year, half), chunk);
  } catch (error) {
    logServerError("chunk.cache", error);
  }
  return chunk;
}

function requestChunk(station, year, half, priority) {
  const key = chunkKey(station, year, half);
  const existing = chunkTasks.get(key);
  if (existing) {
    if (priority === "high" && existing.priority === "low" && existing.status === "pending") {
      pendingLowChunks.splice(pendingLowChunks.indexOf(existing), 1);
      pendingHighChunks.push(existing);
      existing.priority = "high";
    }
    return existing;
  }

  const task = { key, station, year, half, priority, status: "pending" };
  task.promise = new Promise((resolve, reject) => {
    task.resolve = resolve;
    task.reject = reject;
  });
  task.promise.catch(() => {});

  chunkTasks.set(key, task);
  (priority === "high" ? pendingHighChunks : pendingLowChunks).push(task);
  runChunkWorker();
  return task;
}

async function getChunk(station, year, half, priority) {
  const cached = await readUsableChunk(station, year, half);
  return cached || requestChunk(station, year, half, priority).promise;
}

// Un unico trabajador secuencial: la cuota de AEMET es por clave, asi que paralelizar solo provoca 429.
async function runChunkWorker() {
  if (runningChunkTask) return;

  while (pendingHighChunks.length > 0 || pendingLowChunks.length > 0) {
    const task = pendingHighChunks.shift() || pendingLowChunks.shift();
    runningChunkTask = task;
    task.status = "running";
    const startedAt = Date.now();

    try {
      const chunk = await downloadChunk(task.station, task.year, task.half);
      task.status = "done";
      task.resolve(chunk);
    } catch (error) {
      logServerError(`chunk ${task.key}`, error);
      task.status = "failed";
      task.reject(error);
    } finally {
      chunkTasks.delete(task.key);
    }

    await wait(AEMET_REQUEST_DELAY_MS);
    averageChunkMs = averageChunkMs * 0.8 + (Date.now() - startedAt) * 0.2;
  }

  runningChunkTask = null;
}

function throttleRemainingMs() {
  return Math.max(0, aemetThrottledUntil - Date.now());
}

function metaFilePath(station) {
  return path.join(stationDir(station), "meta.json");
}

async function readStationMeta(station) {
  const stored = await findInMongo("station_meta", station);
  if (stored && stored.historyComplete) return stored;

  try {
    const meta = JSON.parse(await fs.readFile(metaFilePath(station), "utf8"));
    return meta && meta.historyComplete ? meta : null;
  } catch (_error) {
    return null;
  }
}

// Recorre la estacion hacia atras desde el ano actual hasta encontrar su primer registro.
async function scanStationHistory(station) {
  const state = stationScans.get(station);
  let foundData = false;
  let emptyStreak = 0;
  let firstYear = null;
  let lastYear = null;

  for (let year = currentYear(); year >= MIN_HISTORY_YEAR; year -= 1) {
    state.year = year;
    const halves = [1, 2].filter((half) => chunkHasStarted(year, half));
    const chunks = await Promise.all(halves.map((half) => getChunk(station, year, half, "low")));
    const hasData = chunks.some((chunk) => Object.keys(chunk.rows).length > 0);

    if (hasData) {
      foundData = true;
      emptyStreak = 0;
      firstYear = year;
      if (lastYear === null) lastYear = year;
    } else if (foundData) {
      emptyStreak += 1;
    }

    if (foundData && emptyStreak >= HISTORY_GAP_TOLERANCE_YEARS) break;
    if (!foundData && year <= DEFAULT_START_YEAR) break;
  }

  await writeJsonAtomic(metaFilePath(station), {
    historyComplete: true,
    firstYear,
    lastYear,
    scannedAt: Date.now(),
  });
}

function ensureStationScan(station) {
  if (stationScans.has(station)) return;
  stationScans.set(station, { year: currentYear(), startedAt: Date.now() });

  readStationMeta(station)
    .then((meta) => (meta ? null : scanStationHistory(station)))
    .catch((error) => logServerError(`scan ${station}`, error))
    .finally(() => stationScans.delete(station));
}

function getBackgroundDownloads() {
  return [...stationScans.entries()].map(([station, state]) => {
    const yearsToBaseline = Math.max(0, state.year - DEFAULT_START_YEAR);
    return {
      station,
      year: state.year,
      searchingOlder: state.year < DEFAULT_START_YEAR,
      etaSeconds: Math.ceil((yearsToBaseline * 2 * averageChunkMs + throttleRemainingMs()) / 1000),
    };
  });
}

function toCachedStation(station, meta) {
  return {
    station,
    historyComplete: Boolean(meta),
    firstYear: meta ? meta.firstYear : null,
    lastYear: meta ? meta.lastYear : null,
  };
}

async function listMongoStations() {
  try {
    const dbPromise = getMongoDb();
    if (!dbPromise) return [];
    const metas = await (await dbPromise).collection("station_meta").find({ historyComplete: true }).toArray();
    return metas.map((meta) => toCachedStation(meta._id, meta));
  } catch (error) {
    logServerError("mongo.station_meta", error);
    return [];
  }
}

// En Vercel no hay disco: las estaciones con datos son las de Atlas, mas las descargadas en local si las hay.
async function listCachedStations() {
  const byId = new Map((await listMongoStations()).map((item) => [item.station, item]));
  for (const item of await listLocalStations()) {
    if (!byId.has(item.station)) byId.set(item.station, item);
  }
  return [...byId.values()];
}

async function listLocalStations() {
  let entries = [];
  try {
    entries = await fs.readdir(STATION_CACHE_DIR, { withFileTypes: true });
  } catch (_error) {
    return [];
  }

  const stations = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => toCachedStation(entry.name, await readStationMeta(entry.name)))
  );
  return stations;
}

function shiftDays(year, month, day, offset) {
  const date = new Date(Date.UTC(year, Number(month) - 1, Number(day) + offset));
  const iso = date.toISOString().slice(0, 10);
  return {
    iso,
    year: date.getUTCFullYear(),
    half: date.getUTCMonth() < 6 ? 1 : 2,
    monthDay: iso.slice(5),
  };
}

// Para el 29 de febrero en anos no bisiestos la ventana se centra en el 1 de marzo.
function windowDays(year, month, day) {
  const days = [];
  for (let offset = -WINDOW_HALF_DAYS; offset <= WINDOW_HALF_DAYS; offset += 1) {
    days.push(shiftDays(year, month, day, offset));
  }
  return days;
}

function neededChunksForYear(year, month, day) {
  const today = todayISO();
  const needed = new Map();
  for (const date of windowDays(year, month, day)) {
    if (date.iso > today) continue;
    needed.set(`${date.year}_H${date.half}`, { year: date.year, half: date.half });
  }
  return [...needed.values()];
}

function meanOf(values) {
  return values.length ? values.reduce((acc, value) => acc + value, 0) / values.length : null;
}

function round1(value) {
  return value === null ? null : Math.round(value * 10) / 10;
}

function computeYearRow(year, month, day, chunkMap) {
  const today = todayISO();
  const samples = { tmax: [], tmin: [], tmed: [], prec: [] };
  let daysWithData = 0;

  for (const date of windowDays(year, month, day)) {
    if (date.iso > today) continue;
    const chunk = chunkMap.get(`${date.year}_H${date.half}`);
    const row = chunk && chunk.rows[date.monthDay];
    if (!row) continue;
    daysWithData += 1;
    for (const field of Object.keys(samples)) {
      if (row[field] !== null && row[field] !== undefined) samples[field].push(row[field]);
    }
  }

  const windowValue = (field) => (samples[field].length >= MIN_WINDOW_DAYS ? round1(meanOf(samples[field])) : null);

  let exactDay = null;
  if (isValidDateParts(year, month, day)) {
    const chunk = chunkMap.get(`${year}_H${halfOfMonth(month)}`);
    const row = chunk && chunk.rows[`${month}-${day}`];
    if (row) exactDay = { tmax: row.tmax, tmin: row.tmin, tmed: row.tmed, prec: row.prec };
  }

  return {
    year,
    tmax: windowValue("tmax"),
    tmin: windowValue("tmin"),
    tmed: windowValue("tmed"),
    prec: samples.prec.length >= MIN_WINDOW_DAYS ? Math.round(meanOf(samples.prec) * 100) / 100 : null,
    daysWithData,
    day: exactDay,
  };
}

function rowHasData(row) {
  return row.tmax !== null || row.tmin !== null || row.tmed !== null || row.prec !== null;
}

function buildSeries(job) {
  const data = [];
  for (let year = job.startYear; year <= job.endYear; year += 1) {
    data.push(computeYearRow(year, job.month, job.day, job.chunkMap));
  }
  return { data, yearsWithAnyData: data.filter(rowHasData).length };
}

async function planEvolution({ station, month, day, forceRefresh }) {
  const meta = await readStationMeta(station);
  const startYear = meta && meta.firstYear ? meta.firstYear : DEFAULT_START_YEAR;
  const endYear = currentYear();
  const neededByKey = new Map();

  for (let year = startYear; year <= endYear; year += 1) {
    for (const chunkRef of neededChunksForYear(year, month, day)) {
      neededByKey.set(`${chunkRef.year}_H${chunkRef.half}`, chunkRef);
    }
  }

  const chunkMap = new Map();
  const missing = [];
  await Promise.all(
    [...neededByKey.entries()].map(async ([key, { year, half }]) => {
      const chunk = forceRefresh ? null : await readUsableChunk(station, year, half);
      if (chunk) chunkMap.set(key, chunk);
      else missing.push({ key, year, half });
    })
  );

  missing.sort((a, b) => b.year - a.year || b.half - a.half);
  return { meta, startYear, endYear, chunkMap, missing };
}

function buildEvolutionResult(job, cacheHit) {
  const { data, yearsWithAnyData } = buildSeries(job);
  return {
    station: job.station,
    month: job.month,
    day: job.day,
    startYear: job.startYear,
    endYear: job.endYear,
    windowHalfDays: WINDOW_HALF_DAYS,
    totalYears: data.length,
    yearsWithAnyData,
    failedYears: [...new Set(job.failedChunks.map((chunk) => chunk.year))].sort((a, b) => a - b),
    history: {
      complete: Boolean(job.meta),
      firstYear: job.meta ? job.meta.firstYear : null,
      lastYear: job.meta ? job.meta.lastYear : null,
      scanning: stationScans.has(job.station),
    },
    data,
    cache: { hit: cacheHit },
  };
}

function startEvolutionJob(params, plan) {
  pruneOldEvolutionJobs();
  const key = buildEvolutionJobKey(params.station, params.month, params.day, params.forceRefresh);
  const existingJob = [...evolutionJobs.values()].find((job) => job.key === key && job.status === "running");
  if (existingJob) {
    return existingJob;
  }

  const job = {
    id: createEvolutionJobId(),
    key,
    ...params,
    meta: plan.meta,
    startYear: plan.startYear,
    endYear: plan.endYear,
    status: "running",
    createdAt: Date.now(),
    finishedAt: null,
    chunkMap: plan.chunkMap,
    failedChunks: [],
    progress: { completed: 0, total: plan.missing.length },
    tasks: plan.missing.map((chunkRef) => ({
      ...chunkRef,
      task: requestChunk(params.station, chunkRef.year, chunkRef.half, "high"),
    })),
    result: null,
    error: null,
  };

  job.done = Promise.all(
    job.tasks.map(({ key: mapKey, year, half, task }) =>
      task.promise
        .then(
          (chunk) => {
            job.chunkMap.set(mapKey, chunk);
          },
          () => {
            job.failedChunks.push({ year, half });
          }
        )
        .finally(() => {
          job.progress.completed += 1;
        })
    )
  )
    .then(() => {
      if (!job.meta) ensureStationScan(job.station);
      job.result = buildEvolutionResult(job, false);
      job.status = "done";
    })
    .catch((error) => {
      logServerError("evolution.job", error);
      job.error = "No se pudo completar la consulta en segundo plano";
      job.status = "failed";
    })
    .finally(() => {
      job.finishedAt = Date.now();
    });

  evolutionJobs.set(job.id, job);
  return job;
}

function estimateJobWait(job) {
  const ownPending = new Set(
    job.tasks.map(({ task }) => task).filter((task) => task.status === "pending" || task.status === "running")
  );
  if (ownPending.size === 0) {
    return { etaMs: 0, chunksAhead: 0 };
  }

  let lastIndex = -1;
  pendingHighChunks.forEach((task, index) => {
    if (ownPending.has(task)) lastIndex = index;
  });

  const remaining = lastIndex + 1 + (runningChunkTask ? 1 : 0);
  return {
    etaMs: remaining * averageChunkMs + throttleRemainingMs(),
    chunksAhead: Math.max(0, remaining - ownPending.size),
  };
}

function getEvolutionJobSnapshot(job) {
  const { completed, total } = job.progress;
  const isRunning = job.status === "running";
  const { etaMs, chunksAhead } = isRunning ? estimateJobWait(job) : { etaMs: 0, chunksAhead: 0 };
  const partial = isRunning ? buildSeries(job) : null;

  return {
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    progress: {
      completed,
      total,
      percent: total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 100,
      etaSeconds: Math.ceil(etaMs / 1000),
      chunksAhead,
      throttledSeconds: Math.ceil(throttleRemainingMs() / 1000),
      yearsWithAnyData: partial ? partial.yearsWithAnyData : 0,
      failedChunksCount: job.failedChunks.length,
    },
    partial: partial ? { startYear: job.startYear, endYear: job.endYear, data: partial.data } : undefined,
    result: job.status === "done" ? job.result : undefined,
    error: job.status === "failed" ? job.error : undefined,
  };
}

function parseEvolutionQuery(req) {
  const station = String(req.query.station || "").trim().toUpperCase();
  const month = String(req.query.month || "").padStart(2, "0");
  const day = String(req.query.day || "").padStart(2, "0");
  const forceRefresh = String(req.query.refresh || "").trim() === "1";

  if (!station) {
    throw safeApiError("Debes indicar una estacion", 400);
  }

  if (!/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) {
    throw safeApiError("Mes y dia no validos", 400);
  }

  if (!isValidStationId(station)) {
    throw safeApiError("Identificador de estacion no valido", 400);
  }

  if (!isValidDateParts(2000, month, day)) {
    throw safeApiError("Fecha no valida", 400);
  }

  if (forceRefresh) {
    const providedRefreshSecret = String(req.query.refreshSecret || "").trim();
    if (!refreshSecret || providedRefreshSecret !== refreshSecret) {
      throw safeApiError("No autorizado para forzar recarga", 403);
    }
  }

  return { station, month, day, forceRefresh };
}

async function buildCachedResultIfComplete(params) {
  const plan = await planEvolution(params);
  if (plan.missing.length > 0) {
    return { plan, result: null };
  }

  if (!plan.meta) ensureStationScan(params.station);
  const job = { ...params, meta: plan.meta, startYear: plan.startYear, endYear: plan.endYear, chunkMap: plan.chunkMap, failedChunks: [] };
  return { plan, result: buildEvolutionResult(job, true) };
}

app.get("/api/stations", async (_req, res) => {
  try {
    if (!AEMET_API_KEY) {
      return res.status(500).json({ error: "Falta configurar AEMET_API_KEY en .env" });
    }

    const stored = await findInMongo("inventory", "stations");
    if (stored && Array.isArray(stored.payload) && stored.payload.length > 0) {
      // El inventario casi no cambia: la CDN de Vercel lo sirve un dia sin llegar al servidor.
      res.set("Cache-Control", "public, s-maxage=86400, stale-while-revalidate=604800");
      return res.json(stored.payload);
    }

    const warmCache = await readStationsCache();
    if (warmCache) {
      return res.json(warmCache.payload);
    }

    const rawStations = await fetchAemetDataWithRetry(
      "/api/valores/climatologicos/inventarioestaciones/todasestaciones/",
      3
    );

    const stations = rawStations
      .map((station) => ({
        idema: station.indicativo,
        nombre: station.nombre,
        provincia: station.provincia,
        altitud: parseNumber(station.altitud),
        latitud: station.latitud,
        longitud: station.longitud,
      }))
      .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

    try {
      await writeStationsCache(stations);
    } catch (_cacheError) {
      // Si la cache falla, la API sigue devolviendo datos normalmente.
    }

    res.json(stations);
  } catch (error) {
    logServerError("api.stations", error);
    const staleCache = await readStationsCache({ allowExpired: true });
    if (staleCache) {
      return res.json(staleCache.payload);
    }

    res.status(500).json({ error: "Error consultando estaciones" });
  }
});

app.get("/api/stations/cached", async (_req, res) => {
  try {
    res.json({ stations: await listCachedStations() });
  } catch (error) {
    logServerError("api.stations.cached", error);
    res.status(500).json({ error: "Error listando estaciones descargadas" });
  }
});

app.get("/api/evolution/jobs/enqueue", evolutionEnqueueLimiter, async (req, res) => {
  try {
    if (!AEMET_API_KEY) {
      return res.status(500).json({ error: "Falta configurar AEMET_API_KEY en .env" });
    }

    const params = parseEvolutionQuery(req);
    const { plan, result } = await buildCachedResultIfComplete(params);
    if (result) {
      return res.json({ status: "done", fromCache: true, result });
    }

    const job = startEvolutionJob(params, plan);
    return res.status(202).json(getEvolutionJobSnapshot(job));
  } catch (error) {
    logServerError("api.evolution.enqueue", error);
    const statusCode = Number.isInteger(error && error.statusCode) ? error.statusCode : 500;
    const clientMessage = redactErrorForClient(error, "Error encolando evolucion");
    return res.status(statusCode).json({ error: clientMessage });
  }
});

app.get("/api/evolution/jobs/:jobId", evolutionStatusLimiter, (req, res) => {
  try {
    const jobId = String(req.params.jobId || "").trim();
    if (!jobId) {
      throw safeApiError("Falta jobId", 400);
    }

    pruneOldEvolutionJobs();
    const job = evolutionJobs.get(jobId);
    if (!job) {
      throw safeApiError("Trabajo no encontrado o expirado", 404);
    }

    return res.json(getEvolutionJobSnapshot(job));
  } catch (error) {
    logServerError("api.evolution.jobStatus", error);
    const statusCode = Number.isInteger(error && error.statusCode) ? error.statusCode : 500;
    const clientMessage = redactErrorForClient(error, "Error consultando el estado del trabajo");
    return res.status(statusCode).json({ error: clientMessage });
  }
});

app.get("/api/background", evolutionStatusLimiter, (_req, res) => {
  res.json({ downloads: getBackgroundDownloads() });
});

app.get("/api/evolution", evolutionLimiter, async (req, res) => {
  try {
    if (!AEMET_API_KEY) {
      return res.status(500).json({ error: "Falta configurar AEMET_API_KEY en .env" });
    }

    const params = parseEvolutionQuery(req);
    const { plan, result } = await buildCachedResultIfComplete(params);
    if (result) {
      return res.json(result);
    }

    const job = startEvolutionJob(params, plan);
    await job.done;
    if (job.status !== "done") {
      throw new Error(job.error || "Error consultando evolucion");
    }
    res.json(job.result);
  } catch (error) {
    logServerError("api.evolution", error);
    const statusCode = Number.isInteger(error && error.statusCode) ? error.statusCode : 500;
    const clientMessage = redactErrorForClient(error, "Error consultando evolucion");
    res.status(statusCode).json({ error: clientMessage });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
});

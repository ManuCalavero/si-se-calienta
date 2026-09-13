require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const path = require("path");
const fs = require("fs/promises");

const app = express();
const PORT = process.env.PORT || 3000;
const AEMET_API_KEY = process.env.AEMET_API_KEY;
const AEMET_BASE = "https://opendata.aemet.es/opendata";
const CACHE_DIR = path.join(__dirname, ".cache", "evolution");
const STATIONS_CACHE_FILE = path.join(__dirname, ".cache", "stations_inventory.json");
const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS || "720");
const CACHE_TTL_MS =
  Number.isFinite(CACHE_TTL_HOURS) && CACHE_TTL_HOURS > 0
    ? CACHE_TTL_HOURS * 60 * 60 * 1000
    : 720 * 60 * 60 * 1000;
const STATIONS_CACHE_TTL_HOURS = Number(process.env.STATIONS_CACHE_TTL_HOURS || "720");
const STATIONS_CACHE_TTL_MS =
  Number.isFinite(STATIONS_CACHE_TTL_HOURS) && STATIONS_CACHE_TTL_HOURS > 0
    ? STATIONS_CACHE_TTL_HOURS * 60 * 60 * 1000
    : 720 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS || "12000");
const MAX_STATION_ID_LENGTH = 16;
const EVOLUTION_QUEUE_CONCURRENCY = Math.max(1, Number(process.env.EVOLUTION_QUEUE_CONCURRENCY || "1"));
const EVOLUTION_JOB_RETENTION_MINUTES = Math.max(5, Number(process.env.EVOLUTION_JOB_RETENTION_MINUTES || "45"));
const EVOLUTION_JOB_RETENTION_MS = EVOLUTION_JOB_RETENTION_MINUTES * 60 * 1000;
const EVOLUTION_PER_YEAR_DELAY_MS = Math.max(300, Number(process.env.EVOLUTION_PER_YEAR_DELAY_MS || "1000"));
const EVOLUTION_RETRY_ROUND_COOLDOWN_MS = Math.max(
  1000,
  Number(process.env.EVOLUTION_RETRY_ROUND_COOLDOWN_MS || "5000")
);
const EVOLUTION_SYNC_LIMIT_PER_MIN = Math.max(4, Number(process.env.EVOLUTION_SYNC_LIMIT_PER_MIN || "12"));
const EVOLUTION_ENQUEUE_LIMIT_PER_MIN = Math.max(10, Number(process.env.EVOLUTION_ENQUEUE_LIMIT_PER_MIN || "40"));
const EVOLUTION_STATUS_LIMIT_PER_MIN = Math.max(60, Number(process.env.EVOLUTION_STATUS_LIMIT_PER_MIN || "240"));

const refreshSecret = String(process.env.REFRESH_SECRET || "").trim();
const evolutionJobs = new Map();
const evolutionQueue = [];
const queuedJobIds = new Set();
let activeEvolutionWorkers = 0;
let evolutionJobSequence = 0;

if (!AEMET_API_KEY) {
  console.warn("AEMET_API_KEY no esta definida. Crea un archivo .env a partir de .env.example");
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

app.use(baseLimiter);
app.use(express.static(path.join(__dirname, "public")));

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
    if (job.status === "queued" || job.status === "running") {
      continue;
    }

    const finishedAt = Number(job.finishedAt || 0);
    if (finishedAt <= 0) {
      continue;
    }

    if (now - finishedAt > EVOLUTION_JOB_RETENTION_MS) {
      evolutionJobs.delete(jobId);
      queuedJobIds.delete(jobId);
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

async function fetchAemetData(endpointPath) {
  const firstStepUrl = buildAemetUrl(endpointPath);
  const firstStepResponse = await fetch(firstStepUrl, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

  if (!firstStepResponse.ok) {
    const body = await firstStepResponse.text();
    const error = new Error(`Error AEMET (${firstStepResponse.status}): ${body}`);
    error.status = firstStepResponse.status;
    const retryAfter = Number(firstStepResponse.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      error.retryAfterMs = retryAfter * 1000;
    }
    throw error;
  }

  const firstStepJson = await firstStepResponse.json();

  if (!firstStepJson.datos) {
    throw new Error(firstStepJson.descripcion || "AEMET no devolvio URL de datos");
  }

  const dataResponse = await fetch(firstStepJson.datos, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!dataResponse.ok) {
    const body = await dataResponse.text();
    const error = new Error(`Error descargando datos AEMET (${dataResponse.status}): ${body}`);
    error.status = dataResponse.status;
    const retryAfter = Number(dataResponse.headers.get("retry-after"));
    if (Number.isFinite(retryAfter) && retryAfter > 0) {
      error.retryAfterMs = retryAfter * 1000;
    }
    throw error;
  }

  return dataResponse.json();
}

async function fetchAemetDataWithRetry(endpointPath, maxRetries = 8) {
  let attempt = 0;

  while (attempt <= maxRetries) {
    try {
      return await fetchAemetData(endpointPath);
    } catch (error) {
      const isRateLimited = error && (error.status === 429 || /429/.test(error.message || ""));
      if (!isRateLimited || attempt === maxRetries) {
        throw error;
      }

      const backoffMs = error.retryAfterMs || 2000 * 2 ** attempt;
      await wait(backoffMs);
      attempt += 1;
    }
  }

  throw new Error("No se pudo obtener respuesta de AEMET tras varios intentos");
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

async function writeStationsCache(payload) {
  const tmpFile = `${STATIONS_CACHE_FILE}.tmp`;
  await fs.mkdir(path.dirname(STATIONS_CACHE_FILE), { recursive: true });
  const serialized = JSON.stringify(
    {
      createdAt: Date.now(),
      payload,
    },
    null,
    2
  );

  await fs.writeFile(tmpFile, serialized, "utf8");
  await fs.rename(tmpFile, STATIONS_CACHE_FILE);
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

function buildCacheFilePath(station, month, day) {
  const stationSafe = station.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(CACHE_DIR, `${stationSafe}_${month}_${day}.json`);
}

async function readEvolutionCache(station, month, day) {
  const cacheFile = buildCacheFilePath(station, month, day);

  try {
    const raw = await fs.readFile(cacheFile, "utf8");
    const cached = JSON.parse(raw);
    if (!cached || typeof cached !== "object") return null;

    const createdAt = Number(cached.createdAt || 0);
    if (!Number.isFinite(createdAt) || createdAt <= 0) return null;

    if (Date.now() - createdAt > CACHE_TTL_MS) {
      return null;
    }

    const payload = cached.payload;
    if (!payload || !Array.isArray(payload.data)) return null;

    const currentYear = new Date().getFullYear();
    if (payload.endYear < currentYear) {
      return null;
    }

    const todayISO = new Date().toISOString().slice(0, 10);
    const targetDateISO = `${currentYear}-${month}-${day}`;

    if (targetDateISO <= todayISO) {
      const currentYearRow = payload.data.find((row) => row.year === currentYear);
      if (
        !currentYearRow ||
        (currentYearRow.tmax === null &&
          currentYearRow.tmin === null &&
          currentYearRow.tmed === null &&
          currentYearRow.prec === null)
      ) {
        return null;
      }
    }

    return {
      createdAt,
      payload,
    };
  } catch (_error) {
    return null;
  }
}

async function writeEvolutionCache(station, month, day, payload) {
  const cacheFile = buildCacheFilePath(station, month, day);
  const tmpFile = `${cacheFile}.tmp`;

  await fs.mkdir(CACHE_DIR, { recursive: true });
  const serialized = JSON.stringify(
    {
      createdAt: Date.now(),
      payload,
    },
    null,
    2
  );

  await fs.writeFile(tmpFile, serialized, "utf8");
  await fs.rename(tmpFile, cacheFile);
}

async function fetchDailyClimateRow({ station, month, day, year }) {
  const startDate = `${year}-${month}-${day}T00:00:00UTC`;
  const endDate = `${year}-${month}-${day}T23:59:59UTC`;
  const endpointPath = `/api/valores/climatologicos/diarios/datos/fechaini/${startDate}/fechafin/${endDate}/estacion/${encodeURIComponent(station)}`;
  const rawData = await fetchAemetDataWithRetry(endpointPath, 8);

  if (!Array.isArray(rawData) || rawData.length === 0) {
    return null;
  }

  const row = rawData.find((item) => monthDayFromFecha(item.fecha) === `${month}-${day}`) || rawData[0];
  if (!row) {
    return null;
  }

  return {
    tmax: parseNumber(row.tmax),
    tmin: parseNumber(row.tmin),
    tmed: parseNumber(row.tmed),
    prec: parseNumber(row.prec),
  };
}

async function buildEvolutionPayload({ station, month, day, startYear = 1976, endYear = new Date().getFullYear(), onProgress }) {
  const byYear = new Map();
  const failedYears = [];
  const firstPassFailedYears = [];

  const validYears = [];
  for (let year = startYear; year <= endYear; year += 1) {
    if (isValidDateParts(year, month, day)) {
      validYears.push(year);
    }
  }

  for (let index = 0; index < validYears.length; index += 1) {
    const year = validYears[index];
    try {
      const parsed = await fetchDailyClimateRow({ station, month, day, year });
      if (parsed) {
        byYear.set(year, {
          year,
          ...parsed,
        });
      }
    } catch (error) {
      firstPassFailedYears.push({
        year,
        reason: error && error.status ? `HTTP ${error.status}` : "request_failed",
      });
    }

    if (typeof onProgress === "function") {
      onProgress({
        completed: index + 1,
        total: validYears.length,
        yearsWithAnyData: byYear.size,
        failedYearsCount: firstPassFailedYears.length,
      });
    }

    await wait(EVOLUTION_PER_YEAR_DELAY_MS);
  }

  if (firstPassFailedYears.length > 0) {
    await wait(EVOLUTION_RETRY_ROUND_COOLDOWN_MS);
    for (const failed of firstPassFailedYears) {
      try {
        const parsed = await fetchDailyClimateRow({ station, month, day, year: failed.year });
        if (parsed) {
          byYear.set(failed.year, {
            year: failed.year,
            ...parsed,
          });
        }
      } catch (error) {
        failedYears.push({
          year: failed.year,
          reason: error && error.status ? `HTTP ${error.status}` : failed.reason,
        });
      }
      await wait(EVOLUTION_PER_YEAR_DELAY_MS);
    }
  }

  const series = [];
  for (let year = startYear; year <= endYear; year += 1) {
    series.push(
      byYear.get(year) || {
        year,
        tmax: null,
        tmin: null,
        tmed: null,
        prec: null,
      }
    );
  }

  const yearsWithAnyData = series.filter(
    (row) => row.tmax !== null || row.tmin !== null || row.tmed !== null || row.prec !== null
  ).length;

  return {
    station,
    month,
    day,
    startYear,
    endYear,
    totalYears: series.length,
    yearsWithAnyData,
    failedYears,
    data: series,
    cache: {
      hit: false,
      ttlHours: CACHE_TTL_MS / (1000 * 60 * 60),
    },
  };
}

async function processEvolutionJob(job) {
  job.status = "running";
  job.startedAt = Date.now();

  try {
    const payload = await buildEvolutionPayload({
      station: job.station,
      month: job.month,
      day: job.day,
      startYear: job.startYear,
      endYear: job.endYear,
      onProgress: (progress) => {
        job.progress = {
          completed: progress.completed,
          total: progress.total,
          yearsWithAnyData: progress.yearsWithAnyData,
          failedYearsCount: progress.failedYearsCount,
        };
      },
    });

    try {
      await writeEvolutionCache(job.station, job.month, job.day, payload);
    } catch (_cacheError) {
      // Si la cache falla, el trabajo sigue considerandose completado.
    }

    job.result = payload;
    job.status = "done";
  } catch (error) {
    logServerError("evolution.job", error);
    job.error = "No se pudo completar la consulta en segundo plano";
    job.status = "failed";
  } finally {
    job.finishedAt = Date.now();
    queuedJobIds.delete(job.id);
  }
}

function consumeEvolutionQueue() {
  while (activeEvolutionWorkers < EVOLUTION_QUEUE_CONCURRENCY && evolutionQueue.length > 0) {
    const nextJobId = evolutionQueue.shift();
    if (!nextJobId) {
      continue;
    }

    const job = evolutionJobs.get(nextJobId);
    if (!job || job.status !== "queued") {
      queuedJobIds.delete(nextJobId);
      continue;
    }

    activeEvolutionWorkers += 1;
    processEvolutionJob(job)
      .catch((error) => {
        logServerError("evolution.queue", error);
      })
      .finally(() => {
        activeEvolutionWorkers = Math.max(0, activeEvolutionWorkers - 1);
        pruneOldEvolutionJobs();
        consumeEvolutionQueue();
      });
  }
}

function enqueueEvolutionJob({ station, month, day, forceRefresh, startYear = 1976, endYear = new Date().getFullYear() }) {
  pruneOldEvolutionJobs();
  const key = buildEvolutionJobKey(station, month, day, forceRefresh);
  const existingJob = [...evolutionJobs.values()].find(
    (job) => job.key === key && (job.status === "queued" || job.status === "running")
  );

  if (existingJob) {
    return existingJob;
  }

  const jobId = createEvolutionJobId();
  const job = {
    id: jobId,
    key,
    station,
    month,
    day,
    forceRefresh,
    startYear,
    endYear,
    status: "queued",
    createdAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    progress: {
      completed: 0,
      total: endYear - startYear + 1,
      yearsWithAnyData: 0,
      failedYearsCount: 0,
    },
    result: null,
    error: null,
  };

  evolutionJobs.set(jobId, job);
  if (!queuedJobIds.has(jobId)) {
    queuedJobIds.add(jobId);
    evolutionQueue.push(jobId);
  }

  consumeEvolutionQueue();
  return job;
}

function getEvolutionJobSnapshot(job) {
  const queuePosition =
    job.status === "queued" ? Math.max(1, evolutionQueue.findIndex((id) => id === job.id) + 1) : 0;
  const completed = Number(job.progress && job.progress.completed ? job.progress.completed : 0);
  const total = Number(job.progress && job.progress.total ? job.progress.total : 0);
  const percent = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;

  return {
    jobId: job.id,
    status: job.status,
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    queuePosition,
    progress: {
      completed,
      total,
      percent,
      yearsWithAnyData: Number(job.progress && job.progress.yearsWithAnyData ? job.progress.yearsWithAnyData : 0),
      failedYearsCount: Number(job.progress && job.progress.failedYearsCount ? job.progress.failedYearsCount : 0),
    },
    result: job.status === "done" ? job.result : undefined,
    error: job.status === "failed" ? job.error : undefined,
  };
}

function parseEvolutionQuery(req) {
  const station = String(req.query.station || "").trim().toUpperCase();
  const month = String(req.query.month || "").padStart(2, "0");
  const day = String(req.query.day || "").padStart(2, "0");
  const forceRefresh = String(req.query.refresh || "").trim() === "1";
  const startYear = 1976;
  const endYear = new Date().getFullYear();

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

  return {
    station,
    month,
    day,
    forceRefresh,
    startYear,
    endYear,
  };
}

app.get("/api/stations", async (_req, res) => {
  try {
    if (!AEMET_API_KEY) {
      return res.status(500).json({ error: "Falta configurar AEMET_API_KEY en .env" });
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

app.get("/api/evolution/jobs/enqueue", evolutionEnqueueLimiter, async (req, res) => {
  try {
    if (!AEMET_API_KEY) {
      return res.status(500).json({ error: "Falta configurar AEMET_API_KEY en .env" });
    }

    const params = parseEvolutionQuery(req);

    if (!params.forceRefresh) {
      const cached = await readEvolutionCache(params.station, params.month, params.day);
      if (cached && cached.payload) {
        return res.json({
          status: "done",
          fromCache: true,
          result: {
            ...cached.payload,
            cache: {
              hit: true,
              createdAt: cached.createdAt,
              ttlHours: CACHE_TTL_MS / (1000 * 60 * 60),
            },
          },
        });
      }
    }

    const job = enqueueEvolutionJob(params);
    const snapshot = getEvolutionJobSnapshot(job);
    return res.status(202).json({
      status: snapshot.status,
      jobId: snapshot.jobId,
      queuePosition: snapshot.queuePosition,
      progress: snapshot.progress,
    });
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

app.get("/api/evolution", evolutionLimiter, async (req, res) => {
  try {
    if (!AEMET_API_KEY) {
      return res.status(500).json({ error: "Falta configurar AEMET_API_KEY en .env" });
    }

    const { station, month, day, forceRefresh, startYear, endYear } = parseEvolutionQuery(req);

    if (!forceRefresh) {
      const cached = await readEvolutionCache(station, month, day);
      if (cached && cached.payload) {
        return res.json({
          ...cached.payload,
          cache: {
            hit: true,
            createdAt: cached.createdAt,
            ttlHours: CACHE_TTL_MS / (1000 * 60 * 60),
          },
        });
      }
    }

    const responsePayload = await buildEvolutionPayload({
      station,
      month,
      day,
      startYear,
      endYear,
    });

    try {
      await writeEvolutionCache(station, month, day, responsePayload);
    } catch (_cacheError) {
      // Si la cache falla, la API sigue devolviendo datos normalmente.
    }

    res.json(responsePayload);
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

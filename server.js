require("dotenv").config();
const express = require("express");
const path = require("path");
const fs = require("fs/promises");

const app = express();
const PORT = process.env.PORT || 3000;
const AEMET_API_KEY = process.env.AEMET_API_KEY;
const AEMET_BASE = "https://opendata.aemet.es/opendata";
const CACHE_DIR = path.join(__dirname, ".cache", "evolution");
const CACHE_TTL_HOURS = Number(process.env.CACHE_TTL_HOURS || "720");
const CACHE_TTL_MS =
  Number.isFinite(CACHE_TTL_HOURS) && CACHE_TTL_HOURS > 0
    ? CACHE_TTL_HOURS * 60 * 60 * 1000
    : 720 * 60 * 60 * 1000;

if (!AEMET_API_KEY) {
  console.warn("AEMET_API_KEY no esta definida. Crea un archivo .env a partir de .env.example");
}

app.use(express.static(path.join(__dirname, "public")));

function buildAemetUrl(endpointPath) {
  const separator = endpointPath.includes("?") ? "&" : "?";
  return `${AEMET_BASE}${endpointPath}${separator}api_key=${encodeURIComponent(AEMET_API_KEY || "")}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchAemetData(endpointPath) {
  const firstStepUrl = buildAemetUrl(endpointPath);
  const firstStepResponse = await fetch(firstStepUrl);

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

  const dataResponse = await fetch(firstStepJson.datos);
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

    return {
      createdAt,
      payload: cached.payload,
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

app.get("/api/stations", async (_req, res) => {
  try {
    if (!AEMET_API_KEY) {
      return res.status(500).json({ error: "Falta configurar AEMET_API_KEY en .env" });
    }

    const rawStations = await fetchAemetData("/api/valores/climatologicos/inventarioestaciones/todasestaciones/");

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

    res.json(stations);
  } catch (error) {
    res.status(500).json({ error: error.message || "Error consultando estaciones" });
  }
});

app.get("/api/evolution", async (req, res) => {
  try {
    if (!AEMET_API_KEY) {
      return res.status(500).json({ error: "Falta configurar AEMET_API_KEY en .env" });
    }

    const station = String(req.query.station || "").trim().toUpperCase();
    const month = String(req.query.month || "").padStart(2, "0");
    const day = String(req.query.day || "").padStart(2, "0");
    const forceRefresh = String(req.query.refresh || "").trim() === "1";
    const startYear = 1976;
    const endYear = 2026;

    if (!station) {
      return res.status(400).json({ error: "Debes indicar una estacion" });
    }

    if (!/^\d{2}$/.test(month) || !/^\d{2}$/.test(day)) {
      return res.status(400).json({ error: "Mes y dia no validos" });
    }

    const byYear = new Map();
    const failedYears = [];

    if (!isValidDateParts(2000, month, day)) {
      return res.status(400).json({ error: "Fecha no valida" });
    }

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

    const validYears = [];
    for (let year = startYear; year <= endYear; year += 1) {
      if (isValidDateParts(year, month, day)) {
        validYears.push(year);
      }
    }

    for (const year of validYears) {
      const startDate = `${year}-${month}-${day}T00:00:00UTC`;
      const endDate = `${year}-${month}-${day}T23:59:59UTC`;
      const endpointPath = `/api/valores/climatologicos/diarios/datos/fechaini/${startDate}/fechafin/${endDate}/estacion/${encodeURIComponent(station)}`;

      try {
        const rawData = await fetchAemetDataWithRetry(endpointPath, 8);
        if (!Array.isArray(rawData) || rawData.length === 0) {
          continue;
        }

        const row = rawData.find((item) => monthDayFromFecha(item.fecha) === `${month}-${day}`) || rawData[0];
        if (!row) {
          continue;
        }

        byYear.set(year, {
          year,
          tmax: parseNumber(row.tmax),
          tmin: parseNumber(row.tmin),
          tmed: parseNumber(row.tmed),
          prec: parseNumber(row.prec),
        });
      } catch (error) {
        failedYears.push({
          year,
          reason: error && error.status ? `HTTP ${error.status}` : "request_failed",
        });
      }

      // Suaviza la frecuencia de llamadas para evitar bloqueos por cuota.
      await wait(900);
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

    const responsePayload = {
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

    try {
      await writeEvolutionCache(station, month, day, responsePayload);
    } catch (_cacheError) {
      // Si la cache falla, la API sigue devolviendo datos normalmente.
    }

    res.json(responsePayload);
  } catch (error) {
    res.status(500).json({ error: error.message || "Error consultando evolucion" });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor listo en http://localhost:${PORT}`);
});

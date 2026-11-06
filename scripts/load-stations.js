// Carga en Atlas el historico completo de estaciones nuevas, directamente desde AEMET.
// Uso: node scripts/load-stations.js lista.csv        (primera columna = indicativo, con cabecera)
//      node scripts/load-stations.js 9657X 5051X ...
// Se puede cortar y relanzar: se saltan las estaciones ya completas y los bloques ya guardados.
require("dotenv").config({ quiet: true });
const fs = require("fs");
const { MongoClient } = require("mongodb");

const AEMET_BASE = "https://opendata.aemet.es/opendata";
const MONGODB_DB = process.env.MONGODB_DB || "si_se_calienta";
const FETCH_TIMEOUT_MS = 30000;
const REQUEST_DELAY_MS = 1200;
// Mismas reglas que el servidor (server.js, scanStationHistory).
const MIN_HISTORY_YEAR = 1920;
const DEFAULT_START_YEAR = 1976;
const HISTORY_GAP_TOLERANCE_YEARS = 5;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

function parseNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(String(value).replace(",", ".").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

async function readAemetJson(response) {
  const charsetMatch = String(response.headers.get("content-type") || "").match(/charset=([^;]+)/i);
  const buffer = await response.arrayBuffer();
  try {
    return JSON.parse(new TextDecoder(charsetMatch ? charsetMatch[1].trim().toLowerCase() : "utf-8").decode(buffer));
  } catch (_error) {
    return JSON.parse(new TextDecoder("latin1").decode(buffer));
  }
}

async function fetchAemetOnce(endpointPath) {
  const url = `${AEMET_BASE}${endpointPath}?api_key=${encodeURIComponent(process.env.AEMET_API_KEY)}`;
  const first = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (first.status === 401) throw Object.assign(new Error("AEMET rechaza la clave"), { fatal: true });
  if (!first.ok) throw Object.assign(new Error(`AEMET HTTP ${first.status}`), { status: first.status });

  const firstJson = await first.json();
  const estado = Number(firstJson.estado);
  if (estado === 404) return [];
  if (estado === 401) throw Object.assign(new Error("AEMET rechaza la clave"), { fatal: true });
  if (!firstJson.datos) throw Object.assign(new Error(firstJson.descripcion || "AEMET sin URL de datos"), { status: estado });

  const data = await fetch(firstJson.datos, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!data.ok) throw Object.assign(new Error(`AEMET datos HTTP ${data.status}`), { status: data.status });
  return readAemetJson(data);
}

async function fetchAemet(endpointPath) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fetchAemetOnce(endpointPath);
    } catch (error) {
      if (error.fatal || attempt >= 6) throw error;
      await wait(Math.min(5000 * 2 ** attempt, 120000));
    }
  }
}

function chunkRange(year, half) {
  return half === 1 ? [`${year}-01-01`, `${year}-06-30`] : [`${year}-07-01`, `${year}-12-31`];
}

async function getChunkRows(db, station, year, half) {
  const _id = `${station}_${year}_H${half}`;
  const stored = await db.collection("chunks").findOne({ _id }, { projection: { rows: 1 } });
  if (stored && stored.rows) return stored.rows;

  const today = new Date().toISOString().slice(0, 10);
  const [start, end] = chunkRange(year, half);
  const raw = await fetchAemet(
    `/api/valores/climatologicos/diarios/datos/fechaini/${start}T00:00:00UTC/fechafin/${end > today ? today : end}T23:59:59UTC/estacion/${encodeURIComponent(station)}`
  );
  await wait(REQUEST_DELAY_MS);

  const rows = {};
  for (const item of Array.isArray(raw) ? raw : []) {
    const parts = typeof item.fecha === "string" ? item.fecha.split("-") : [];
    if (parts.length !== 3) continue;
    rows[`${parts[1]}-${parts[2]}`] = {
      tmax: parseNumber(item.tmax),
      tmin: parseNumber(item.tmin),
      tmed: parseNumber(item.tmed),
      prec: parseNumber(item.prec),
    };
  }

  if (Object.keys(rows).length > 0) {
    await db
      .collection("chunks")
      .replaceOne({ _id }, { station, year, half, fetchedAt: Date.now(), rows }, { upsert: true });
  }
  return rows;
}

async function loadStation(db, station) {
  const today = new Date().toISOString().slice(0, 10);
  let foundData = false;
  let emptyStreak = 0;
  let firstYear = null;
  let lastYear = null;
  let chunks = 0;

  for (let year = new Date().getUTCFullYear(); year >= MIN_HISTORY_YEAR; year -= 1) {
    let hasData = false;
    for (const half of [1, 2]) {
      if (chunkRange(year, half)[0] > today) continue;
      const rows = await getChunkRows(db, station, year, half);
      if (Object.keys(rows).length > 0) {
        hasData = true;
        chunks += 1;
      }
    }

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

  if (!foundData) return { station, chunks: 0, firstYear: null, lastYear: null };
  await db
    .collection("station_meta")
    .replaceOne({ _id: station }, { historyComplete: true, firstYear, lastYear, scannedAt: Date.now() }, { upsert: true });
  return { station, chunks, firstYear, lastYear };
}

function readStationList(args) {
  if (args.length === 1 && /\.(csv|txt)$/i.test(args[0])) {
    return fs
      .readFileSync(args[0], "utf8")
      .split(/\r?\n/)
      .slice(1)
      .map((line) => line.split(",")[0]);
  }
  return args;
}

async function main() {
  if (!process.env.AEMET_API_KEY) throw new Error("Falta AEMET_API_KEY");
  if (!process.env.MONGODB_URI_WRITE) throw new Error("Falta MONGODB_URI_WRITE");
  const requested = [...new Set(readStationList(process.argv.slice(2)).map((id) => id.trim().toUpperCase()).filter(Boolean))];
  if (requested.length === 0) throw new Error("Indica una lista (csv) o indicativos");

  const client = new MongoClient(process.env.MONGODB_URI_WRITE);
  await client.connect();
  try {
    const db = client.db(MONGODB_DB);
    const done = new Set(
      (await db.collection("station_meta").find({ historyComplete: true }, { projection: { _id: 1 } }).toArray()).map((m) => m._id)
    );
    const pending = requested.filter((id) => !done.has(id));
    console.log(`[${stamp()}] ${requested.length} indicadas, ${requested.length - pending.length} ya completas, ${pending.length} por cargar`);

    const startedAt = Date.now();
    const failed = [];
    const empty = [];
    for (const [index, station] of pending.entries()) {
      try {
        const result = await loadStation(db, station);
        if (result.firstYear === null) {
          empty.push(station);
          console.log(`[${stamp()}] ${index + 1}/${pending.length} ${station}: SIN DATOS (no se marca como completa)`);
        } else {
          console.log(
            `[${stamp()}] ${index + 1}/${pending.length} ${station}: ${result.firstYear}-${result.lastYear}, ${result.chunks} bloques`
          );
        }
      } catch (error) {
        if (error.fatal) throw error;
        failed.push(station);
        console.log(`[${stamp()}] ${index + 1}/${pending.length} ${station}: ERROR ${error.message}`);
      }
    }

    const minutes = ((Date.now() - startedAt) / 60000).toFixed(0);
    console.log(
      `[${stamp()}] FIN en ${minutes} min. Cargadas ${pending.length - failed.length - empty.length}, sin datos ${empty.length} (${empty.join(" ")}), con error ${failed.length} (${failed.join(" ")})`
    );
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

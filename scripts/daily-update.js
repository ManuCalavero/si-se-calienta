// Actualiza en Atlas los datos recientes de todas las estaciones ya cargadas.
// Uso: node scripts/daily-update.js [4549Y ...]   (sin argumentos, todas las estaciones de station_meta)
require("dotenv").config({ quiet: true });
const { MongoClient } = require("mongodb");

const AEMET_BASE = "https://opendata.aemet.es/opendata";
const MONGODB_DB = process.env.MONGODB_DB || "si_se_calienta";
const FETCH_TIMEOUT_MS = 30000;
const REQUEST_DELAY_MS = 1500;
// AEMET corrige los datos de las ultimas semanas: al empezar un semestre se repasa tambien el anterior.
const RECHECK_PREVIOUS_HALF_DAYS = 35;
// Si falla mas de esta fraccion de estaciones, el job termina con error y GitHub avisa por email.
const MAX_FAILURE_RATIO = 0.2;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(String(value).replace(",", ".").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

// Los datos de AEMET vienen en ISO-8859-15; leerlos como UTF-8 rompe enes y tildes.
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
  if (first.status === 401) throw Object.assign(new Error("AEMET rechaza la clave (caducada o mal copiada)"), { fatal: true });
  if (!first.ok) throw Object.assign(new Error(`AEMET HTTP ${first.status}`), { status: first.status });

  const firstJson = await first.json();
  const estado = Number(firstJson.estado);
  if (estado === 404) return [];
  if (estado === 401) throw Object.assign(new Error("AEMET rechaza la clave (caducada o mal copiada)"), { fatal: true });
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
      if (error.fatal || attempt >= 4) throw error;
      await wait(Math.min(5000 * 2 ** attempt, 60000));
    }
  }
}

function halfStart(year, half) {
  return half === 1 ? `${year}-01-01` : `${year}-07-01`;
}

function halfEnd(year, half) {
  return half === 1 ? `${year}-06-30` : `${year}-12-31`;
}

function halvesToRefresh(now = new Date()) {
  const year = now.getUTCFullYear();
  const half = now.getUTCMonth() < 6 ? 1 : 2;
  const halves = [{ year, half }];
  const daysIntoHalf = (now - Date.parse(`${halfStart(year, half)}T00:00:00Z`)) / 86400000;
  if (daysIntoHalf < RECHECK_PREVIOUS_HALF_DAYS) {
    halves.push(half === 1 ? { year: year - 1, half: 2 } : { year, half: 1 });
  }
  return halves;
}

async function refreshHalf(db, station, { year, half }) {
  const today = new Date().toISOString().slice(0, 10);
  const end = halfEnd(year, half) > today ? today : halfEnd(year, half);
  const rawData = await fetchAemet(
    `/api/valores/climatologicos/diarios/datos/fechaini/${halfStart(year, half)}T00:00:00UTC/fechafin/${end}T23:59:59UTC/estacion/${encodeURIComponent(station)}`
  );

  // Se fusionan los dias con los ya guardados: si AEMET devuelve menos dias que otra vez, no se pierde nada.
  const update = { station, year, half, fetchedAt: Date.now() };
  let days = 0;
  for (const item of Array.isArray(rawData) ? rawData : []) {
    const parts = typeof item.fecha === "string" ? item.fecha.split("-") : [];
    if (parts.length !== 3) continue;
    update[`rows.${parts[1]}-${parts[2]}`] = {
      tmax: parseNumber(item.tmax),
      tmin: parseNumber(item.tmin),
      tmed: parseNumber(item.tmed),
      prec: parseNumber(item.prec),
    };
    days += 1;
  }

  if (days > 0) {
    await db.collection("chunks").updateOne({ _id: `${station}_${year}_H${half}` }, { $set: update }, { upsert: true });
  }
  return days;
}

async function main() {
  if (!process.env.AEMET_API_KEY) throw new Error("Falta AEMET_API_KEY");
  if (!process.env.MONGODB_URI_WRITE) throw new Error("Falta MONGODB_URI_WRITE");

  const client = new MongoClient(process.env.MONGODB_URI_WRITE);
  await client.connect();
  try {
    const db = client.db(MONGODB_DB);
    const requested = process.argv.slice(2).map((id) => id.trim().toUpperCase()).filter(Boolean);
    const filter = requested.length > 0 ? { _id: { $in: requested } } : { historyComplete: true };
    const stations = (await db.collection("station_meta").find(filter, { projection: { _id: 1, lastYear: 1 } }).toArray())
      // Las estaciones cerradas (p. ej. 2465A, hasta 1986) no tienen nada nuevo que pedir.
      .filter((meta) => !meta.lastYear || meta.lastYear >= new Date().getUTCFullYear() - 1);
    const halves = halvesToRefresh();
    const failed = [];
    const startedAt = Date.now();

    for (const meta of stations) {
      try {
        const counts = [];
        for (const ref of halves) {
          counts.push(await refreshHalf(db, meta._id, ref));
          await wait(REQUEST_DELAY_MS);
        }
        if (counts[0] > 0 && meta.lastYear !== halves[0].year) {
          await db.collection("station_meta").updateOne({ _id: meta._id }, { $set: { lastYear: halves[0].year } });
        }
        console.log(`${meta._id}: ${counts.map((n, i) => `${halves[i].year}-H${halves[i].half} ${n} dias`).join(", ")}`);
      } catch (error) {
        if (error.fatal) throw error;
        failed.push(meta._id);
        console.log(`${meta._id}: ERROR ${error.message}`);
      }
    }

    const minutes = ((Date.now() - startedAt) / 60000).toFixed(1);
    console.log(`Actualizadas ${stations.length - failed.length}/${stations.length} estaciones en ${minutes} min`);
    if (stations.length > 0 && failed.length / stations.length > MAX_FAILURE_RATIO) {
      throw new Error(`Fallaron ${failed.length} estaciones: ${failed.join(", ")}`);
    }
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

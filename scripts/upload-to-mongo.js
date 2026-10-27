// Sube a Atlas la cache local (.cache) de las estaciones indicadas y el inventario de estaciones.
// Uso: node scripts/upload-to-mongo.js 4549Y [3195 ...]
require("dotenv").config({ quiet: true });
const path = require("path");
const fs = require("fs/promises");
const { MongoClient } = require("mongodb");

const CACHE_DIR = process.env.CACHE_DIR ? path.resolve(process.env.CACHE_DIR) : path.join(__dirname, "..", ".cache");
const MONGODB_DB = process.env.MONGODB_DB || "si_se_calienta";

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function uploadStation(db, station) {
  const dir = path.join(CACHE_DIR, "stations", station);
  const meta = await readJson(path.join(dir, "meta.json")).catch(() => null);
  if (!meta || !meta.historyComplete) {
    throw new Error(`${station}: el historico local no esta completo todavia (falta meta.json)`);
  }

  const chunkFiles = (await fs.readdir(dir)).filter((name) => /^\d{4}-H[12]\.json$/.test(name));
  const operations = [];
  for (const name of chunkFiles) {
    const [, year, half] = name.match(/^(\d{4})-H([12])\.json$/);
    const chunk = await readJson(path.join(dir, name));
    const doc = { station, year: Number(year), half: Number(half), fetchedAt: chunk.fetchedAt, rows: chunk.rows };
    operations.push({ replaceOne: { filter: { _id: `${station}_${year}_H${half}` }, replacement: doc, upsert: true } });
  }

  if (operations.length > 0) await db.collection("chunks").bulkWrite(operations, { ordered: false });
  await db.collection("station_meta").replaceOne({ _id: station }, meta, { upsert: true });
  console.log(`${station}: ${operations.length} bloques (${meta.firstYear}-${meta.lastYear})`);
}

async function uploadInventory(db) {
  const cached = await readJson(path.join(CACHE_DIR, "stations_inventory_v2.json"));
  await db
    .collection("inventory")
    .replaceOne({ _id: "stations" }, { createdAt: cached.createdAt, payload: cached.payload }, { upsert: true });
  console.log(`inventario: ${cached.payload.length} estaciones`);
}

async function main() {
  const stations = process.argv.slice(2).map((id) => id.trim().toUpperCase()).filter(Boolean);
  if (!process.env.MONGODB_URI_WRITE) throw new Error("Falta MONGODB_URI_WRITE en .env");

  const client = new MongoClient(process.env.MONGODB_URI_WRITE);
  await client.connect();
  try {
    const db = client.db(MONGODB_DB);
    await uploadInventory(db);
    for (const station of stations) await uploadStation(db, station);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

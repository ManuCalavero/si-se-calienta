// Calcula las cifras anuales de las estaciones de data/capitals.json a partir de los bloques de Atlas
// y las guarda en data/capital-stats.json. Las páginas /estacion/:slug leen ese archivo, así que no consultan la base por visita.
// Uso: node scripts/build-capital-stats.js   (necesita MONGODB_URI_READ en .env)
require("dotenv").config({ quiet: true });
const fs = require("fs/promises");
const path = require("path");
const { MongoClient } = require("mongodb");

const capitals = require("../data/capitals.json");
const MONGODB_DB = process.env.MONGODB_DB || "si_se_calienta";
// Un año cuenta solo si tiene al menos estos días con temperatura media: evita medias anuales sesgadas por huecos.
const MIN_DAYS_PER_YEAR = 330;
// Con menos años no se calcula tendencia ni comparación de periodos.
const MIN_YEARS_TREND = 15;
const MIN_YEARS_COMPARE = 20;
const COMPARE_YEARS = 10;
const MIN_YEARS_PER_DECADE = 5;

function round(value, digits = 1) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function mean(values) {
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function regression(points) {
  const meanX = mean(points.map((p) => p.x));
  const meanY = mean(points.map((p) => p.y));
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    sxx += (p.x - meanX) ** 2;
    sxy += (p.x - meanX) * (p.y - meanY);
  }
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const sse = points.reduce((acc, p) => acc + (p.y - (intercept + slope * p.x)) ** 2, 0);
  const stderr = Math.sqrt(sse / (points.length - 2)) / Math.sqrt(sxx);
  return { slope, stderr, t: stderr > 0 ? slope / stderr : 0 };
}

function annualMeans(docs) {
  const perYear = new Map();
  for (const doc of docs) {
    for (const row of Object.values(doc.rows || {})) {
      if (row && Number.isFinite(row.tmed)) {
        const entry = perYear.get(doc.year) || { sum: 0, days: 0 };
        entry.sum += row.tmed;
        entry.days += 1;
        perYear.set(doc.year, entry);
      }
    }
  }
  return [...perYear.entries()]
    .filter(([, entry]) => entry.days >= MIN_DAYS_PER_YEAR)
    .map(([year, entry]) => ({ year, value: entry.sum / entry.days }))
    .sort((a, b) => a.year - b.year);
}

function summarize(capital, years) {
  const summary = { id: capital.id, years: years.length };
  if (!years.length) return summary;

  summary.firstYear = years[0].year;
  summary.lastYear = years[years.length - 1].year;
  const warmest = years.reduce((a, b) => (b.value > a.value ? b : a));
  const coldest = years.reduce((a, b) => (b.value < a.value ? b : a));
  summary.warmest = { year: warmest.year, value: round(warmest.value) };
  summary.coldest = { year: coldest.year, value: round(coldest.value) };

  const latest = years[years.length - 1];
  const rank = [...years].sort((a, b) => b.value - a.value).findIndex((y) => y.year === latest.year) + 1;
  summary.latest = { year: latest.year, value: round(latest.value), rank };

  if (years.length >= MIN_YEARS_TREND) {
    const fit = regression(years.map((y) => ({ x: y.year, y: y.value })));
    summary.trend = { perDecade: round(fit.slope * 10, 2), stderrPerDecade: round(fit.stderr * 10, 2), t: round(fit.t, 1) };
  }

  if (years.length >= MIN_YEARS_COMPARE) {
    const first = years.slice(0, COMPARE_YEARS);
    const last = years.slice(-COMPARE_YEARS);
    summary.compare = {
      first: { from: first[0].year, to: first[first.length - 1].year, value: round(mean(first.map((y) => y.value))) },
      last: { from: last[0].year, to: last[last.length - 1].year, value: round(mean(last.map((y) => y.value))) },
    };
  }

  const byDecade = new Map();
  for (const y of years) {
    const decade = Math.floor(y.year / 10) * 10;
    if (!byDecade.has(decade)) byDecade.set(decade, []);
    byDecade.get(decade).push(y.value);
  }
  summary.decades = [...byDecade.entries()]
    .filter(([, values]) => values.length >= MIN_YEARS_PER_DECADE)
    .map(([decade, values]) => ({ decade, value: round(mean(values)), years: values.length }))
    .sort((a, b) => a.decade - b.decade);

  return summary;
}

async function main() {
  if (!process.env.MONGODB_URI_READ) throw new Error("Falta MONGODB_URI_READ en .env");
  const client = new MongoClient(process.env.MONGODB_URI_READ, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(MONGODB_DB);
  const stats = {};
  try {
    for (const capital of capitals) {
      // El prefijo del _id (`<estacion>_`) usa el índice; así no se recorre toda la colección.
      const docs = await db
        .collection("chunks")
        .find({ _id: { $regex: `^${capital.id}_` } }, { projection: { year: 1, half: 1, rows: 1 } })
        .toArray();
      const summary = summarize(capital, annualMeans(docs));
      stats[capital.slug] = summary;
      const trend = summary.trend ? `${summary.trend.perDecade >= 0 ? "+" : ""}${summary.trend.perDecade} °C/década (t=${summary.trend.t})` : "sin tendencia";
      console.log(`${capital.slug.padEnd(36)} ${String(docs.length).padStart(3)} bloques · ${String(summary.years).padStart(3)} años · ${trend}`);
    }
  } finally {
    await client.close();
  }
  const file = path.join(__dirname, "..", "data", "capital-stats.json");
  await fs.writeFile(file, JSON.stringify({ generatedAt: new Date().toISOString(), minDaysPerYear: MIN_DAYS_PER_YEAR, stats }, null, 1) + "\n");
  console.log(`\nGuardado ${path.relative(process.cwd(), file)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

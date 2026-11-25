// Cifras para los artículos de tópicos por ciudad (lib/city-articles.js): días de calor, heladas, noches tropicales,
// lluvia, récords por mes… Se calculan desde los bloques diarios de Atlas y se guardan en data/city-stories.json,
// así las páginas no consultan la base por visita. Rehacer una vez al año (o cuando se quiera actualizar):
//   node scripts/build-city-stories.js   (necesita MONGODB_URI_READ en .env)
require("dotenv").config({ quiet: true });
const fs = require("fs/promises");
const path = require("path");
const { MongoClient } = require("mongodb");

const capitals = require("../data/capitals.json");
const MONGODB_DB = process.env.MONGODB_DB || "si_se_calienta";

const CITIES = ["madrid-retiro", "barcelona-fabra", "sevilla-aeropuerto", "valencia", "bilbao-aeropuerto", "a-coruna"];
// Un año cuenta solo con al menos estos días con dato (temperatura o lluvia, por separado).
const MIN_DAYS = 330;
// Periodo antiguo común a las seis estaciones (Sevilla empieza en 1951) y normal climatológica de la OMM.
const BASE = [1951, 1980];
const NORMAL = [1991, 2020];
const RECENT_YEARS = 10;

const round = (value, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
const isNum = Number.isFinite;

function yearSummaries(days) {
  const years = new Map();
  for (const [date, row] of days) {
    const year = Number(date.slice(0, 4));
    if (!years.has(year)) {
      years.set(year, { year, nT: 0, nP: 0, tmedSum: 0, t30: 0, t35: 0, t40: 0, frost: 0, tropical: 0, cold: 0, prec: 0, rain1: 0, rainAny: 0, wettest: [], first35: null, last35: null });
    }
    const y = years.get(year);
    if (isNum(row.tmax) && isNum(row.tmin)) {
      y.nT += 1;
      y.tmedSum += isNum(row.tmed) ? row.tmed : (row.tmax + row.tmin) / 2;
      if (row.tmax >= 30) y.t30 += 1;
      if (row.tmax >= 35) {
        y.t35 += 1;
        if (!y.first35) y.first35 = date;
        y.last35 = date;
      }
      if (row.tmax >= 40) y.t40 += 1;
      if (row.tmin <= 0) y.frost += 1;
      if (row.tmin >= 20) y.tropical += 1;
      // Días fríos: media del día por debajo de 8 °C.
      if ((isNum(row.tmed) ? row.tmed : (row.tmax + row.tmin) / 2) < 8) y.cold += 1;
    }
    if (isNum(row.prec)) {
      y.nP += 1;
      y.prec += row.prec;
      if (row.prec >= 1) y.rain1 += 1;
      if (row.prec > 0) y.rainAny += 1;
      y.wettest.push(row.prec);
    }
  }
  return [...years.values()]
    .sort((a, b) => a.year - b.year)
    .map((y) => {
      const top3 = y.wettest.sort((a, b) => b - a).slice(0, 3).reduce((a, b) => a + b, 0);
      return {
        year: y.year,
        temp: y.nT >= MIN_DAYS,
        rain: y.nP >= MIN_DAYS,
        tmed: y.nT ? y.tmedSum / y.nT : null,
        t30: y.t30,
        t35: y.t35,
        t40: y.t40,
        frost: y.frost,
        tropical: y.tropical,
        cold: y.cold,
        // Días de calor de ≥35 °C entre el primero y el último del año (en días del año, para medir cuánto dura la temporada).
        season35: y.first35 ? dayOfYear(y.last35) - dayOfYear(y.first35) + 1 : 0,
        first35: y.first35 ? dayOfYear(y.first35) : null,
        last35: y.last35 ? dayOfYear(y.last35) : null,
        // Suma de lo medido, sin escalar: los días sin dato de lluvia suelen ser de lluvia inapreciable, no de lluvia perdida.
        prec: y.nP ? y.prec : null,
        rain1: y.rain1,
        rainAny: y.rainAny,
        top3Share: y.prec > 0 ? top3 / y.prec : null,
      };
    });
}

function dayOfYear(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return Math.floor((d - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
}

const TEMP_KEYS = ["tmed", "t30", "t35", "t40", "frost", "tropical", "cold", "season35"];
// Día del año del primer y último día de ≥35 °C: media solo de los años que llegaron a 35.
const DATE_KEYS = ["first35", "last35"];
const RAIN_KEYS = ["prec", "rain1", "rainAny", "top3Share"];

function averages(years, from, to) {
  const out = {};
  const tYears = years.filter((y) => y.temp && y.year >= from && y.year <= to);
  const pYears = years.filter((y) => y.rain && y.year >= from && y.year <= to);
  for (const key of TEMP_KEYS) out[key] = tYears.length ? round(mean(tYears.map((y) => y[key])), key === "tmed" ? 2 : 1) : null;
  for (const key of DATE_KEYS) {
    const values = tYears.map((y) => y[key]).filter(isNum);
    out[key] = values.length >= tYears.length / 2 ? Math.round(mean(values)) : null;
  }
  for (const key of RAIN_KEYS) out[key] = pYears.length ? round(mean(pYears.map((y) => y[key])), key === "top3Share" ? 3 : 1) : null;
  out.firstYear = from;
  out.lastYear = to;
  out.tempYears = tYears.length;
  out.rainYears = pYears.length;
  return out;
}

function decades(years) {
  const firsts = [...new Set(years.map((y) => Math.floor(y.year / 10) * 10))];
  return firsts
    .map((decade) => ({ decade, ...averages(years, decade, decade + 9) }))
    .filter((d) => d.tempYears >= 5 || d.rainYears >= 5);
}

function monthly(days) {
  const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, tmaxSum: 0, tmaxN: 0, tminSum: 0, tminN: 0, precByYear: new Map(), recordMax: null, recordMin: null, recordRain: null }));
  for (const [date, row] of days) {
    const year = Number(date.slice(0, 4));
    const m = months[Number(date.slice(5, 7)) - 1];
    const inNormal = year >= NORMAL[0] && year <= NORMAL[1];
    if (isNum(row.tmax)) {
      if (inNormal) {
        m.tmaxSum += row.tmax;
        m.tmaxN += 1;
      }
      if (!m.recordMax || row.tmax > m.recordMax.value) m.recordMax = { value: row.tmax, date };
    }
    if (isNum(row.tmin)) {
      if (inNormal) {
        m.tminSum += row.tmin;
        m.tminN += 1;
      }
      if (!m.recordMin || row.tmin < m.recordMin.value) m.recordMin = { value: row.tmin, date };
    }
    if (isNum(row.prec)) {
      if (inNormal) {
        const entry = m.precByYear.get(year) || { sum: 0, n: 0 };
        entry.sum += row.prec;
        entry.n += 1;
        m.precByYear.set(year, entry);
      }
      if (!m.recordRain || row.prec > m.recordRain.value) m.recordRain = { value: row.prec, date };
    }
  }
  return months.map((m) => {
    // Lluvia del mes: solo los meses con al menos 25 días con dato (suma de lo medido, como en los años).
    const totals = [...m.precByYear.values()].filter((e) => e.n >= 25).map((e) => e.sum);
    return {
      month: m.month,
      tmax: m.tmaxN ? round(m.tmaxSum / m.tmaxN) : null,
      tmin: m.tminN ? round(m.tminSum / m.tminN) : null,
      prec: totals.length ? Math.round(mean(totals)) : null,
      recordMax: m.recordMax,
      recordMin: m.recordMin,
      recordRain: m.recordRain,
    };
  });
}

function summarize(days) {
  const years = yearSummaries(days);
  const complete = years.filter((y) => y.temp);
  const lastYear = complete[complete.length - 1].year;
  const recent = [lastYear - RECENT_YEARS + 1, lastYear];
  const all = days;
  let recordMax = null;
  let recordMin = null;
  let recordRain = null;
  for (const [date, row] of all) {
    if (isNum(row.tmax) && (!recordMax || row.tmax > recordMax.value)) recordMax = { value: row.tmax, date };
    if (isNum(row.tmin) && (!recordMin || row.tmin < recordMin.value)) recordMin = { value: row.tmin, date };
    if (isNum(row.prec) && (!recordRain || row.prec > recordRain.value)) recordRain = { value: row.prec, date };
  }
  const rainYears = years.filter((y) => y.rain).map((y) => ({ year: y.year, prec: Math.round(y.prec) }));
  const lastDate = [...days].reverse().find(([, row]) => isNum(row.tmax))[0];
  const lastFrost = [...days].reverse().find(([, row]) => isNum(row.tmin) && row.tmin <= 0)?.[0] || null;
  return {
    firstYear: years[0].year,
    lastDate,
    lastFrost,
    lastYear,
    base: averages(years, BASE[0], BASE[1]),
    normal: averages(years, NORMAL[0], NORMAL[1]),
    recent: averages(years, recent[0], recent[1]),
    decades: decades(years),
    years: years
      .filter((y) => y.temp || y.rain)
      .map((y) => ({
        year: y.year,
        ...(y.temp ? { tmed: round(y.tmed, 2), t30: y.t30, t35: y.t35, t40: y.t40, frost: y.frost, tropical: y.tropical, cold: y.cold } : {}),
        ...(y.rain ? { prec: Math.round(y.prec), rain1: y.rain1, rainAny: y.rainAny } : {}),
      })),
    driestYears: [...rainYears].sort((a, b) => a.prec - b.prec).slice(0, 5),
    wettestYears: [...rainYears].sort((a, b) => b.prec - a.prec).slice(0, 5),
    records: { tmax: recordMax, tmin: recordMin, rain: recordRain },
    months: monthly(all),
  };
}

async function main() {
  if (!process.env.MONGODB_URI_READ) throw new Error("Falta MONGODB_URI_READ en .env");
  const client = new MongoClient(process.env.MONGODB_URI_READ, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(MONGODB_DB);
  const out = {};
  try {
    for (const slug of CITIES) {
      const capital = capitals.find((c) => c.slug === slug);
      const docs = await db
        .collection("chunks")
        .find({ _id: { $regex: `^${capital.id}_` } }, { projection: { year: 1, rows: 1 } })
        .toArray();
      const days = [];
      for (const doc of docs) for (const [md, row] of Object.entries(doc.rows || {})) if (row) days.push([`${doc.year}-${md}`, row]);
      days.sort((a, b) => (a[0] < b[0] ? -1 : 1));
      out[slug] = { id: capital.id, ...summarize(days) };
      const s = out[slug];
      console.log(`${slug.padEnd(20)} ${s.firstYear}-${s.lastYear} · ≥35 °C ${s.base.t35} → ${s.recent.t35} · heladas ${s.base.frost} → ${s.recent.frost} · lluvia ${s.normal.prec} mm`);
    }
  } finally {
    await client.close();
  }
  const file = path.join(__dirname, "..", "data", "city-stories.json");
  await fs.writeFile(file, JSON.stringify({ generatedAt: new Date().toISOString(), base: BASE, normal: NORMAL, cities: out }) + "\n");
  console.log(`\nGuardado ${path.relative(process.cwd(), file)}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

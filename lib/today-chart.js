// Comparación «para hoy»: la temperatura media de la ventana de ±7 días en torno al día de hoy, década a década,
// calculada con los datos diarios de Atlas (colección chunks), y su gráfico en PNG para adjuntarlo a un post.
// Sin LLM: todo sale de datos de AEMET. Si Atlas no responde o faltan datos, devuelve null y el post simplemente no se publica.
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");
const { Resvg } = require("@resvg/resvg-js");

const WINDOW_HALF_DAYS = 7;
const MIN_DAYS_PER_YEAR = 5; // un año cuenta si tiene al menos estos días con dato dentro de la ventana
const MIN_YEARS_FIRST = 8; // el primer periodo debe tener al menos estos años
const RECENT_YEARS = 10;
const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

const FONT_REGULAR = path.join(__dirname, "..", "assets", "fonts", "DejaVuSans.ttf");
const FONT_BOLD = path.join(__dirname, "..", "assets", "fonts", "DejaVuSans-Bold.ttf");

let clientPromise = null;
function getDb() {
  if (!process.env.MONGODB_URI_READ) return null;
  if (!clientPromise) {
    const client = new MongoClient(process.env.MONGODB_URI_READ, { serverSelectionTimeoutMS: 8000 });
    clientPromise = client.connect().then(() => client.db(process.env.MONGODB_DB || "si_se_calienta"));
    clientPromise.catch(() => {
      clientPromise = null;
    });
  }
  return clientPromise;
}

const pad = (n) => String(n).padStart(2, "0");
const num = (value, digits = 1) => value.toFixed(digits).replace(".", ",");
const signed = (value, digits = 1) => `${value > 0 ? "+" : value < 0 ? "-" : ""}${num(Math.abs(value), digits)}`;
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const escapeXml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Media de tmed en la ventana en torno a month/day para cada año completo (sin el año en curso).
function yearlyWindowMeans(rowsByYear, month, day, currentYear) {
  const out = [];
  for (const year of [...rowsByYear.keys()].sort((a, b) => a - b)) {
    if (year >= currentYear) continue;
    const values = [];
    for (let offset = -WINDOW_HALF_DAYS; offset <= WINDOW_HALF_DAYS; offset += 1) {
      const date = new Date(Date.UTC(year, month - 1, day + offset));
      const rows = rowsByYear.get(date.getUTCFullYear());
      const row = rows && rows[`${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`];
      if (row && Number.isFinite(row.tmed)) values.push(row.tmed);
    }
    if (values.length >= MIN_DAYS_PER_YEAR) out.push({ year, value: mean(values) });
  }
  return out;
}

function summarize(years) {
  if (years.length < MIN_YEARS_FIRST + RECENT_YEARS) return null;
  const first = years.slice(0, 10);
  const last = years.slice(-RECENT_YEARS);
  if (first.length < MIN_YEARS_FIRST) return null;
  const byDecade = new Map();
  for (const y of years) {
    const decade = Math.floor(y.year / 10) * 10;
    if (!byDecade.has(decade)) byDecade.set(decade, []);
    byDecade.get(decade).push(y.value);
  }
  const decades = [...byDecade.entries()]
    .filter(([, values]) => values.length >= 5)
    .map(([decade, values]) => ({ decade, value: mean(values), years: values.length }))
    .sort((a, b) => a.decade - b.decade);
  const firstValue = mean(first.map((y) => y.value));
  const lastValue = mean(last.map((y) => y.value));
  return {
    first: { from: first[0].year, to: first[first.length - 1].year, value: firstValue },
    last: { from: last[0].year, to: last[last.length - 1].year, value: lastValue },
    diff: Math.round(lastValue * 10) / 10 - Math.round(firstValue * 10) / 10, // con las cifras redondeadas que se muestran, para que cuadre
    decades,
    years: years.length,
  };
}

// «2–16 nov»
function windowLabel(month, day, year) {
  const from = new Date(Date.UTC(year, month - 1, day - WINDOW_HALF_DAYS));
  const to = new Date(Date.UTC(year, month - 1, day + WINDOW_HALF_DAYS));
  const part = (d) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  if (from.getUTCMonth() === to.getUTCMonth()) return `${from.getUTCDate()}–${part(to)}`;
  return `${part(from)} – ${part(to)}`;
}

function renderPng({ title, subtitle, summary, window }) {
  const W = 1200;
  const H = 675;
  const left = 110;
  const right = 70;
  const top = 190;
  const bottom = 535;
  const decades = summary.decades;
  const values = decades.map((d) => d.value);
  const min = Math.floor(Math.min(...values) - 1.5);
  const max = Math.ceil(Math.max(...values) + 0.5);
  const y = (v) => bottom - ((v - min) / (max - min)) * (bottom - top);
  const slot = (W - left - right) / decades.length;
  const barW = Math.min(90, slot * 0.62);

  const ticks = [];
  const step = max - min > 8 ? 2 : 1;
  for (let v = min; v <= max; v += step) ticks.push(v);
  const grid = ticks
    .map((v) => `<line x1="${left}" y1="${y(v)}" x2="${W - right}" y2="${y(v)}" stroke="#ffffff" stroke-opacity="0.12"/><text x="${left - 14}" y="${y(v) + 6}" text-anchor="end" font-size="20" fill="#9fb0c8">${v} °C</text>`)
    .join("");
  // Línea con puntos (no barras): con un eje que no empieza en 0, las barras exagerarían la diferencia.
  const points = decades.map((d, i) => ({ x: left + slot * i + slot / 2, y: y(d.value), d }));
  const line = `<polyline points="${points.map((p) => `${p.x},${p.y}`).join(" ")}" fill="none" stroke="#5b6b8a" stroke-width="4" stroke-linejoin="round"/>`;
  const bars = line + points
    .map((p, i) => {
      const isLast = i === points.length - 1;
      return `<circle cx="${p.x}" cy="${p.y}" r="${isLast ? 13 : 9}" fill="${isLast ? "#a05ddc" : "#8fa0c0"}"/>` +
        `<text x="${p.x}" y="${p.y - 22}" text-anchor="middle" font-size="22" font-weight="700" fill="#ffffff">${num(p.d.value)}</text>` +
        `<text x="${p.x}" y="${bottom + 34}" text-anchor="middle" font-size="22" fill="#c8d3e6">${p.d.decade}s</text>`;
    })
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans">
<rect width="${W}" height="${H}" fill="#0f1b2d"/>
<text x="${left}" y="78" font-size="38" font-weight="700" fill="#ffffff">${escapeXml(title)}</text>
<text x="${left}" y="124" font-size="26" fill="#c8d3e6">${escapeXml(subtitle)}</text>
<text x="${left}" y="164" font-size="22" fill="#9fb0c8">Temperatura media por década · ${escapeXml(window)} (±${WINDOW_HALF_DAYS} días)</text>
${grid}${bars}
<text x="${left}" y="${H - 36}" font-size="22" fill="#9fb0c8">Datos: AEMET</text>
<text x="${W - right}" y="${H - 36}" text-anchor="end" font-size="26" font-weight="700" fill="#a05ddc">secalienta.com</text>
</svg>`;
  const resvg = new Resvg(svg, { font: { fontFiles: [FONT_REGULAR, FONT_BOLD], loadSystemFonts: false, defaultFontFamily: "DejaVu Sans" } });
  return resvg.render().asPng();
}

// capital: entrada de data/capitals.json; when: { month, day, year } en hora de Madrid.
// Devuelve { summary, label, png, alt } o null si no hay datos suficientes.
async function buildTodayComparison(capital, when) {
  const dbPromise = getDb();
  if (!dbPromise) return null;
  const docs = await (await dbPromise)
    .collection("chunks")
    .find({ _id: { $regex: `^${capital.id}_` } }, { projection: { year: 1, rows: 1 } })
    .toArray();
  const rowsByYear = new Map();
  for (const doc of docs) rowsByYear.set(doc.year, { ...(rowsByYear.get(doc.year) || {}), ...doc.rows });

  const summary = summarize(yearlyWindowMeans(rowsByYear, when.month, when.day, when.year));
  if (!summary) return null;
  const label = windowLabel(when.month, when.day, when.year);
  const dayLabel = `${when.day} de ${["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"][when.month - 1]}`;
  const png = renderPng({
    title: `${capital.lugar}: ¿cuánto ha cambiado el ${when.day} de ${MONTHS[when.month - 1]}?`,
    subtitle: `${num(summary.first.value)} °C en ${summary.first.from}–${summary.first.to} → ${num(summary.last.value)} °C en ${summary.last.from}–${summary.last.to} (${signed(summary.diff)} °C)`,
    summary,
    window: label,
  });
  const alt = `Gráfico de barras con la temperatura media de ${capital.lugar} alrededor del ${dayLabel}, por décadas: ${summary.decades.map((d) => `${d.decade}s ${num(d.value)} °C`).join(", ")}. Datos de AEMET.`;
  return { summary, label, dayLabel, png, alt };
}

module.exports = { buildTodayComparison, summarize, yearlyWindowMeans };

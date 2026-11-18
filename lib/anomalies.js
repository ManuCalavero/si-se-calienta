// Anomalías de todas las capitales a la vez: el último día medido y la última semana frente a la normal 1991–2020.
// Las normales están precalculadas en data/day-normals.json (scripts/build-day-normals.js) y de Atlas solo se lee
// el medio año en curso (y el anterior si hace falta) de cada estación, en una sola consulta.
// Sirve para el post de «la capital más alejada de lo normal» y para el resumen semanal con imagen.
const { Resvg } = require("@resvg/resvg-js");
const chart = require("./today-chart");
const normals = require("../data/day-normals.json");

const pad = (n) => String(n).padStart(2, "0");
const num = (value, digits = 1) => value.toFixed(digits).replace(".", ",");
const signed = (value, digits = 1) => `${value > 0 ? "+" : value < 0 ? "-" : ""}${num(Math.abs(value), digits)}`;
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const escapeXml = (text) => String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const keyOf = (date) => `${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
const dayLabel = (date) => `${date.getUTCDate()} de ${chart.MONTHS_FULL[date.getUTCMonth()]}`;

// El día de referencia es el más reciente que tienen al menos estas capitales (AEMET no actualiza todas a la vez).
const MIN_SHARE_WITH_DATA = 0.6;
const WEEK_DAYS = 7;
const MIN_WEEK_DAYS = 6;
const LOOKBACK_DAYS = chart.MAX_DAY_AGE + WEEK_DAYS;

// Datos diarios recientes de las capitales: Map(slug -> Map("AAAA-MM-DD" -> tmed)). null si Atlas no está configurado.
async function loadRecent(capitals, today) {
  const dbPromise = chart.getDb();
  if (!dbPromise) return null;
  const todayUtc = Date.UTC(today.year, today.month - 1, today.day);
  const halves = new Set();
  for (let back = 1; back <= LOOKBACK_DAYS; back += 1) {
    const date = new Date(todayUtc - back * 86400000);
    halves.add(`${date.getUTCFullYear()}_H${date.getUTCMonth() < 6 ? 1 : 2}`);
  }
  const ids = capitals.flatMap((capital) => [...halves].map((half) => `${capital.id}_${half}`));
  const docs = await (await dbPromise).collection("chunks").find({ _id: { $in: ids } }, { projection: { station: 1, year: 1, rows: 1 } }).toArray();
  const byId = new Map(capitals.map((capital) => [capital.id, capital.slug]));
  const out = new Map(capitals.map((capital) => [capital.slug, new Map()]));
  for (const doc of docs) {
    const slug = byId.get(String(doc._id).split("_")[0]);
    if (!slug) continue;
    for (const [key, row] of Object.entries(doc.rows || {})) {
      if (row && Number.isFinite(row.tmed)) out.get(slug).set(`${doc.year}-${key}`, row.tmed);
    }
  }
  return out;
}

const isoOf = (date) => `${date.getUTCFullYear()}-${keyOf(date)}`;

// Día más reciente (hasta MAX_DAY_AGE atrás) con dato en al menos el 60 % de las capitales.
function referenceDay(recent, todayUtc) {
  const total = recent.size;
  for (let back = 1; back <= chart.MAX_DAY_AGE; back += 1) {
    const date = new Date(todayUtc - back * 86400000);
    const iso = isoOf(date);
    let count = 0;
    for (const series of recent.values()) if (series.has(iso)) count += 1;
    if (count >= total * MIN_SHARE_WITH_DATA) return date;
  }
  return null;
}

// capitals: entradas de data/capitals.json (solo cuentan las que tienen normal). today: { year, month, day } en Madrid.
// Devuelve { date, dayLabel, weekday, items: [{ capital, tmed, normal, diff }] (de mayor a menor |diff|), warm, cold, total } o null.
async function dayAnomalies(capitals, today) {
  const withNormals = capitals.filter((capital) => normals[capital.slug]);
  const recent = await loadRecent(withNormals, today);
  if (!recent) return null;
  const date = referenceDay(recent, Date.UTC(today.year, today.month - 1, today.day));
  if (!date) return null;
  const iso = isoOf(date);
  const items = [];
  for (const capital of withNormals) {
    const tmed = recent.get(capital.slug).get(iso);
    const normal = normals[capital.slug][keyOf(date)];
    if (!Number.isFinite(tmed) || !Number.isFinite(normal)) continue;
    items.push({ capital, tmed, normal, diff: Math.round((tmed - normal) * 10) / 10 });
  }
  items.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
  return {
    date,
    dayLabel: dayLabel(date),
    weekday: chart.WEEKDAYS[date.getUTCDay()],
    items,
    warm: items.filter((i) => i.diff >= 0.3).length,
    cold: items.filter((i) => i.diff <= -0.3).length,
    total: items.length,
  };
}

// Últimos 7 días medidos (hasta el día de referencia) frente a la normal de esos mismos días.
// Devuelve { from, to, fromLabel, toLabel, items: [{ capital, tmed, normal, diff }] (de más cálida a más fría), warm, cold, total } o null.
async function weekAnomalies(capitals, today) {
  const withNormals = capitals.filter((capital) => normals[capital.slug]);
  const recent = await loadRecent(withNormals, today);
  if (!recent) return null;
  const to = referenceDay(recent, Date.UTC(today.year, today.month - 1, today.day));
  if (!to) return null;
  const days = [];
  for (let back = WEEK_DAYS - 1; back >= 0; back -= 1) days.push(new Date(to.getTime() - back * 86400000));
  const items = [];
  for (const capital of withNormals) {
    const series = recent.get(capital.slug);
    const pairs = days.map((d) => [series.get(isoOf(d)), normals[capital.slug][keyOf(d)]]).filter(([t, n]) => Number.isFinite(t) && Number.isFinite(n));
    if (pairs.length < MIN_WEEK_DAYS) continue;
    const tmed = mean(pairs.map((p) => p[0]));
    const normal = mean(pairs.map((p) => p[1]));
    items.push({ capital, tmed, normal, diff: Math.round((tmed - normal) * 10) / 10 });
  }
  if (!items.length) return null;
  items.sort((a, b) => b.diff - a.diff);
  return {
    from: days[0],
    to,
    fromLabel: dayLabel(days[0]),
    toLabel: dayLabel(to),
    items,
    warm: items.filter((i) => i.diff >= 0.3).length,
    cold: items.filter((i) => i.diff <= -0.3).length,
    total: items.length,
  };
}

// «31 de 44 capitales» o, si son todas, «Las 44 capitales» (con mayúscula si va al principio de la frase).
function countLabel(count, total, capitalized = false) {
  if (count === total) return `${capitalized ? "Las" : "las"} ${total} capitales`;
  return `${count} de ${total} capitales`;
}

// «del 9 al 15 de noviembre» o «del 28 de octubre al 3 de noviembre»
function rangeLabel(week) {
  if (week.from.getUTCMonth() === week.to.getUTCMonth()) return `del ${week.from.getUTCDate()} al ${week.toLabel}`;
  return `del ${week.fromLabel} al ${week.toLabel}`;
}

// Imagen del resumen semanal: las 6 capitales más cálidas y las 6 más frías respecto a lo normal, en barras desde 0.
function renderWeekPng(week) {
  const W = 1200;
  const H = 675;
  const rows = week.items.length > 12 ? [...week.items.slice(0, 6), ...week.items.slice(-6)] : week.items;
  const top = 200;
  const rowH = 32;
  const labelX = 330;
  // El eje 0 se coloca según haya valores negativos o no, dejando sitio a las cifras a cada lado.
  const valueRoom = 120;
  const start = labelX + 20;
  const end = W - 70 - valueRoom;
  const maxPos = Math.max(0, ...rows.map((r) => r.diff));
  const maxNeg = Math.max(0, ...rows.map((r) => -r.diff));
  const leftRoom = maxNeg > 0 ? valueRoom : 0;
  const scale = (end - start - leftRoom) / Math.max(1, maxPos + maxNeg);
  const zeroX = start + leftRoom + maxNeg * scale;
  const bars = rows
    .map((r, i) => {
      const y = top + i * rowH + (week.items.length > 12 && i >= 6 ? 14 : 0);
      const w = Math.max(2, Math.abs(r.diff) * scale);
      const x = r.diff >= 0 ? zeroX : zeroX - w;
      const color = r.diff >= 0.3 ? "#a05ddc" : r.diff <= -0.3 ? "#5b8fd9" : "#8fa0c0";
      const valueX = r.diff >= 0 ? zeroX + w + 10 : zeroX - w - 10;
      return `<text x="${labelX}" y="${y + 21}" text-anchor="end" font-size="21" fill="#e6ecf5">${escapeXml(r.capital.lugar)}</text>` +
        `<rect x="${x}" y="${y + 5}" width="${w}" height="${rowH - 10}" rx="3" fill="${color}"/>` +
        `<text x="${valueX}" y="${y + 21}" text-anchor="${r.diff >= 0 ? "start" : "end"}" font-size="20" font-weight="700" fill="#ffffff">${signed(r.diff)} °C</text>`;
    })
    .join("");
  const axisBottom = top + rows.length * rowH + (week.items.length > 12 ? 14 : 0);
  const majorityWarm = week.warm >= week.cold;
  const subtitle = `${countLabel(majorityWarm ? week.warm : week.cold, week.total, true)}, más ${majorityWarm ? "cálidas" : "frías"} de lo normal`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="DejaVu Sans">
<rect width="${W}" height="${H}" fill="#0f1b2d"/>
<text x="70" y="78" font-size="38" font-weight="700" fill="#ffffff">${escapeXml(`La semana ${rangeLabel(week)}`)}</text>
<text x="70" y="124" font-size="28" fill="#c8d3e6">${escapeXml(subtitle)}</text>
<text x="70" y="164" font-size="21" fill="#9fb0c8">Temperatura media de la semana frente a lo normal (${chart.NORMAL_FROM}–${chart.NORMAL_TO})${week.items.length > 12 ? " · las 6 primeras y las 6 últimas" : ""}</text>
<line x1="${zeroX}" y1="${top - 4}" x2="${zeroX}" y2="${axisBottom + 4}" stroke="#ffffff" stroke-opacity="0.35" stroke-width="2"/>
${bars}
<text x="70" y="${H - 36}" font-size="22" fill="#9fb0c8">Datos: AEMET</text>
<text x="${W - 70}" y="${H - 36}" text-anchor="end" font-size="26" font-weight="700" fill="#a05ddc">secalienta.com</text>
</svg>`;
  const resvg = new Resvg(svg, { font: { fontFiles: [chart.FONT_REGULAR, chart.FONT_BOLD], loadSystemFonts: false, defaultFontFamily: "DejaVu Sans" } });
  const alt = `Gráfico de barras: temperatura media de la semana ${rangeLabel(week)} frente a lo normal de ${chart.NORMAL_FROM}–${chart.NORMAL_TO}. ${subtitle}. ${rows.map((r) => `${r.capital.lugar} ${signed(r.diff)} °C`).join(", ")}. Datos de AEMET.`;
  return { png: resvg.render().asPng(), alt };
}

module.exports = { dayAnomalies, weekAnomalies, renderWeekPng, rangeLabel, countLabel };

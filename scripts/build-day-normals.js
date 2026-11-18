// Calcula la normal 1991–2020 de cada día del año (media de la ventana de ±7 días, igual que lib/today-chart.js)
// para las estaciones de data/capitals.json y la guarda en data/day-normals.json.
// Así el post de «la capital más alejada de lo normal» y el resumen semanal solo leen de Atlas el año en curso,
// en vez de toda la serie de las 51 estaciones en cada pasada del cron.
// Uso: node scripts/build-day-normals.js   (necesita MONGODB_URI_READ en .env). Las normales no cambian: basta con ejecutarlo
// al añadir estaciones.
require("dotenv").config({ quiet: true });
const fs = require("fs/promises");
const path = require("path");
const capitals = require("../data/capitals.json");
const chart = require("../lib/today-chart");

const pad = (n) => String(n).padStart(2, "0");

async function main() {
  const out = {};
  for (const capital of capitals) {
    const rowsByYear = await chart.loadRows(capital);
    if (!rowsByYear) throw new Error("Falta MONGODB_URI_READ");
    const days = {};
    // 2024 es bisiesto: recorre los 366 días, 29 de febrero incluido.
    for (let d = new Date(Date.UTC(2024, 0, 1)); d.getUTCFullYear() === 2024; d = new Date(d.getTime() + 86400000)) {
      const month = d.getUTCMonth() + 1;
      const day = d.getUTCDate();
      const years = chart.yearlyWindowMeans(rowsByYear, month, day, chart.NORMAL_TO + 1).filter((y) => y.year >= chart.NORMAL_FROM);
      if (years.length < chart.NORMAL_MIN_YEARS) continue;
      days[`${pad(month)}-${pad(day)}`] = Math.round((years.reduce((a, y) => a + y.value, 0) / years.length) * 100) / 100;
    }
    if (Object.keys(days).length >= 360) out[capital.slug] = days;
    console.log(`${capital.slug}: ${Object.keys(days).length} días`);
  }
  const file = path.join(__dirname, "..", "data", "day-normals.json");
  await fs.writeFile(file, `${JSON.stringify(out)}\n`);
  console.log(`Guardadas ${Object.keys(out).length} estaciones en ${path.relative(process.cwd(), file)}`);
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => process.exit());

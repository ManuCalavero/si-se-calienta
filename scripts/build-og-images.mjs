// Imágenes para compartir (Open Graph y miniatura de Bluesky): un pantallazo del gráfico de cada capital.
// Abre /estacion/<slug> en la web publicada, captura la tarjeta del gráfico y la monta en 1200×630 con el logo y el nombre.
// Escribe public/img/og/<slug>.jpg, con el de Madrid también public/img/og.jpg (la imagen de la portada),
// y data/og-images.json con las capitales que tienen imagen.
//
// Necesita Playwright, que no es dependencia del proyecto:
//   npm i --no-save playwright && node scripts/build-og-images.mjs
//   node scripts/build-og-images.mjs madrid-retiro sevilla-aeropuerto   (solo esas)
// Variables opcionales: SITE_URL (por defecto https://secalienta.com) y CHROME_PATH (un Chrome instalado, si Playwright no trae el suyo).
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const SITE = (process.env.SITE_URL || "https://secalienta.com").replace(/\/+$/, "");
const OUT_DIR = path.join(ROOT, "public", "img", "og");
const HOME_SLUG = "madrid-retiro";

const capitals = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "capitals.json"), "utf8"));
const { stats } = JSON.parse(fs.readFileSync(path.join(ROOT, "data", "capital-stats.json"), "utf8"));
const wanted = process.argv.slice(2);
const list = capitals.filter((c) => stats[c.slug] && stats[c.slug].years > 0 && (!wanted.length || wanted.includes(c.slug)));

const MONTHS = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
const month = MONTHS[Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", month: "numeric" }).format(new Date())) - 1];
const icon = `data:image/png;base64,${fs.readFileSync(path.join(ROOT, "public", "apple-touch-icon.png")).toString("base64")}`;
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

const cardHtml = ({ title, sub, chart }) => `<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400..600&family=Inter+Tight:wght@500..700&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0}
html,body{width:1200px;height:630px;background:#ecebe6;overflow:hidden}
.wrap{padding:22px 34px 0}
header{display:flex;align-items:center;justify-content:space-between;gap:24px;margin-bottom:16px}
.brand{display:flex;align-items:center;gap:12px;font:600 26px "Inter",sans-serif;color:#111;white-space:nowrap}
.brand img{width:38px;height:38px;border-radius:9px}
.st{text-align:right;min-width:0}
.st h1{font:700 34px/1 "Inter Tight",sans-serif;letter-spacing:-.02em;color:#111;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.st p{font:500 14px "IBM Plex Mono",monospace;letter-spacing:.06em;color:#6b6a64;margin-top:6px;text-transform:uppercase}
.card{background:#faf9f5;border-radius:22px;box-shadow:0 1px 0 rgba(0,0,0,.04),0 8px 30px rgba(0,0,0,.06);overflow:hidden}
.card img{display:block;width:100%}
</style></head><body><div class="wrap">
<header><div class="brand"><img src="${icon}">secalienta.com</div>
<div class="st"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(sub)}</p></div></header>
<div class="card"><img src="${chart}"></div>
</div></body></html>`;

const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
// Ancho 1200 con el panel ampliado: la tarjeta del gráfico sale de ~1120×520, la proporción que cabe bajo la cabecera.
const context = await browser.newContext({ viewport: { width: 1200, height: 1400 }, deviceScaleFactor: 2, colorScheme: "light" });
// Sin banner de cookies ni Google Tag Manager: la captura no cuenta como visita.
await context.addInitScript(() => {
  try {
    localStorage.setItem("secalienta-consent", "declined");
  } catch {}
});
const composer = await browser.newPage({ viewport: { width: 1200, height: 630 } });
fs.mkdirSync(OUT_DIR, { recursive: true });

const failed = [];
for (const capital of list) {
  const page = await context.newPage();
  try {
    await page.goto(`${SITE}/estacion/${capital.slug}`, { waitUntil: "networkidle", timeout: 45000 });
    await page.waitForSelector("#panel-body:not(.is-loading)", { timeout: 30000 });
    await page.click("#expand-btn");
    const card = page.locator(".chart-card");
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(2500); // animación de Chart.js y cambio de tamaño al ampliar
    const chart = `data:image/png;base64,${(await card.screenshot()).toString("base64")}`;
    const title = (await page.locator("#panel-title").innerText()).trim() || capital.nombre;
    const years = ((await page.locator("#panel-sub").innerText()).match(/\d{4}\s*[–-]\s*\d{4}/) || [""])[0].replace(/\s/g, "");
    await composer.setContent(cardHtml({ title, sub: [month, years].filter(Boolean).join(" · "), chart }), { waitUntil: "networkidle" });
    await composer.evaluate(() => document.fonts.ready);
    const jpg = await composer.screenshot({ type: "jpeg", quality: 88 });
    fs.writeFileSync(path.join(OUT_DIR, `${capital.slug}.jpg`), jpg);
    if (capital.slug === HOME_SLUG) fs.writeFileSync(path.join(ROOT, "public", "img", "og.jpg"), jpg);
    console.log(`ok ${capital.slug} · ${title} · ${Math.round(jpg.length / 1024)} KB`);
  } catch (error) {
    failed.push(capital.slug);
    console.error(`FALLO ${capital.slug}: ${error.message.split("\n")[0]}`);
  } finally {
    await page.close();
  }
}
await browser.close();
// Lista de capitales con imagen, la que lee lib/seo-pages.js para poner su og:image.
const available = fs.readdirSync(OUT_DIR).filter((name) => name.endsWith(".jpg")).map((name) => name.slice(0, -4)).sort();
fs.writeFileSync(path.join(ROOT, "data", "og-images.json"), `${JSON.stringify(available, null, 1)}\n`);
console.log(`${list.length - failed.length}/${list.length} imágenes en public/img/og${failed.length ? ` · fallaron: ${failed.join(", ")}` : ""}`);
process.exitCode = failed.length ? 1 : 0;

// Páginas indexables por estación (/estacion/:slug) y su índice (/temperaturas).
// La app es la misma: el servidor solo rellena título, descripción, h1 y un texto con las cifras reales de la estación,
// que salen de data/capital-stats.json (generado por scripts/build-capital-stats.js).
const fs = require("fs");
const path = require("path");

const capitals = require("../data/capitals.json");
const statsFile = require("../data/capital-stats.json");

const bySlug = new Map(capitals.map((capital) => [capital.slug, capital]));
const LINKS = {
  aemetClimate: "https://www.aemet.es/es/serviciosclimaticos/cambio_climat",
  copernicus: "https://climate.copernicus.eu/",
  ipcc: "https://www.ipcc.ch/languages-2/spanish/",
  aemetOpenData: "https://opendata.aemet.es/",
};

let appTemplate = null;
try {
  appTemplate = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
} catch (error) {
  console.error("seo-pages: no se pudo leer public/index.html", error.message);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

// Mismas reglas que titleCase() de public/js/format.js: así el texto del servidor coincide con el que pinta la app y la página no se mueve.
const titleCase = (text) =>
  String(text || "")
    .toLowerCase()
    .replace(/(^|[\s,.\-/(])(\p{L})/gu, (_match, sep, letter) => sep + letter.toUpperCase());

const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

// «del 1 nov al 15 nov»: la ventana de ±7 días en torno a hoy, con el año de referencia 2024 que usa la app.
function windowText(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid", month: "numeric", day: "numeric" }).formatToParts(date);
  const month = Number(parts.find((p) => p.type === "month").value);
  const day = Number(parts.find((p) => p.type === "day").value);
  const center = new Date(2024, month - 1, day);
  const from = new Date(center);
  from.setDate(center.getDate() - 7);
  const to = new Date(center);
  to.setDate(center.getDate() + 7);
  const short = (d) => `${d.getDate()} ${MONTHS_SHORT[d.getMonth()]}`;
  return `del ${short(from)} al ${short(to)}`;
}

const num = (value, digits = 1) => value.toFixed(digits).replace(".", ",");
const signed = (value, digits = 1) => `${value > 0 ? "+" : value < 0 ? "-" : ""}${num(Math.abs(value), digits)}`;

function getCapital(slug) {
  return bySlug.get(String(slug || "").toLowerCase()) || null;
}

function getStats(slug) {
  return statsFile.stats[slug] || null;
}

function listPublishable() {
  return capitals.filter((capital) => {
    const stats = getStats(capital.slug);
    return stats && stats.years > 0;
  });
}

// ---------- Texto de la estación ----------

function trendSentence(stats) {
  if (!stats.trend) {
    return `Con ${stats.years} años completos no hay datos suficientes para calcular una tendencia fiable.`;
  }
  const { perDecade, stderrPerDecade, t } = stats.trend;
  const base = `Ajustando una recta a los ${stats.years} años con datos, la tendencia es de ${signed(perDecade, 2)} °C por década (error estándar de ±${num(stderrPerDecade, 2)} °C).`;
  return Math.abs(t) >= 2
    ? `${base} Es una tendencia estadísticamente significativa.`
    : `${base} Con estos datos no se distingue con claridad de la variabilidad natural entre años.`;
}

function buildAbout(capital, stats) {
  const lugar = escapeHtml(capital.lugar);
  const parts = [];

  const intro = [`La estación de ${escapeHtml(capital.nombre)} (AEMET ${escapeHtml(capital.id)}) tiene años completos de datos diarios desde ${stats.firstYear}.`];
  if (capital.nota) intro.push(escapeHtml(capital.nota));
  parts.push(`<p>${intro.join(" ")}</p>`);

  if (stats.compare) {
    const { first, last } = stats.compare;
    const diff = Math.round((last.value - first.value) * 10) / 10;
    parts.push(
      `<p>Entre ${first.from} y ${first.to}, la temperatura media anual fue de ${num(first.value)} °C. Entre ${last.from} y ${last.to}, de ${num(last.value)} °C: una diferencia de ${signed(diff)} °C.</p>`
    );
  }

  parts.push(`<p>${trendSentence(stats)}</p>`);

  parts.push(
    `<p>El año más cálido fue ${stats.warmest.year} (${num(stats.warmest.value)} °C de media) y el más frío ${stats.coldest.year} (${num(stats.coldest.value)} °C). ` +
      `El último año completo, ${stats.latest.year}, tuvo una media de ${num(stats.latest.value)} °C: ${
        stats.latest.rank === 1 ? `el más cálido de los ${stats.years} años con datos` : `el ${stats.latest.rank}.º más cálido de ${stats.years}`
      }.</p>`
  );

  if (stats.decades && stats.decades.length) {
    const rows = stats.decades
      .map((d) => `<tr><th scope="row">${d.decade}s</th><td>${num(d.value)} °C</td><td>${d.years}</td></tr>`)
      .join("");
    parts.push(
      `<table class="about-table"><caption>Temperatura media anual por década en ${lugar}</caption>` +
        `<thead><tr><th scope="col">Década</th><th scope="col">Media</th><th scope="col">Años con dato</th></tr></thead><tbody>${rows}</tbody></table>`
    );
  }

  if (stats.years < 30) {
    parts.push(`<p class="about-warn"><strong>Pocos años de datos.</strong> Esta estación solo tiene ${stats.years} años completos: es poco para hablar de tendencias, interprétalo con cautela.</p>`);
  }

  parts.push(
    `<p>Una sola estación no mide el clima de un país: también refleja su entorno, con cambios de emplazamiento o de instrumentos y el crecimiento de la ciudad. ` +
      `El calentamiento global se estudia con miles de estaciones; para sacar conclusiones consulta ` +
      `<a href="${LINKS.aemetClimate}" target="_blank" rel="noopener noreferrer">AEMET</a>, ` +
      `<a href="${LINKS.copernicus}" target="_blank" rel="noopener noreferrer">Copernicus</a> o el ` +
      `<a href="${LINKS.ipcc}" target="_blank" rel="noopener noreferrer">IPCC</a>.</p>`
  );

  parts.push(
    `<p>Arriba puedes elegir cualquier día del año para ver cómo ha cambiado ese día concreto en ${lugar}, con la media de ±7 días y los datos año a año. ` +
      `Los datos son de <a href="${LINKS.aemetOpenData}" target="_blank" rel="noopener noreferrer">AEMET OpenData</a> y puedes descargarlos en CSV.</p>`
  );

  const neighbours = (capital.vecinas || [])
    .map((slug) => bySlug.get(slug))
    .filter(Boolean)
    .map((c) => `<a href="/estacion/${c.slug}">${escapeHtml(c.capital)}</a>`);
  parts.push(
    `<p class="about-links">${neighbours.length ? `Capitales cercanas: ${neighbours.join(", ")}. ` : ""}<a href="/temperaturas">Ver todas las capitales</a></p>`
  );

  return `<section class="card station-about" aria-labelledby="about-title"><h2 id="about-title">¿Hace más calor que antes en ${lugar}?</h2>${parts.join("")}</section>`;
}

function describe(capital, stats) {
  const lugar = capital.lugar;
  if (stats.trend) {
    return `Evolución de la temperatura en ${lugar} desde ${stats.firstYear}: ${signed(stats.trend.perDecade, 1)} °C por década. Compara cualquier día con ese mismo día del pasado. Datos de AEMET.`;
  }
  return `Temperaturas en ${lugar} desde ${stats.firstYear}. Compara cualquier día del año con ese mismo día del pasado. Datos de AEMET.`;
}

// ---------- Página de estación ----------

function replaceOnce(html, pattern, replacement) {
  if (!pattern.test(html)) throw new Error(`plantilla sin coincidencia: ${pattern}`);
  return html.replace(pattern, () => replacement);
}

// Devuelve el HTML de la app con los datos de la estación, o null si algo no encaja (el servidor redirige entonces a la app).
function renderStationPage(slug, siteUrl) {
  const capital = getCapital(slug);
  const stats = capital && getStats(capital.slug);
  if (!appTemplate || !capital || !stats || !stats.years) return null;

  const url = `${siteUrl}/estacion/${capital.slug}`;
  // Google recorta los títulos por encima de ~60 caracteres: en los nombres largos se omite el «Datos desde».
  const fullTitle = `¿Hace más calor que antes en ${capital.lugar}? Datos desde ${stats.firstYear}`;
  const title = fullTitle.length > 62 ? `¿Hace más calor que antes en ${capital.lugar}?` : fullTitle;
  const description = describe(capital, stats);
  const ogTitle = `${title} · secalienta.com`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "WebPage",
        "@id": `${url}#pagina`,
        url,
        name: title,
        description,
        inLanguage: "es",
        isPartOf: { "@type": "WebSite", name: "secalienta.com", url: `${siteUrl}/` },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "secalienta.com", item: `${siteUrl}/` },
          { "@type": "ListItem", position: 2, name: "Temperaturas por capital", item: `${siteUrl}/temperaturas` },
          { "@type": "ListItem", position: 3, name: capital.lugar, item: url },
        ],
      },
    ],
  };

  try {
    let html = appTemplate;
    html = replaceOnce(html, /<title>[^<]*<\/title>/, `<title>${escapeHtml(title)}</title>`);
    html = replaceOnce(html, /<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${escapeHtml(description)}" />`);
    html = replaceOnce(html, /<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${escapeHtml(ogTitle)}" />`);
    html = replaceOnce(html, /<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${escapeHtml(description)}" />`);
    html = replaceOnce(html, /<meta name="twitter:title" content="[^"]*" \/>/, `<meta name="twitter:title" content="${escapeHtml(ogTitle)}" />`);
    html = replaceOnce(html, /<meta name="twitter:description" content="[^"]*" \/>/, `<meta name="twitter:description" content="${escapeHtml(description)}" />`);
    html = replaceOnce(html, /<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${url}" />`);
    html = replaceOnce(html, /<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${url}" />`);
    html = replaceOnce(html, /<script type="application\/ld\+json">[\s\S]*?<\/script>/, `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`);
    // La página sale ya en el estado «estación elegida»: así el panel no salta de tamaño al cargar.
    html = replaceOnce(html, /<body class="welcome-open">/, `<body class="has-selection" data-station="${escapeHtml(capital.id)}">`);
    html = replaceOnce(html, /<section id="panel" class="panel" aria-labelledby="panel-title" hidden>/, '<section id="panel" class="panel" aria-labelledby="panel-title">');
    html = replaceOnce(html, /<h2 id="panel-title"><\/h2>/, `<h1 id="panel-title">${escapeHtml(titleCase(capital.aemetNombre))}</h1>`);
    // Se rellenan ya en el servidor (los vuelve a escribir la app) para que la cabecera no cambie de alto ni de líneas al cargar.
    html = replaceOnce(html, /<span id="panel-eyebrow"><\/span>/, `<span id="panel-eyebrow">${escapeHtml(`Estación ${capital.id} · ${titleCase(capital.provincia)}`)}</span>`);
    html = replaceOnce(html, /<p id="panel-sub" class="panel-sub"><\/p>/, `<p id="panel-sub" class="panel-sub" data-ssr="1">${escapeHtml(`Media ${windowText()} · ${stats.firstYear}–${stats.lastYear}`)}</p>`);
    // La hoja ya sale abierta: sin esta clase la app la «abre» con una animación al arrancar.
    html = replaceOnce(html, /<section id="panel" class="panel" aria-labelledby="panel-title">/, '<section id="panel" class="panel open" aria-labelledby="panel-title">');
    html = replaceOnce(html, /<div id="panel-body" class="panel-body">/, '<div id="panel-body" class="panel-body is-loading">');
    html = replaceOnce(html, /<!--station-about-->/, buildAbout(capital, stats));
    return html;
  } catch (error) {
    console.error(`seo-pages: ${capital.slug}: ${error.message}`);
    return null;
  }
}

// ---------- Índice /temperaturas ----------

function renderIndexPage(siteUrl) {
  const url = `${siteUrl}/temperaturas`;
  const title = "Temperaturas históricas en las capitales de provincia";
  const description = "¿Hace más calor que antes en tu ciudad? Tendencia de la temperatura por década en las capitales de provincia, con datos de AEMET desde hace décadas.";
  const rows = listPublishable()
    .sort((a, b) => a.capital.localeCompare(b.capital, "es"))
    .map((capital) => {
      const stats = getStats(capital.slug);
      const trend = stats.trend ? `${signed(stats.trend.perDecade, 2)} °C` : "—";
      const note = stats.years < 30 ? ' <span class="short" title="Pocos años de datos">·&nbsp;datos cortos</span>' : "";
      return `<tr><th scope="row"><a href="/estacion/${capital.slug}">${escapeHtml(capital.capital)}</a></th><td class="col-station">${escapeHtml(capital.nombre)}</td><td>${stats.firstYear}</td><td class="num">${trend}${note}</td></tr>`;
    })
    .join("");
  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebPage", "@id": `${url}#pagina`, url, name: title, description, inLanguage: "es", isPartOf: { "@type": "WebSite", name: "secalienta.com", url: `${siteUrl}/` } },
      {
        "@type": "BreadcrumbList",
        itemListElement: [
          { "@type": "ListItem", position: 1, name: "secalienta.com", item: `${siteUrl}/` },
          { "@type": "ListItem", position: 2, name: "Temperaturas por capital", item: url },
        ],
      },
    ],
  };

  return `<!doctype html>
<html lang="es">
  <head>
    <meta charset="UTF-8" />
    <script src="/js/analytics.js" defer></script>
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#c7c7c7" />
    <title>${escapeHtml(title)} · secalienta.com</title>
    <meta name="description" content="${escapeHtml(description)}" />
    <link rel="canonical" href="${url}" />
    <meta name="robots" content="index, follow, max-image-preview:large" />
    <meta property="og:title" content="${escapeHtml(title)} · secalienta.com" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:type" content="website" />
    <meta property="og:locale" content="es_ES" />
    <meta property="og:url" content="${url}" />
    <meta property="og:site_name" content="secalienta.com" />
    <meta property="og:image" content="${siteUrl}/img/og.jpg" />
    <meta name="twitter:card" content="summary_large_image" />
    <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
    <link rel="icon" href="/favicon.ico" sizes="32x32" />
    <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
    <link rel="icon" href="/favicon-48.png" type="image/png" sizes="48x48" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400..600&family=Inter+Tight:wght@500..700&display=swap" rel="stylesheet" />
    <link rel="stylesheet" href="/pages.css" />
  </head>
  <body>
    <a class="skip-link" href="#contenido">Saltar al contenido</a>
    <header class="site-header">
      <a class="brand" href="/" aria-label="secalienta.com, ir al mapa"><span class="brand-mark" aria-hidden="true"></span><strong>secalienta.com</strong></a>
      <a class="open-map" href="/">Abrir el mapa</a>
    </header>
    <main id="contenido" class="page">
      <h1>Temperaturas históricas en las capitales de provincia</h1>
      <p class="lead">¿Hace más calor que antes en tu ciudad? Elige una capital para ver cómo ha cambiado su temperatura y comparar cualquier día del año con ese mismo día en el pasado. Los datos son de las estaciones de la Agencia Estatal de Meteorología (<a href="${LINKS.aemetOpenData}" target="_blank" rel="noopener noreferrer">AEMET OpenData</a>).</p>
      <div class="table-wrap">
        <table class="capitals">
          <caption>Tendencia de la temperatura media anual por capital</caption>
          <thead><tr><th scope="col">Capital</th><th scope="col" class="col-station">Estación</th><th scope="col">Años completos desde</th><th scope="col" class="num">Tendencia por década</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="note">La tendencia es la pendiente de una recta ajustada a la temperatura media anual de cada estación. Cada estación mide su entorno: muchas están en aeropuertos, algunas han cambiado de emplazamiento y los años de datos varían mucho, así que no son comparables entre sí sin cautela. Una sola estación no mide el calentamiento global; para eso consulta <a href="${LINKS.aemetClimate}" target="_blank" rel="noopener noreferrer">AEMET</a>, <a href="${LINKS.copernicus}" target="_blank" rel="noopener noreferrer">Copernicus</a> o el <a href="${LINKS.ipcc}" target="_blank" rel="noopener noreferrer">IPCC</a>.</p>
    </main>
  </body>
</html>
`;
}

function renderNotFoundPage() {
  return `<!doctype html><html lang="es"><head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" /><meta name="robots" content="noindex" /><title>Página no encontrada · secalienta.com</title><link rel="stylesheet" href="/pages.css" /></head><body><main class="page"><h1>No encontramos esa página</h1><p class="lead">Prueba con el <a href="/temperaturas">listado de capitales</a> o abre <a href="/">el mapa</a>.</p></main></body></html>`;
}

function sitemapUrls(siteUrl) {
  const urls = [{ loc: `${siteUrl}/`, priority: "1.0" }, { loc: `${siteUrl}/temperaturas`, priority: "0.8" }];
  for (const capital of listPublishable()) urls.push({ loc: `${siteUrl}/estacion/${capital.slug}`, priority: "0.7" });
  return urls;
}

module.exports = { getCapital, renderStationPage, renderIndexPage, renderNotFoundPage, sitemapUrls };

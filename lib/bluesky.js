// Publicación diaria en Bluesky: una capital al día, con las cifras de data/capital-stats.json.
// Lo usan la tarea programada (GET /api/cron/bluesky) y el script manual (scripts/post-bluesky.js).
const seo = require("./seo-pages");

const SERVICE = () => (process.env.BLUESKY_SERVICE || "https://bsky.social").replace(/\/+$/, "");
const SITE = () => (process.env.SITE_URL || "https://secalienta.com").replace(/\/+$/, "");
const POST_HOUR_MADRID = 8;
const MAX_GRAPHEMES = 300;
// Con menos años de datos no se publica la capital: la tendencia no sería fiable.
const MIN_YEARS = 30;

const num = (value, digits = 1) => value.toFixed(digits).replace(".", ",");
const signed = (value, digits = 1) => `${value > 0 ? "+" : value < 0 ? "-" : ""}${num(Math.abs(value), digits)}`;

function graphemes(text) {
  return [...new Intl.Segmenter("es", { granularity: "grapheme" }).segment(text)].length;
}

// Fecha y hora en Madrid, que es lo que importa para «publicar a las 8:00».
function madridParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const year = get("year");
  const month = get("month");
  const day = get("day");
  return { year, month, day, hour: get("hour"), dayIndex: Math.floor(Date.UTC(year, month - 1, day) / 86400000), key: `${year}-${month}-${day}` };
}

// Capitales con datos suficientes, en un orden estable (por slug): así «la de hoy» sale solo del calendario.
function eligibleCapitals() {
  return seo
    .listPublishable()
    .filter((capital) => {
      const stats = seo.getStats(capital.slug);
      return stats && stats.years >= MIN_YEARS && stats.compare && stats.trend;
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

const TEMPLATES = [
  ({ capital, nombre, c, trend, link }) =>
    `📍 ${capital}: la temperatura media anual ha pasado de ${num(c.first.value)} °C (${c.first.from}–${c.first.to}) a ${num(c.last.value)} °C (${c.last.from}–${c.last.to}). Tendencia: ${signed(trend.perDecade, 2)} °C por década. Datos de AEMET, estación de ${nombre}.\n\nCompara cualquier día del año 👉 ${link}`,
  ({ capital, nombre, c, link }) =>
    `¿Hace más calor que antes en ${capital}? Según la estación de ${nombre} (AEMET), la media anual era de ${num(c.first.value)} °C en ${c.first.from}–${c.first.to} y de ${num(c.last.value)} °C en ${c.last.from}–${c.last.to}.\n\nElige tú el día y compruébalo 👉 ${link}`,
  ({ capital, c, link }) =>
    `${capital}, ${c.first.from}–${c.first.to} frente a ${c.last.from}–${c.last.to}: ${num(c.first.value)} °C → ${num(c.last.value)} °C de media anual (${signed(c.last.value - c.first.value)} °C). Una sola estación no es el clima global, pero los datos están a la vista.\n\nExplóralos día a día 👉 ${link}`,
];

// Compone el post de la fecha dada. Devuelve null si no hay capitales publicables.
function composePost(date = new Date(), { slug } = {}) {
  const eligible = eligibleCapitals();
  if (!eligible.length) return null;
  const when = madridParts(date);
  const capital = slug ? eligible.find((c) => c.slug === slug) : eligible[when.dayIndex % eligible.length];
  if (!capital) return null;

  const stats = seo.getStats(capital.slug);
  const url = `${SITE()}/estacion/${capital.slug}`;
  const shownLink = url.replace(/^https?:\/\//, "");
  // Cada vuelta completa a las capitales usa una redacción distinta.
  const cycle = Math.floor(when.dayIndex / eligible.length);
  const data = { capital: capital.lugar, nombre: capital.nombre, c: stats.compare, trend: stats.trend, link: shownLink };

  let text = null;
  for (let i = 0; i < TEMPLATES.length; i += 1) {
    const candidate = TEMPLATES[(cycle + i) % TEMPLATES.length](data);
    if (graphemes(candidate) <= MAX_GRAPHEMES) {
      text = candidate;
      break;
    }
  }
  if (!text) return null;

  // El enlace es clicable: Bluesky pide la posición en BYTES (UTF-8) del texto que se muestra.
  const index = text.lastIndexOf(shownLink);
  const byteStart = Buffer.byteLength(text.slice(0, index), "utf8");
  const facets = [
    {
      index: { byteStart, byteEnd: byteStart + Buffer.byteLength(shownLink, "utf8") },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
    },
  ];
  const card = {
    uri: url,
    title: `¿Hace más calor que antes en ${capital.lugar}?`,
    description: `Temperatura media anual: ${num(stats.compare.last.value)} °C en ${stats.compare.last.from}–${stats.compare.last.to}. Datos de AEMET.`,
  };
  return { slug: capital.slug, capital: capital.lugar, text, facets, card, url, graphemes: graphemes(text) };
}

async function xrpc(method, path, { token, body, headers = {}, query } = {}) {
  const url = `${SERVICE()}/xrpc/${path}${query ? `?${new URLSearchParams(query)}` : ""}`;
  const response = await fetch(url, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`Bluesky ${path}: ${response.status} ${(payload && (payload.message || payload.error)) || ""}`.trim());
  return payload;
}

async function uploadThumb(token) {
  try {
    const image = await fetch(`${SITE()}/img/og.jpg`, { signal: AbortSignal.timeout(10000) });
    if (!image.ok) return null;
    const bytes = Buffer.from(await image.arrayBuffer());
    // Bluesky admite imágenes de hasta ~1 MB en las tarjetas.
    if (bytes.length > 950000) return null;
    const result = await xrpc("POST", "com.atproto.repo.uploadBlob", { token, body: bytes, headers: { "Content-Type": "image/jpeg" } });
    return result.blob;
  } catch (_error) {
    return null; // Sin imagen la tarjeta sale igualmente, solo sin miniatura.
  }
}

// ¿Ya se publicó hoy esta capital? Evita duplicados si la tarea se ejecuta dos veces o se lanza a mano.
async function alreadyPostedToday(token, did, post, todayKey) {
  const list = await xrpc("GET", "com.atproto.repo.listRecords", {
    token,
    query: { repo: did, collection: "app.bsky.feed.post", limit: "15" },
  });
  return (list.records || []).some((record) => {
    const value = record.value || {};
    const created = value.createdAt ? madridParts(new Date(value.createdAt)).key : "";
    return created === todayKey && String(value.text || "").includes(post.url.replace(/^https?:\/\//, ""));
  });
}

// opciones: dryRun (no publica), force (ignora la hora y el duplicado de hoy), slug (capital concreta), date (para pruebas)
async function publishDaily({ dryRun = false, force = false, slug, date = new Date() } = {}) {
  const when = madridParts(date);
  if (!force && when.hour !== POST_HOUR_MADRID) {
    return { posted: false, skipped: `Ahora son las ${when.hour}:xx en Madrid; se publica a las ${POST_HOUR_MADRID}:00` };
  }
  const post = composePost(date, { slug });
  if (!post) return { posted: false, skipped: "No hay capital publicable" };
  if (dryRun) return { posted: false, dryRun: true, text: post.text, graphemes: post.graphemes, url: post.url };

  const { BLUESKY_HANDLE: handle, BLUESKY_APP_PASSWORD: password } = process.env;
  if (!handle || !password) throw new Error("Faltan BLUESKY_HANDLE y BLUESKY_APP_PASSWORD");

  const session = await xrpc("POST", "com.atproto.server.createSession", {
    body: JSON.stringify({ identifier: handle, password }),
    headers: { "Content-Type": "application/json" },
  });
  if (!force && (await alreadyPostedToday(session.accessJwt, session.did, post, when.key))) {
    return { posted: false, skipped: `Ya se publicó hoy ${post.slug}` };
  }

  const thumb = await uploadThumb(session.accessJwt);
  const record = {
    $type: "app.bsky.feed.post",
    text: post.text,
    facets: post.facets,
    langs: ["es"],
    createdAt: new Date().toISOString(),
    embed: { $type: "app.bsky.embed.external", external: { ...post.card, ...(thumb ? { thumb } : {}) } },
  };
  const created = await xrpc("POST", "com.atproto.repo.createRecord", {
    token: session.accessJwt,
    body: JSON.stringify({ repo: session.did, collection: "app.bsky.feed.post", record }),
    headers: { "Content-Type": "application/json" },
  });
  return { posted: true, slug: post.slug, uri: created.uri, withThumb: Boolean(thumb) };
}

module.exports = { composePost, publishDaily, eligibleCapitals, madridParts };

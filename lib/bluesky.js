// Publicación en Bluesky según el playbook de data/editorial.json:
//  - Posts cortos y sin emojis: el último día medido de cada capital frente a la normal 1991–2020 (datos diarios de Atlas),
//    con el post anual de data/capital-stats.json como reserva, y el gráfico «para hoy». Varias redacciones que se alternan.
//  - Modo evento (p. ej. COP31): hashtag del evento y más reposts de fuentes fiables.
//  - Reposts curados, «me gusta» a lo repostado y seguimiento gradual de una lista cerrada de cuentas oficiales.
//  - Una petición de ayuda ocasional (desactivada hasta confirmar la cuenta de Ko-fi).
// Todo sale de datos propios o de reposts: nada de texto generado ni de opiniones. Sin LLM, sin coste añadido.
const seo = require("./seo-pages");
const capitalsList = require("../data/capitals.json");
const todayChart = require("./today-chart");
const editorial = require("../data/editorial.json");

const SERVICE = () => (process.env.BLUESKY_SERVICE || "https://bsky.social").replace(/\/+$/, "");
const SITE = () => (process.env.SITE_URL || "https://secalienta.com").replace(/\/+$/, "");
const KOFI_URL = () => process.env.KOFI_URL || "https://ko-fi.com/secalienta";
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
  const pad = (n) => String(n).padStart(2, "0");
  return { year, month, day, hour: get("hour"), dayIndex: Math.floor(Date.UTC(year, month - 1, day) / 86400000), key: `${year}-${pad(month)}-${pad(day)}` };
}

// Evento activo hoy (fecha de Madrid), si lo hay.
function activeEvent(date = new Date()) {
  const { key } = madridParts(date);
  return (editorial.events || []).find((event) => key >= event.from && key <= event.to) || null;
}

function hashtagsFor(date) {
  const event = activeEvent(date);
  return [...(event ? event.hashtags : []), ...(editorial.baseHashtags || [])].slice(0, 3);
}

// Añade los hashtags al final y devuelve el texto con sus facets (posiciones en BYTES UTF-8, como pide Bluesky).
function withFacets(text, { link, url, tags = [] }) {
  let full = text;
  if (tags.length) full += `\n\n${tags.map((tag) => `#${tag}`).join(" ")}`;
  const bytes = (s) => Buffer.byteLength(s, "utf8");
  const facets = [];
  if (link) {
    const index = full.lastIndexOf(link);
    facets.push({
      index: { byteStart: bytes(full.slice(0, index)), byteEnd: bytes(full.slice(0, index)) + bytes(link) },
      features: [{ $type: "app.bsky.richtext.facet#link", uri: url }],
    });
  }
  for (const tag of tags) {
    const needle = `#${tag}`;
    const index = full.lastIndexOf(needle);
    facets.push({
      index: { byteStart: bytes(full.slice(0, index)), byteEnd: bytes(full.slice(0, index)) + bytes(needle) },
      features: [{ $type: "app.bsky.richtext.facet#tag", tag }],
    });
  }
  return { text: full, facets };
}

// Capitales con datos suficientes, en un orden estable (por slug).
function eligibleCapitals() {
  return seo
    .listPublishable()
    .filter((capital) => {
      const stats = seo.getStats(capital.slug);
      return stats && stats.years >= MIN_YEARS && stats.compare && stats.trend;
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

// Textos cortos y directos, sin emojis: una cifra, la ciudad y el enlace. Se alternan varias redacciones
// (y varios cierres) para que la cuenta no suene a bot; la elección cambia con el día y con la hora del slot.
const CTA = [
  (link) => `Compara más datos en ${link}`,
  (link) => `Compara con otros años en ${link}`,
  (link, lugar) => `Más datos de ${lugar} en ${link}`,
  (link) => `Consulta cualquier día del año en ${link}`,
];

// Diferencias de menos de 0,3 °C se cuentan como «en lo normal»: decir «+0,1 °C» sería ruido.
const NEAR_NORMAL = 0.3;

// Post del último día medido frente a la normal 1991–2020. Todas las redacciones llevan la fecha («6 de noviembre»):
// sirve para no repetir el mismo día si AEMET no ha publicado datos nuevos (ver alreadyPosted).
const DAY_BODIES = {
  warm: [
    ({ lugar, d, t, x }) => `${lugar}, +${x} °C sobre lo normal el ${d}: ${t} °C de media.`,
    ({ lugar, d, t, x }) => `${lugar}, ${d}: ${t} °C de media, ${x} °C más de lo normal para esa fecha.`,
    ({ lugar, d, t, x }) => `El ${d}, ${lugar} tuvo ${t} °C de media: ${x} °C por encima de lo normal.`,
    ({ lugar, d, t, x, w }) => `${lugar} registró el ${w} ${d} una media de ${t} °C, ${x} °C más de lo habitual.`,
  ],
  cold: [
    ({ lugar, d, t, x }) => `${lugar}, -${x} °C bajo lo normal el ${d}: ${t} °C de media.`,
    ({ lugar, d, t, x }) => `${lugar}, ${d}: ${t} °C de media, ${x} °C menos de lo normal para esa fecha.`,
    ({ lugar, d, t, x }) => `El ${d}, ${lugar} tuvo ${t} °C de media: ${x} °C por debajo de lo normal.`,
    ({ lugar, d, t, x, w }) => `${lugar} registró el ${w} ${d} una media de ${t} °C, ${x} °C menos de lo habitual.`,
  ],
  normal: [
    ({ lugar, d, t }) => `${lugar}, en lo normal el ${d}: ${t} °C de media.`,
    ({ lugar, d, t }) => `${lugar}, ${d}: ${t} °C de media, en lo normal para esa fecha.`,
    ({ lugar, d, t }) => `El ${d}, ${lugar} tuvo ${t} °C de media, en línea con lo normal.`,
  ],
};

// Post del gráfico «para hoy»: la ventana de ±7 días en torno a hoy, última década frente a la primera de la serie.
const TODAY_BODIES = {
  warm: [
    ({ lugar, d, x, p }) => `${lugar}, en torno al ${d}: ${x} °C más que en ${p}.`,
    ({ lugar, d, x, p }) => `En la última década, los días en torno al ${d} han sido ${x} °C más cálidos en ${lugar} que en ${p}.`,
    ({ lugar, d, x, p }) => `¿Cuánto ha cambiado el ${d} en ${lugar}? +${x} °C desde ${p}.`,
  ],
  cold: [
    ({ lugar, d, x, p }) => `${lugar}, en torno al ${d}: ${x} °C menos que en ${p}.`,
    ({ lugar, d, x, p }) => `¿Cuánto ha cambiado el ${d} en ${lugar}? -${x} °C desde ${p}.`,
  ],
  normal: [
    ({ lugar, d, p }) => `${lugar}, en torno al ${d}: casi igual que en ${p}.`,
    ({ lugar, d, p }) => `¿Cuánto ha cambiado el ${d} en ${lugar}? Apenas nada desde ${p}.`,
  ],
};

// Reserva anual (si el post del día no se puede componer): media anual, primera década frente a la última.
const YEAR_BODIES = {
  warm: [
    ({ lugar, x, p }) => `${lugar}: la temperatura media anual ha subido ${x} °C desde ${p}.`,
    ({ lugar, x, p, a, b }) => `${lugar}, de ${a} °C a ${b} °C de media anual desde ${p}: ${x} °C más.`,
  ],
  cold: [({ lugar, x, p }) => `${lugar}: la temperatura media anual ha bajado ${x} °C desde ${p}.`],
  normal: [({ lugar, p }) => `${lugar}: la temperatura media anual apenas ha cambiado desde ${p}.`],
};

const toneOf = (diff) => (diff >= NEAR_NORMAL ? "warm" : diff <= -NEAR_NORMAL ? "cold" : "normal");
const period = (from, to) => `${from}–${to}`;

// Prueba las redacciones (y cierres) a partir de `step` hasta que una cabe en 300 caracteres.
function buildText({ bodies, data, step, link, url, tags, lugar }) {
  for (let i = 0; i < bodies.length * CTA.length; i += 1) {
    const body = bodies[(step + i) % bodies.length](data);
    // El cierre avanza a otro ritmo que la redacción, para que las combinaciones no se repitan en el mismo orden.
    const cta = CTA[(Math.floor((step + i) / bodies.length) + step) % CTA.length](link, lugar);
    const candidate = withFacets(`${body}\n\n${cta}`, { link, url, tags });
    if (graphemes(candidate.text) <= MAX_GRAPHEMES) return candidate;
  }
  return null;
}

function linkFor(capital) {
  const url = `${SITE()}/estacion/${capital.slug}`;
  return { url, shownLink: url.replace(/^https?:\/\//, "") };
}

function cardFor(capital, description) {
  return { uri: linkFor(capital).url, title: `¿Hace más calor que antes en ${capital.lugar}?`, description };
}

// Post anual de la capital `slug` (reserva del post del día). Devuelve null si no se puede.
function composePost(date = new Date(), { slug, salt = 0 } = {}) {
  const eligible = eligibleCapitals();
  if (!eligible.length) return null;
  const when = madridParts(date);
  const capital = slug ? eligible.find((c) => c.slug === slug) : eligible[when.dayIndex % eligible.length];
  if (!capital) return null;

  const s = seo.getStats(capital.slug);
  const { url, shownLink } = linkFor(capital);
  const c = s.compare;
  const diff = Math.round(c.last.value * 10) / 10 - Math.round(c.first.value * 10) / 10;
  const data = { lugar: capital.lugar, x: num(Math.abs(diff)), p: period(c.first.from, c.first.to), a: num(c.first.value), b: num(c.last.value) };
  const built = buildText({ bodies: YEAR_BODIES[toneOf(diff)], data, step: when.dayIndex + salt, link: shownLink, url, tags: hashtagsFor(date), lugar: capital.lugar });
  if (!built) return null;

  const card = cardFor(capital, `Temperatura media anual: ${num(c.last.value)} °C en ${period(c.last.from, c.last.to)}. Datos de AEMET, estación de ${capital.nombre}.`);
  return { slug: capital.slug, capital: capital.lugar, text: built.text, facets: built.facets, card, url, graphemes: graphemes(built.text), kind: "data" };
}

// Post del último día medido frente a la normal 1991–2020. Asíncrono porque consulta Atlas.
// Si falta el dato del día (AEMET se retrasa) devuelve el post anual, y si tampoco se puede, null.
async function composeDay(date = new Date(), { slug, salt = 0 } = {}) {
  const when = madridParts(date);
  const fallback = composePost(date, { slug, salt });
  const capital = eligibleCapitals().find((c) => c.slug === slug);
  if (!capital) return fallback;
  const last = await todayChart.buildLastDay(capital, when);
  if (!last) return fallback;

  const { url, shownLink } = linkFor(capital);
  const data = { lugar: capital.lugar, d: last.dayLabel, w: last.weekday, t: num(last.tmed), x: num(Math.abs(last.diff)) };
  const built = buildText({ bodies: DAY_BODIES[toneOf(last.diff)], data, step: when.dayIndex + salt, link: shownLink, url, tags: hashtagsFor(date), lugar: capital.lugar });
  if (!built) return fallback;

  const card = cardFor(capital, `${last.dayLabel}: ${num(last.tmed)} °C de media frente a una normal de ${num(last.normal)} °C (media de ${todayChart.NORMAL_FROM}–${todayChart.NORMAL_TO} para esos días). Datos de AEMET, estación de ${capital.nombre}.`);
  return {
    slug: capital.slug,
    capital: capital.lugar,
    text: built.text,
    facets: built.facets,
    card,
    url,
    graphemes: graphemes(built.text),
    kind: "day",
    measured: { dayLabel: last.dayLabel, tmed: last.tmed, normal: Math.round(last.normal * 10) / 10, diff: last.diff },
    repeatGuard: last.dayLabel, // no publicar dos veces el mismo día medido de la misma estación
    fallback,
  };
}

// Post «para hoy»: la temperatura media de la ventana de ±7 días en torno a hoy, década a década (datos diarios de Atlas), con el gráfico adjunto.
// Es asíncrono porque consulta Atlas. Devuelve null si faltan datos: mejor no publicar que publicar algo dudoso.
async function composeToday(date = new Date(), { slug, salt = 0 } = {}) {
  const when = madridParts(date);
  const capital = capitalsList.find((c) => c.slug === slug);
  const stats = capital && seo.getStats(capital.slug);
  if (!capital || !stats || stats.years < MIN_YEARS) return null;
  const comparison = await todayChart.buildTodayComparison(capital, { year: when.year, month: when.month, day: when.day });
  if (!comparison) return null;

  const { url, shownLink } = linkFor(capital);
  const s = comparison.summary;
  const data = { lugar: capital.lugar, d: comparison.dayLabel, x: num(Math.abs(s.diff)), p: period(s.first.from, s.first.to) };
  const built = buildText({ bodies: TODAY_BODIES[toneOf(s.diff)], data, step: when.dayIndex + salt, link: shownLink, url, tags: hashtagsFor(date), lugar: capital.lugar });
  if (!built) return null;
  return {
    slug: capital.slug,
    capital: capital.lugar,
    text: built.text,
    facets: built.facets,
    card: null,
    image: { png: comparison.png, alt: comparison.alt },
    url,
    graphemes: graphemes(built.text),
    kind: "today",
  };
}

// Petición de ayuda ocasional: honesta, breve, sin cifras ni nombres.
function composeDonation(date = new Date()) {
  const link = KOFI_URL().replace(/^https?:\/\//, "");
  const body = `Secalienta.com es un proyecto personal y no oficial: los costes salen de mi bolsillo. Si te resulta útil y quieres echar una mano, puedes invitarme a un café en ${link}\n\nCompartirlo ya ayuda mucho.`;
  const { text, facets } = withFacets(body, { link, url: KOFI_URL(), tags: [] });
  return { slug: "ayuda", capital: "ayuda", text, facets, card: null, url: KOFI_URL(), graphemes: graphemes(text), kind: "donate" };
}

// ¿Qué toca publicar a esta hora (Madrid)? Devuelve una publicación o null.
// Un slot con kind "today" rota entre las capitales de su lista `rotate` (se repiten las que se quiere ver más).
async function postForNow(date = new Date()) {
  const when = madridParts(date);
  const donate = editorial.donate || {};
  if (donate.enabled && when.hour === donate.hourMadrid && when.dayIndex % donate.everyNDays === 0) return composeDonation(date);
  const slots = editorial.dailySlots || [];
  const slot = slots.find((s) => s.hourMadrid === when.hour && (!s.everyNthDay || when.dayIndex % s.everyNthDay === 0));
  if (!slot) return null;
  const slug = slot.rotate ? slot.rotate[when.dayIndex % slot.rotate.length] : slot.slug;
  // El orden del slot entre los de su tipo entra en la rotación de redacciones: dos posts del mismo día no salen con la misma frase.
  const salt = slots.filter((s) => (s.kind === "today") === (slot.kind === "today")).indexOf(slot);
  const post = slot.kind === "today" ? await composeToday(date, { slug, salt }) : await composeDay(date, { slug, salt });
  // Toca publicar pero no hay datos suficientes: se avisa (publishDaily lo devuelve como alerta) en vez de fallar en silencio.
  return post || { missing: `${slot.kind === "today" ? "post con gráfico" : "post de datos"} de ${slug} a las ${when.hour}:00` };
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

async function login() {
  const { BLUESKY_HANDLE: handle, BLUESKY_APP_PASSWORD: password } = process.env;
  if (!handle || !password) throw new Error("Faltan BLUESKY_HANDLE y BLUESKY_APP_PASSWORD");
  return xrpc("POST", "com.atproto.server.createSession", {
    body: JSON.stringify({ identifier: handle, password }),
    headers: { "Content-Type": "application/json" },
  });
}

async function createRecord(session, collection, record) {
  return xrpc("POST", "com.atproto.repo.createRecord", {
    token: session.accessJwt,
    body: JSON.stringify({ repo: session.did, collection, record }),
    headers: { "Content-Type": "application/json" },
  });
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

async function uploadImage(token, png) {
  if (png.length > 950000) throw new Error("La imagen supera el límite de Bluesky");
  const result = await xrpc("POST", "com.atproto.repo.uploadBlob", { token, body: png, headers: { "Content-Type": "image/png" } });
  return result.blob;
}

// ¿Ya se publicó esto? Evita duplicados si la tarea se ejecuta dos veces o se lanza a mano:
//  - hoy, el mismo tipo de post (con o sin gráfico) de la misma estación;
//  - o, en los posts del día medido, el mismo día de la misma estación en los últimos posts (AEMET aún no ha publicado datos nuevos).
// Devuelve "today", "repeat" o null.
async function alreadyPosted(token, did, post, todayKey) {
  const list = await xrpc("GET", "com.atproto.repo.listRecords", {
    token,
    query: { repo: did, collection: "app.bsky.feed.post", limit: "40" },
  });
  const link = post.url.replace(/^https?:\/\//, "");
  const dayRegex = post.repeatGuard ? new RegExp(`(^|[^0-9])${post.repeatGuard}([^0-9]|$)`) : null;
  let found = null;
  for (const record of list.records || []) {
    const value = record.value || {};
    const text = String(value.text || "");
    if (!text.includes(link)) continue;
    const withImage = Boolean(value.embed && value.embed.$type === "app.bsky.embed.images");
    const created = value.createdAt ? madridParts(new Date(value.createdAt)).key : "";
    if (created === todayKey && withImage === Boolean(post.image)) return "today";
    if (dayRegex && !withImage && dayRegex.test(text)) found = "repeat";
  }
  return found;
}

// opciones: dryRun (no publica), force (ignora la hora y el duplicado de hoy), slug (capital concreta), today (con slug: post «para hoy» con gráfico), date (para pruebas)
async function publishDaily({ dryRun = false, force = false, slug, today = false, date = new Date() } = {}) {
  const when = madridParts(date);
  let post = slug ? (today ? await composeToday(date, { slug }) : await composeDay(date, { slug })) : await postForNow(date);
  if (post && post.missing) return { posted: false, alert: `No se pudo componer el ${post.missing} (faltan datos).` };
  if (!post) {
    return { posted: false, skipped: slug ? "No hay capital publicable" : `A las ${when.hour}:xx (Madrid) no toca publicar nada` };
  }
  const preview = (p) => ({ kind: p.kind, text: p.text, graphemes: p.graphemes, url: p.url, measured: p.measured, card: p.card ? p.card.description : undefined, withImage: Boolean(p.image), alt: p.image ? p.image.alt : undefined, png: p.image ? p.image.png : undefined });
  if (dryRun) return { posted: false, dryRun: true, ...preview(post), fallback: post.fallback ? post.fallback.text : undefined };

  const session = await login();
  if (!force) {
    let seen = await alreadyPosted(session.accessJwt, session.did, post, when.key);
    // El día medido ya se publicó (AEMET no ha actualizado): se publica el post anual en su lugar.
    if (seen === "repeat" && post.fallback) {
      post = post.fallback;
      seen = await alreadyPosted(session.accessJwt, session.did, post, when.key);
    }
    if (seen === "today") return { posted: false, skipped: `Ya se publicó hoy ${post.slug}` };
    if (seen === "repeat") return { posted: false, skipped: `Ya se publicó el último día medido de ${post.slug}` };
  }

  const record = {
    $type: "app.bsky.feed.post",
    text: post.text,
    facets: post.facets,
    langs: ["es"],
    createdAt: new Date().toISOString(),
  };
  let withThumb = false;
  if (post.image) {
    const blob = await uploadImage(session.accessJwt, post.image.png);
    record.embed = { $type: "app.bsky.embed.images", images: [{ alt: post.image.alt, image: blob, aspectRatio: { width: 1200, height: 675 } }] };
  } else if (post.card) {
    const thumb = await uploadThumb(session.accessJwt);
    withThumb = Boolean(thumb);
    record.embed = { $type: "app.bsky.embed.external", external: { ...post.card, ...(thumb ? { thumb } : {}) } };
  }
  const created = await createRecord(session, "app.bsky.feed.post", record);
  return { posted: true, slug: post.slug, kind: post.kind, uri: created.uri, withThumb, withImage: Boolean(post.image) };
}

// ---------- Reposts curados ----------
// Solo se reposta de cuentas oficiales o medios especializados de una lista cerrada, solo contenido reciente sobre clima.
// No se responde ni se entra en discusiones: discutir con terceros es un riesgo de reputación que no merece la pena.
// AEMET publica sobre todo avisos meteorológicos: se descartan (caducan en horas y esta cuenta no es oficial).
const PUBLIC_API = "https://public.api.bsky.app";
const REPOST_MAX_PER_DAY = 4;
// Un repost por pasada del cron (varias al día, ver vercel.json): se reparten en el día en vez de salir juntos.
const REPOST_MAX_PER_RUN = 1;

// Temas que encajan con la web (calentamiento global y temperaturas). Se compara sobre texto sin tildes y en minúsculas.
const WARMING_TOPICS = /calentamiento|cambio climatico|crisis climatica|global warming|climate change|climate crisis|warmest|hottest|heatwave|heat wave|ola de calor|temperatura|temperature|anomal|record|1\.5|sea ice|hielo marino|nivel del mar|sea level|ocean heat|sequia|drought/;
const NOT_CONTENT = /job|vacanc|tender|webinar|registration|deadline|podcast|newsletter|subscribe|donat|join us|live from|watch live|livestream|side event|follow the/;

const REPOST_SOURCES = [
  {
    handle: "aemet.es",
    maxAgeHours: 36,
    include: /cambio climatico|calentamiento|climatic|serie 19|serie 20|balance climatic|boletin climatic|anomalia|temperaturas superiores|mas calid|mas fri|trimestre|prediccion estacional|ola de calor|record|sequia|adaptecca|escenarios/,
    exclude: /aviso|nota informativa|alerta|borrasca|temporal/,
  },
  {
    handle: "copernicusecmwf.bsky.social",
    maxAgeHours: 96,
    include: /climate bulletin|temperature|warmest|1\.5|sea ice|heat|record|global climate|indicators of global climate|anomal|drought|river flow/,
    exclude: /tender|registration|deadline|course|workshop|attending|general assembly|visualising climate|methane|ozone|haze|fire emission/,
  },
  // Resto de fuentes fiables (instituciones y medios especializados). Entran los temas de calentamiento global y temperaturas;
  // durante un evento activo también lo relacionado con el evento (ver pickRepostCandidates). «eventOnly»: solo mientras hay evento.
  { handle: "wmo-global.bsky.social", maxAgeHours: 72, include: WARMING_TOPICS, exclude: NOT_CONTENT },
  { handle: "ipcc.bsky.social", maxAgeHours: 96, include: WARMING_TOPICS, exclude: NOT_CONTENT },
  { handle: "metoffice.gov.uk", maxAgeHours: 48, include: WARMING_TOPICS, exclude: /warning|forecast|weather today|tonight|overnight|tomorrow|storm|snow|rain|fog|frost|wind|sunny|cold|chilly/ },
  { handle: "berkeleyearth.org", maxAgeHours: 96, include: WARMING_TOPICS, exclude: NOT_CONTENT },
  { handle: "csic.es", maxAgeHours: 96, include: WARMING_TOPICS, exclude: NOT_CONTENT },
  { handle: "csicdivulga.bsky.social", maxAgeHours: 96, include: WARMING_TOPICS, exclude: NOT_CONTENT },
  { handle: "climatica.coop", maxAgeHours: 48, include: WARMING_TOPICS, exclude: /suscr|socio|donaci|newsletter|podcast/ },
  { handle: "carbonbrief.org", maxAgeHours: 48, include: WARMING_TOPICS, exclude: /podcast|newsletter|job|sponsor/ },
];

const normalizeText = (text) =>
  String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

// Entre las publicaciones recientes de cada fuente elige las mejores candidatas (dentro de cada una, la que más «me gusta» tiene) y las alterna entre fuentes.
// Las fuentes «eventOnly» exigen además que el texto mencione el evento activo.
function pickRepostCandidates(feedsByHandle, alreadyReposted = new Set(), now = Date.now(), event = null, ageFactor = 1) {
  const eventRegex = event ? new RegExp(event.keywords, "i") : null;
  const perSource = [];
  for (const source of REPOST_SOURCES) {
    if (source.eventOnly && !event) continue;
    const entries = feedsByHandle[source.handle] || [];
    const candidates = entries
      .filter((entry) => !entry.reason && entry.post && entry.post.record && !entry.post.record.reply)
      .filter((entry) => !alreadyReposted.has(entry.post.uri))
      .filter((entry) => now - new Date(entry.post.record.createdAt || entry.post.indexedAt).getTime() <= source.maxAgeHours * ageFactor * 3600 * 1000)
      .filter((entry) => {
        const text = normalizeText(entry.post.record.text);
        if (source.exclude.test(text)) return false;
        if (source.eventOnly) return eventRegex.test(text);
        return source.include.test(text) || Boolean(eventRegex && eventRegex.test(text));
      })
      .sort((a, b) => (b.post.likeCount || 0) - (a.post.likeCount || 0));
    perSource.push(candidates.map((entry) => ({ handle: source.handle, uri: entry.post.uri, cid: entry.post.cid, text: entry.post.record.text, likes: entry.post.likeCount || 0 })));
  }
  // Se alternan las fuentes (la mejor de cada una, luego la segunda…) para que los reposts del día no sean todos de la misma cuenta.
  const picks = [];
  for (let rank = 0; perSource.some((list) => rank < list.length); rank += 1) {
    for (const list of perSource) if (rank < list.length) picks.push(list[rank]);
  }
  return picks;
}

async function readFeed(handle) {
  const url = `${PUBLIC_API}/xrpc/app.bsky.feed.getAuthorFeed?${new URLSearchParams({ actor: handle, filter: "posts_no_replies", limit: "30" })}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`No se pudo leer ${handle}: ${response.status}`);
  return (await response.json()).feed || [];
}

// Sigue, de forma gradual, a las cuentas de la lista cerrada de data/editorial.json. Nunca más de followMaxPerRun por ejecución.
async function followFromList(session, { dryRun = false } = {}) {
  const wanted = editorial.follow || [];
  const max = editorial.followMaxPerRun || 3;
  const existing = await xrpc("GET", "com.atproto.repo.listRecords", {
    token: session.accessJwt,
    query: { repo: session.did, collection: "app.bsky.graph.follow", limit: "100" },
  });
  const followed = new Set((existing.records || []).map((record) => record.value && record.value.subject).filter(Boolean));
  const done = [];
  for (const account of wanted) {
    if (done.length >= max) break;
    let did;
    try {
      did = (await xrpc("GET", "com.atproto.identity.resolveHandle", { query: { handle: account.handle } })).did;
    } catch (_error) {
      continue; // Si el handle ya no existe, se salta sin más.
    }
    if (followed.has(did)) continue;
    if (!dryRun) await createRecord(session, "app.bsky.graph.follow", { $type: "app.bsky.graph.follow", subject: did, createdAt: new Date().toISOString() });
    done.push(account.handle);
  }
  return done;
}

// «Me gusta» a publicaciones de las fuentes fiables que encajan con el tema. Máximo editorial.likesPerRun por pasada.
async function likeCandidates(session, candidates, { dryRun = false } = {}) {
  const max = editorial.likesPerRun || 0;
  if (!max || !candidates.length) return [];
  const own = await xrpc("GET", "com.atproto.repo.listRecords", {
    token: session.accessJwt,
    query: { repo: session.did, collection: "app.bsky.feed.like", limit: "100" },
  });
  const liked = new Set((own.records || []).map((record) => record.value && record.value.subject && record.value.subject.uri).filter(Boolean));
  const done = [];
  for (const pick of candidates) {
    if (done.length >= max) break;
    if (liked.has(pick.uri)) continue;
    if (!dryRun) await createRecord(session, "app.bsky.feed.like", { $type: "app.bsky.feed.like", subject: { uri: pick.uri, cid: pick.cid }, createdAt: new Date().toISOString() });
    done.push({ handle: pick.handle, uri: pick.uri });
  }
  return done;
}

// opciones: dryRun (muestra qué haría, sin publicar y sin necesitar la contraseña), now (para pruebas)
async function repostDaily({ dryRun = false, now = Date.now() } = {}) {
  const date = new Date(now);
  const event = activeEvent(date);
  const cap = event && event.repostMaxPerDay ? event.repostMaxPerDay : REPOST_MAX_PER_DAY;
  const feeds = {};
  for (const source of REPOST_SOURCES) {
    if (source.eventOnly && !event) continue;
    try {
      feeds[source.handle] = await readFeed(source.handle);
    } catch (error) {
      if (!source.eventOnly) throw error; // las fuentes del modo evento son opcionales
    }
  }

  const { BLUESKY_HANDLE: handle, BLUESKY_APP_PASSWORD: password } = process.env;
  let session = null;
  let alreadyReposted = new Set();
  let doneToday = 0;
  if (handle && password) {
    session = await login();
    const own = await xrpc("GET", "com.atproto.repo.listRecords", {
      token: session.accessJwt,
      query: { repo: session.did, collection: "app.bsky.feed.repost", limit: "100" },
    });
    const today = madridParts(date).key;
    alreadyReposted = new Set((own.records || []).map((record) => record.value && record.value.subject && record.value.subject.uri).filter(Boolean));
    doneToday = (own.records || []).filter((record) => record.value && record.value.createdAt && madridParts(new Date(record.value.createdAt)).key === today).length;
  } else if (!dryRun) {
    throw new Error("Faltan BLUESKY_HANDLE y BLUESKY_APP_PASSWORD");
  }

  const candidates = pickRepostCandidates(feeds, alreadyReposted, now, event);
  const picks = candidates.slice(0, Math.min(REPOST_MAX_PER_RUN, Math.max(0, cap - doneToday)));
  const follows = session ? await followFromList(session, { dryRun }) : [];
  // «Me gusta» a otras publicaciones que encajan y no se reposteán (las siguientes en la lista), sin repetir las ya marcadas.
  const likePool = pickRepostCandidates(feeds, alreadyReposted, now, event, 3).filter((c) => !picks.some((p) => p.uri === c.uri)); // los «me gusta» admiten publicaciones algo más antiguas
  const likes = session ? await likeCandidates(session, likePool, { dryRun }) : [];
  if (!picks.length) return { reposted: false, liked: likes, followed: follows, event: event && event.id, skipped: "Hoy no hay nada nuevo que repostear (o ya se alcanzó el máximo del día)" };
  const summary = picks.map((p) => ({ handle: p.handle, uri: p.uri, likes: p.likes, text: p.text.replace(/\s+/g, " ").slice(0, 140) }));
  if (dryRun) return { reposted: false, dryRun: true, event: event && event.id, wouldRepost: summary, dedupe: session ? "activo" : "no comprobado (sin contraseña)" };

  for (const pick of picks) {
    const subject = { uri: pick.uri, cid: pick.cid };
    await createRecord(session, "app.bsky.feed.repost", { $type: "app.bsky.feed.repost", subject, createdAt: new Date().toISOString() });
    await createRecord(session, "app.bsky.feed.like", { $type: "app.bsky.feed.like", subject, createdAt: new Date().toISOString() });
  }
  return { reposted: true, items: summary, liked: likes, followed: follows, event: event && event.id };
}

module.exports = { composeDay, composeToday, composePost, composeDonation, postForNow, publishDaily, eligibleCapitals, madridParts, activeEvent, repostDaily, pickRepostCandidates, followFromList };

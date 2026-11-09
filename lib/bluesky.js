// Publicación en Bluesky según el playbook de data/editorial.json:
//  - Madrid y Barcelona a diario (y Valencia en días alternos), con las cifras de data/capital-stats.json (AEMET).
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

// Distintos ángulos con cifras reales de la serie anual de cada estación. Cada uno devuelve [texto, ...variantes de cierre].
const CTA = [(link) => `Compara cualquier día del año 👉 ${link}`, (link) => `Elige tú el día y compruébalo 👉 ${link}`];
const decadeLabel = (d) => `${d.decade}s`;

const ANGLES = [
  ({ capital, nombre, c, trend }) => `📍 ${capital}: la temperatura media anual ha pasado de ${num(c.first.value)} °C (${c.first.from}–${c.first.to}) a ${num(c.last.value)} °C (${c.last.from}–${c.last.to}). Tendencia: ${signed(trend.perDecade, 2)} °C por década. Datos de AEMET, estación de ${nombre}.`,
  ({ capital, nombre, c }) => `¿Hace más calor que antes en ${capital}? Según la estación de ${nombre} (AEMET), la media anual era de ${num(c.first.value)} °C en ${c.first.from}–${c.first.to} y de ${num(c.last.value)} °C en ${c.last.from}–${c.last.to}.`,
  ({ capital, s }) => (s.warmest ? `🌡️ El año más cálido de la serie de ${capital} (AEMET, desde ${s.firstYear}) fue ${s.warmest.year}, con ${num(s.warmest.value)} °C de media. El más frío, ${s.coldest.year}: ${num(s.coldest.value)} °C.` : null),
  ({ capital, s }) => (s.latest && s.latest.rank <= 10 ? `${s.latest.year} fue el ${s.latest.rank}.º año más cálido de los ${s.years} con datos en ${capital}: ${num(s.latest.value)} °C de media (AEMET).` : null),
  ({ capital, s }) => {
    const done = s.decades.filter((d) => d.years >= 8);
    if (done.length < 4) return null;
    const pick = [done[0], done[Math.floor(done.length / 3)], done[Math.floor((2 * done.length) / 3)], done[done.length - 1]];
    return `📈 ${capital}, década a década (media anual, AEMET): ${pick.map((d) => `${decadeLabel(d)} ${num(d.value)} °C`).join(" → ")}.`;
  },
  ({ capital, c, trend }) => `${capital}, ${c.first.from}–${c.first.to} frente a ${c.last.from}–${c.last.to}: ${num(c.first.value)} °C → ${num(c.last.value)} °C de media anual (${signed(c.last.value - c.first.value)} °C). Una sola estación no es el clima global, pero los datos están a la vista (${signed(trend.perDecade, 2)} °C por década).`,
];

// Compone el post de la capital `slug` para la fecha dada. Devuelve null si no se puede.
function composePost(date = new Date(), { slug, salt = 0 } = {}) {
  const eligible = eligibleCapitals();
  if (!eligible.length) return null;
  const when = madridParts(date);
  const capital = slug ? eligible.find((c) => c.slug === slug) : eligible[when.dayIndex % eligible.length];
  if (!capital) return null;

  const s = seo.getStats(capital.slug);
  const url = `${SITE()}/estacion/${capital.slug}`;
  const shownLink = url.replace(/^https?:\/\//, "");
  const data = { capital: capital.lugar, nombre: capital.nombre, c: s.compare, trend: s.trend, s };
  const tags = hashtagsFor(date);

  // Ángulo y cierre cambian cada día; se prueban los siguientes si uno no aplica o no cabe en 300 caracteres.
  let built = null;
  for (let i = 0; i < ANGLES.length * CTA.length && !built; i += 1) {
    const step = when.dayIndex + salt + i;
    const body = ANGLES[step % ANGLES.length](data);
    if (!body) continue;
    const cta = CTA[Math.floor(step / ANGLES.length) % CTA.length](shownLink);
    const candidate = withFacets(`${body}\n\n${cta}`, { link: shownLink, url, tags });
    if (graphemes(candidate.text) <= MAX_GRAPHEMES) built = candidate;
  }
  if (!built) return null;

  const card = {
    uri: url,
    title: `¿Hace más calor que antes en ${capital.lugar}?`,
    description: `Temperatura media anual: ${num(s.compare.last.value)} °C en ${s.compare.last.from}–${s.compare.last.to}. Datos de AEMET.`,
  };
  return { slug: capital.slug, capital: capital.lugar, text: built.text, facets: built.facets, card, url, graphemes: graphemes(built.text), kind: "data" };
}

// Post «para hoy»: la temperatura media de la ventana de ±7 días en torno a hoy, década a década (datos diarios de Atlas), con el gráfico adjunto.
// Es asíncrono porque consulta Atlas. Devuelve null si faltan datos: mejor no publicar que publicar algo dudoso.
const TODAY_BODIES = [
  ({ lugar, d, s }) => `📅 ${lugar}, alrededor del ${d}: ${num(s.last.value)} °C de media en ${s.last.from}–${s.last.to}, frente a ${num(s.first.value)} °C en ${s.first.from}–${s.first.to} (${signed(s.diff)} °C). Datos de AEMET.`,
  ({ lugar, d, s }) => `📅 ¿Cuánto ha cambiado el ${d} en ${lugar}? De ${num(s.first.value)} °C (${s.first.from}–${s.first.to}) a ${num(s.last.value)} °C (${s.last.from}–${s.last.to}): ${signed(s.diff)} °C. Datos de AEMET.`,
];
const TODAY_CTA = [(link) => `Compruébalo para hoy 👉 ${link}`, (link) => `Mira cómo ha variado hoy 👉 ${link}`];

async function composeToday(date = new Date(), { slug } = {}) {
  const when = madridParts(date);
  const capital = capitalsList.find((c) => c.slug === slug);
  const stats = capital && seo.getStats(capital.slug);
  if (!capital || !stats || stats.years < MIN_YEARS) return null;
  const comparison = await todayChart.buildTodayComparison(capital, { year: when.year, month: when.month, day: when.day });
  if (!comparison) return null;

  const url = `${SITE()}/estacion/${capital.slug}`;
  const shownLink = url.replace(/^https?:\/\//, "");
  const data = { lugar: capital.lugar, d: comparison.dayLabel, s: comparison.summary };
  const tags = hashtagsFor(date);
  let built = null;
  for (let i = 0; i < TODAY_BODIES.length && !built; i += 1) {
    const step = when.dayIndex + i;
    const body = TODAY_BODIES[step % TODAY_BODIES.length](data);
    const candidate = withFacets(`${body}\n\n${TODAY_CTA[step % TODAY_CTA.length](shownLink)}`, { link: shownLink, url, tags });
    if (graphemes(candidate.text) <= MAX_GRAPHEMES) built = candidate;
  }
  if (!built) return null;
  return {
    slug: capital.slug,
    capital: capital.lugar,
    text: built.text,
    facets: built.facets,
    card: null,
    image: { png: comparison.png, alt: comparison.alt },
    url,
    dedupe: `📅 ${capital.lugar}`, // distinto del post de datos de la misma capital, que comparte enlace
    graphemes: graphemes(built.text),
    kind: "today",
  };
}

// Petición de ayuda ocasional: honesta, breve, sin cifras ni nombres.
function composeDonation(date = new Date()) {
  const link = KOFI_URL().replace(/^https?:\/\//, "");
  const body = `Secalienta.com es un proyecto personal y no oficial: los costes salen de mi bolsillo. Si te resulta útil y quieres echar una mano, puedes invitarme a un café 👉 ${link}\n\nCompartirlo ya ayuda mucho.`;
  const { text, facets } = withFacets(body, { link, url: KOFI_URL(), tags: [] });
  return { slug: "ayuda", capital: "ayuda", text, facets, card: null, url: KOFI_URL(), graphemes: graphemes(text), kind: "donate" };
}

// ¿Qué toca publicar a esta hora (Madrid)? Devuelve una publicación o null.
// Un slot con kind "today" rota entre las capitales de su lista `rotate` (se repiten las que se quiere ver más).
async function postForNow(date = new Date()) {
  const when = madridParts(date);
  const donate = editorial.donate || {};
  if (donate.enabled && when.hour === donate.hourMadrid && when.dayIndex % donate.everyNDays === 0) return composeDonation(date);
  const slot = (editorial.dailySlots || []).find((s) => s.hourMadrid === when.hour && (!s.everyNthDay || when.dayIndex % s.everyNthDay === 0));
  if (!slot) return null;
  if (slot.kind === "today") return composeToday(date, { slug: slot.rotate[when.dayIndex % slot.rotate.length] });
  return composePost(date, { slug: slot.rotate ? slot.rotate[when.dayIndex % slot.rotate.length] : slot.slug });
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

// ¿Ya se publicó hoy esto mismo? Evita duplicados si la tarea se ejecuta dos veces o se lanza a mano.
async function alreadyPostedToday(token, did, post, todayKey) {
  const list = await xrpc("GET", "com.atproto.repo.listRecords", {
    token,
    query: { repo: did, collection: "app.bsky.feed.post", limit: "30" },
  });
  const marker = post.dedupe || post.url.replace(/^https?:\/\//, "");
  return (list.records || []).some((record) => {
    const value = record.value || {};
    const created = value.createdAt ? madridParts(new Date(value.createdAt)).key : "";
    return created === todayKey && String(value.text || "").includes(marker);
  });
}

// opciones: dryRun (no publica), force (ignora la hora y el duplicado de hoy), slug (capital concreta), today (con slug: post «para hoy» con gráfico), date (para pruebas)
async function publishDaily({ dryRun = false, force = false, slug, today = false, date = new Date() } = {}) {
  const when = madridParts(date);
  const post = slug ? (today ? await composeToday(date, { slug }) : composePost(date, { slug })) : await postForNow(date);
  if (!post) {
    return { posted: false, skipped: slug ? "No hay capital publicable" : `A las ${when.hour}:xx (Madrid) no toca publicar nada` };
  }
  if (dryRun) return { posted: false, dryRun: true, kind: post.kind, text: post.text, graphemes: post.graphemes, url: post.url, withImage: Boolean(post.image), alt: post.image ? post.image.alt : undefined, png: post.image ? post.image.png : undefined };

  const session = await login();
  if (!force && (await alreadyPostedToday(session.accessJwt, session.did, post, when.key))) {
    return { posted: false, skipped: `Ya se publicó hoy ${post.slug}` };
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

module.exports = { composeToday, composePost, composeDonation, postForNow, publishDaily, eligibleCapitals, madridParts, activeEvent, repostDaily, pickRepostCandidates, followFromList };

// Respuestas en Bluesky aprobadas a mano desde Telegram.
// Tres veces al día (cron) se buscan posts recientes de personas reales que hablen del calor en una capital o del cambio
// climático. Se elige uno, se prepara una respuesta con plantilla (sin LLM) y la tarjeta de secalienta.com, y se manda al
// bot de Telegram con dos botones: ✅ Publicar / ❌ Descartar. Solo se publica si se pulsa ✅.
//
// Sin estado: el borrador viaja dentro del propio mensaje de Telegram, que vuelve en el callback. El botón lleva una firma
// (HMAC) del post de destino, el texto y el enlace, así que nadie puede publicar otra cosa aunque consiguiera llamar al webhook.
// En la parte de calor solo se propone si los datos de AEMET dan la razón al post (muy por encima de lo normal). Sin frío.
const crypto = require("crypto");
const bluesky = require("./bluesky");
const todayChart = require("./today-chart");

const SITE = () => (process.env.SITE_URL || "https://secalienta.com").replace(/\/+$/, "");
const SEARCH_API = "https://api.bsky.app/xrpc"; // lectura sin sesión (la de public.api.bsky.app responde 403 a searchPosts)
const SLOTS_UTC = [9, 13, 18]; // 10:00, 14:00 y 19:00 en invierno (hora peninsular): una propuesta por pasada, tres al día
const MIN_DIFF = 2; // °C por encima de la normal del día para decir «muy por encima»
const MIN_DIFF_STREAK = 1.5; // «lleva unos días»: los tres últimos días medidos, todos al menos así
const MAX_RECENT_DAY_AGE = 3; // «está / estos días»: el último dato no puede tener más de 3 días
const APPROVAL_MAX_AGE_MS = 12 * 60 * 60 * 1000; // una propuesta caduca a las 12 h
const MIN_ACCOUNT_AGE_DAYS = 60;
const MIN_FOLLOWERS = 15;
const MAX_POSTS_PER_DAY = 20; // más que esto huele a bot o a cuenta automatizada
const QUERIES = ["calor", "ola de calor", "caluroso", "bochorno", "temperaturas", "cambio climático", "calentamiento global", "crisis climática"];

const MARK_REPLY = "✍️ Respuesta:";
const MARK_LINK = "🔗 ";

// ---------- Texto ----------

const stripAccents = (text) => String(text || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
const lower = (text) => stripAccents(text).toLowerCase();

const DEGREES = /\b(1[89]|2\d|3\d|4\d)([.,']\d)? ?(grados|º|°)/;
const HEAT = new RegExp(`\\bcalor\\b|\\bcaluros|\\bbochorno|ola de calor|temperaturas? (muy )?(altas|disparadas|de verano|veraniegas)|altas temperaturas|\\basfixiante|\\bsofocante|noches? tropical|${DEGREES.source}`);
const COLD = /\bfrio\b|\bhelad|\bnieve|\bnevad|\bgelido|\bcongel/;
// «Calor» que no es el tiempo.
const HEAT_NOISE = /al calor de|calor humano|calor corporal|(dar|da|dan|dame|darte|darle|transmit\w*|buscan?) (\w+ )?calor|caloria|capsaicina|refrigerante|radiador|motor|calor (en|del?) (el |la )?(metro|bus|autobus|tren|vagon|gimnasio|gym|oficina|cocina|horno|cama)/;
const CLIMATE = /cambio climatico|calentamiento global|crisis climatica|emergencia climatica/;
// La plantilla genérica solo encaja si la persona comenta que hace calor para la fecha (no en debates o noticias)…
const WARM_HINT = new RegExp(`${HEAT.source}|temperatura|calefaccion|manga corta|veranillo|en (pleno )?(octubre|noviembre|diciembre|enero|febrero)|🥵|☀️`, "u");
// …y si habla de España (la web es de capitales españolas; la búsqueda en español trae mucho de Latinoamérica).
const SPAIN = /espan|peninsul|andaluc|catalu|aragon|castilla|extremadura|galicia|valencia|madrid|murcia|navarra|asturias|cantabria|rioja|euskadi|pais vasco|canarias|baleares|mallorca/;
// Fuera: política, guerras y sucesos con víctimas (cuenta neutral; no se usa una tragedia para crecer).
const EXCLUDE = /\b(pp|psoe|vox|sumar|podemos|junts|erc|bildu)\b|sanchez|feijoo|abascal|ayuso|puigdemont|trump|milei|netanyahu|putin|guerra|gaza|israel|ucrania|elecciones|electoral|votar|\bvoto|debate|candidat|campana|partido|gobierno|ministr|congreso|parlamento|muert|fallec|victima|cadaver|herido|asesin|chile|argentin|mexic|colombia|peru\b|venezuel|uruguay|ecuador|bolivia|cuba\b/;
// Cuentas de medios, instituciones u organizaciones: aquí solo se responde a personas.
const NOT_A_PERSON = /periodico|periodismo|diario|noticias|\bnews\b|medio de comunicacion|redaccion|revista|magazine|radio|television|\btv\b|\bel pais\b|agencia|ayuntamiento|concello|ajuntament|gobierno|oficial|instituto|institut\b|universidad|universitat|csic|fundacion|fundacio\b|asociacion|associacio|confederacion|federacion|colectivo|plataforma|ecologistas|\bong\b|organizacion|sindicato|partido|recerca|research|parc |hospital|museo|museu|\bbot\b|automati|feed|rss|alertas?\b/;
const ORG_HANDLE = /\.(org|gob\.es|gov|edu|int|eu)$/;

// Nombres con los que la gente menciona cada capital (sin tildes, respetando mayúsculas para no confundir
// «León» con «el león» o «Granada» con la fruta). Si no está aquí, vale el nombre de la capital tal cual.
const ALIASES = {
  "a-coruna": ["A Coruna", "La Coruna", "Coruna"],
  "castellon-almassora": ["Castellon", "Castello"],
  "las-palmas-gran-canaria-aeropuerto": ["Las Palmas"],
  "oviedo-asturias-aeropuerto": ["Oviedo", "Asturias"],
  "palma-aeropuerto": ["Palma de Mallorca", "Mallorca"],
  "san-sebastian-igeldo": ["San Sebastian", "Donostia", "Donosti"],
  "vitoria-gasteiz-foronda": ["Vitoria", "Gasteiz"],
  "girona-aeropuerto": ["Girona", "Gerona"],
  "lleida": ["Lleida", "Lerida"],
  "ourense": ["Ourense", "Orense"],
  "santa-cruz-de-tenerife": ["Santa Cruz de Tenerife"],
};

let capitalMatchers = null;
function matchers() {
  if (capitalMatchers) return capitalMatchers;
  capitalMatchers = bluesky.eligibleCapitals().map((capital) => {
    const names = ALIASES[capital.slug] || [capital.lugar, capital.capital].filter((v, i, a) => v && a.indexOf(v) === i);
    const pattern = names.map((n) => stripAccents(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const tags = names.map((n) => lower(n).replace(/[^a-z0-9]/g, ""));
    return { capital, tags, regex: new RegExp(`(^|[^\\p{L}])(${pattern})(?![\\p{L}])`, "u") };
  });
  return capitalMatchers;
}

// Capital mencionada en el texto (por su nombre o como hashtag, p. ej. #sevilla), solo si es una
// (con varias no sabríamos de cuál hablar).
function capitalIn(text) {
  const plain = stripAccents(text);
  const hashtags = (String(text || "").match(/#[\p{L}\p{N}_]+/gu) || []).map((t) => lower(t.slice(1)));
  const found = matchers().filter((m) => m.regex.test(plain) || m.tags.some((t) => hashtags.includes(t))).map((m) => m.capital);
  return found.length === 1 ? found[0] : null;
}

// ---------- Plantillas (aprobadas el 21-nov-2026; sin frío, sin emojis) ----------

const HEAT_BODIES = {
  day: (d) => `El ${d.dayLabel} ${d.lugar} estuvo muy por encima de lo normal para esa fecha. Tengo un proyecto personal que compara cada día con todos los años desde que hay registros, por si te interesa. ¡Gracias!`,
  streak: (d) => `${d.lugar} lleva unos días muy por encima de su media para estas fechas. Hice esta web para comparar cada día con su historia; por si te interesa echar un vistazo.`,
  recent: (d) => `Los datos de AEMET te dan la razón: ${d.lugar} está muy por encima de lo normal para estos días. Lo puedes ver comparado año a año en este proyecto personal:`,
};
const CLIMATE_BODY = "Si te interesa verlo con datos, tengo un proyecto personal que compara la temperatura de cada día con todos los años en las capitales españolas. ¡Gracias!";

const num = (value) => value.toFixed(1).replace(".", ",");
const signed = (value) => `${value > 0 ? "+" : ""}${num(value)}`;

// Los tres últimos días medidos (el más reciente primero), cada uno frente a su normal 1991–2020.
async function lastDays(capital, today, count = 3) {
  const rows = await todayChart.loadRows(capital);
  if (!rows) return [];
  const days = [];
  let cursor = today;
  for (let i = 0; i < count; i += 1) {
    const day = todayChart.lastDayVsNormal(rows, cursor);
    if (!day) break;
    days.push(day);
    cursor = { year: day.year, month: day.month, day: day.day };
  }
  return days;
}

// Borrador de calor para una capital, o null si los datos no dan la razón.
async function heatDraft(capital, now, salt) {
  const when = bluesky.madridParts(now);
  const days = await lastDays(capital, when);
  const last = days[0];
  if (!last || last.diff < MIN_DIFF) return null;
  const ageDays = Math.round((Date.UTC(when.year, when.month - 1, when.day) - Date.UTC(last.year, last.month - 1, last.day)) / 86400000);
  const options = ["day"];
  if (ageDays <= MAX_RECENT_DAY_AGE) options.push("recent");
  if (ageDays <= MAX_RECENT_DAY_AGE && days.length === 3 && days.every((d) => d.diff >= MIN_DIFF_STREAK)) options.push("streak");
  const variant = options[salt % options.length];
  const url = `${SITE()}/estacion/${capital.slug}`;
  return {
    kind: "heat",
    variant,
    text: HEAT_BODIES[variant]({ dayLabel: last.dayLabel, lugar: capital.lugar }),
    url,
    slug: capital.slug,
    fact: `${last.dayLabel}: ${num(last.tmed)} °C de media frente a ${num(last.normal)} °C normales (${signed(last.diff)} °C)` + (days.length > 1 ? ` · días anteriores: ${days.slice(1).map((d) => signed(d.diff)).join(", ")} °C` : ""),
  };
}

function climateDraft() {
  return { kind: "climate", variant: "climate", text: CLIMATE_BODY, url: `${SITE()}/temperaturas`, slug: null, fact: null };
}

// La tarjeta se reconstruye al publicar a partir del enlace (no hace falta guardarla).
function cardForUrl(url) {
  const slug = (url.match(/\/estacion\/([a-z0-9-]+)$/) || [])[1];
  const capital = slug && bluesky.eligibleCapitals().find((c) => c.slug === slug);
  if (capital) return { slug, card: { uri: url, title: `¿Hace más calor que antes en ${capital.lugar}?`, description: `Compara cada día con todos los años desde que hay registros. Datos de AEMET, estación de ${capital.nombre}.` } };
  return { slug: null, card: { uri: url, title: "Temperaturas históricas de las capitales españolas", description: "Compara la temperatura de cada día con todos los años desde que hay registros. Datos de AEMET." } };
}

// ---------- Búsqueda de candidatos ----------

async function getJson(path, query) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) for (const v of [].concat(value)) params.append(key, v);
  const response = await fetch(`${SEARCH_API}/${path}?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`Bluesky ${path}: ${response.status}`);
  return response.json();
}

// Ventana de la pasada: desde la pasada anterior hasta la hora de esta (no se solapan, así no se repiten propuestas
// aunque Vercel lance la tarea con retraso dentro de la hora).
function windowFor(now = new Date()) {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  // Horas de pasada de ayer y de hoy, en orden; las dos últimas ya cumplidas marcan la ventana.
  const times = [today - 86400000, today].flatMap((day) => SLOTS_UTC.map((h) => day + h * 3600000)).filter((t) => t <= now.getTime());
  const until = times[times.length - 1];
  const since = times[times.length - 2];
  return { since: new Date(since).toISOString(), until: new Date(until).toISOString(), slot: new Date(until).getUTCHours() };
}

// Con sesión (producción) se busca a través del PDS de la cuenta, que permite paginar; sin ella (pruebas en local),
// en la API pública, que solo da la primera página.
async function searchWindow({ since, until }, session) {
  const byUri = new Map();
  for (const q of QUERIES) {
    try {
      let cursor;
      for (let page = 0; page < (session ? 3 : 1); page += 1) {
        const query = { q, lang: "es", sort: "latest", since, until, limit: "100", ...(cursor ? { cursor } : {}) };
        const result = session
          ? await bluesky.xrpc("GET", "app.bsky.feed.searchPosts", { token: session.accessJwt, query })
          : await getJson("app.bsky.feed.searchPosts", query);
        for (const post of result.posts || []) byUri.set(post.uri, post);
        cursor = result.cursor;
        if (!cursor || (result.posts || []).length < 100) break;
      }
    } catch (_error) {
      // Una búsqueda que falla no tumba la pasada.
    }
  }
  return [...byUri.values()];
}

// Filtro del post en sí (sin mirar aún al autor). Devuelve "heat", "climate" o null.
function topicOf(post, ownDid) {
  const record = post.record || {};
  const text = String(record.text || "");
  const plain = lower(text);
  if (!text || post.author.did === ownDid) return null;
  if (record.reply) return null; // solo posts que abren conversación, no hilos ajenos
  if (Array.isArray(record.langs) && record.langs.length && !String(record.langs[0]).startsWith("es")) return null; // en español
  if ((post.labels || []).length || (post.author.labels || []).some((l) => !String(l.val).startsWith("!no-unauthenticated"))) return null;
  if (post.threadgate) return null; // el autor limita quién responde
  const embed = record.embed && record.embed.$type;
  if (embed && !/images|video/.test(embed)) return null; // enlaces a noticias y citas fuera: buscamos opiniones propias
  if (EXCLUDE.test(plain)) return null;
  if (COLD.test(plain)) return null; // sin frío
  const heat = HEAT.test(plain) && !HEAT_NOISE.test(plain);
  const climate = CLIMATE.test(plain) && WARM_HINT.test(plain);
  const city = capitalIn(text);
  if (heat && city) return "heat";
  // Sin ciudad o sin mención a España en el texto se decide luego con el perfil del autor (los «-maybe»).
  if (climate) return SPAIN.test(plain) || city ? "climate" : "climate-maybe";
  if (heat) return "heat-maybe";
  return null;
}

const profileText = (profile) => `${(profile && profile.displayName) || ""}\n${(profile && profile.description) || ""}`;
const isFromSpain = (profile) => Boolean(profile) && (SPAIN.test(lower(profileText(profile))) || Boolean(capitalIn(profileText(profile))));

// Tema definitivo y capital de la respuesta (del texto o, si no la nombra, de la bio del autor).
function resolveTopic(post, topic, profile) {
  const fromText = capitalIn(post.record.text);
  if (topic === "heat") return { topic, capital: fromText, fromProfile: false };
  if (topic === "heat-maybe") {
    const capital = capitalIn(profileText(profile));
    return capital ? { topic: "heat", capital, fromProfile: true } : { topic: null };
  }
  if (topic === "climate-maybe") return { topic: isFromSpain(profile) ? "climate" : null };
  return { topic };
}

function looksLikePerson(profile, now = Date.now()) {
  if (!profile || !profile.createdAt) return false;
  if (ORG_HANDLE.test(profile.handle || "")) return false;
  const ageDays = (now - new Date(profile.createdAt).getTime()) / 86400000;
  if (ageDays < MIN_ACCOUNT_AGE_DAYS) return false;
  if ((profile.followersCount || 0) < MIN_FOLLOWERS) return false;
  if ((profile.postsCount || 0) / ageDays > MAX_POSTS_PER_DAY) return false;
  if (NOT_A_PERSON.test(lower(`${profile.displayName || ""} ${profile.description || ""} ${profile.handle || ""}`))) return false;
  return true;
}

async function profilesFor(dids) {
  const out = new Map();
  for (let i = 0; i < dids.length; i += 25) {
    const { profiles = [] } = await getJson("app.bsky.actor.getProfiles", { actors: dids.slice(i, i + 25) });
    for (const p of profiles) out.set(p.did, p);
  }
  return out;
}

async function alreadyReplied(uri, ownDid) {
  if (!ownDid) return false;
  try {
    const { thread } = await getJson("app.bsky.feed.getPostThread", { uri, depth: "1", parentHeight: "0" });
    return (thread.replies || []).some((reply) => reply.post && reply.post.author.did === ownDid);
  } catch (_error) {
    return true; // si no se puede comprobar, mejor no proponer ni publicar
  }
}

async function resolveOwnDid() {
  const handle = process.env.BLUESKY_HANDLE || "secalienta.bsky.social";
  try {
    return (await getJson("com.atproto.identity.resolveHandle", { handle })).did;
  } catch (_error) {
    return null;
  }
}

// Busca y devuelve las mejores propuestas de la ventana (la primera es la que se manda).
async function findCandidates({ now = new Date(), window = windowFor(now), session = null } = {}) {
  const ownDid = session ? session.did : await resolveOwnDid();
  const posts = await searchWindow(window, session);
  const topical = posts.map((post) => ({ post, topic: topicOf(post, ownDid) })).filter((c) => c.topic);
  const profiles = await profilesFor([...new Set(topical.map((c) => c.post.author.did))]);
  const people = topical
    .map((c) => ({ ...c, ...resolveTopic(c.post, c.topic, profiles.get(c.post.author.did)) }))
    .filter((c) => c.topic && looksLikePerson(profiles.get(c.post.author.did), now.getTime()));
  // Calor con datos primero; dentro de cada tipo, quien tenga más seguidores (más gente verá la respuesta).
  people.sort((a, b) => (a.topic === b.topic ? 0 : a.topic === "heat" ? -1 : 1) || (profiles.get(b.post.author.did).followersCount || 0) - (profiles.get(a.post.author.did).followersCount || 0));

  const salt = bluesky.madridParts(now).dayIndex + SLOTS_UTC.indexOf(window.slot);
  const candidates = [];
  for (const c of people) {
    if (candidates.length >= 3) break;
    const draft = c.topic === "heat" ? await heatDraft(c.capital, now, salt) : climateDraft();
    if (!draft) continue; // los datos no dan la razón: no se propone
    if (await alreadyReplied(c.post.uri, ownDid)) continue;
    if (c.fromProfile) draft.fact = `${draft.fact} · ciudad sacada de su perfil, no del post`;
    candidates.push({ post: c.post, profile: profiles.get(c.post.author.did), draft });
  }
  return { window, scanned: posts.length, topical: topical.length, people: people.length, candidates };
}

// ---------- Telegram ----------

function webhookSecret() {
  const base = process.env.CRON_SECRET;
  return base ? crypto.createHmac("sha256", base).update("telegram-webhook").digest("hex") : null;
}

function sign(did, rkey, text, url) {
  const key = crypto.createHmac("sha256", process.env.CRON_SECRET || "").update("telegram-reply-signature").digest();
  return crypto.createHmac("sha256", key).update(`${did}\n${rkey}\n${text}\n${url}`).digest("base64url").slice(0, 16);
}

async function telegram(method, body) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("Falta TELEGRAM_BOT_TOKEN");
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10000),
  });
  const payload = await response.json().catch(() => null);
  if (!payload || !payload.ok) {
    const error = new Error(`Telegram ${method}: ${(payload && payload.description) || response.status}`);
    error.description = payload && payload.description;
    throw error;
  }
  return payload.result;
}

// Registra (o actualiza) el webhook en cada pasada: es idempotente y así sigue valiendo si cambia CRON_SECRET.
async function ensureWebhook() {
  return telegram("setWebhook", { url: `${SITE()}/api/telegram/webhook`, secret_token: webhookSecret(), allowed_updates: ["callback_query"] });
}

const escapeHtml = (text) => String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function ago(iso, now = Date.now()) {
  const minutes = Math.max(1, Math.round((now - new Date(iso).getTime()) / 60000));
  return minutes < 60 ? `hace ${minutes} min` : `hace ${Math.round(minutes / 60)} h`;
}

function proposalMessage({ post, profile, draft }) {
  const rkey = post.uri.split("/").pop();
  const original = String(post.record.text).slice(0, 500);
  const lines = [
    `💬 <b>@${escapeHtml(post.author.handle)}</b>${profile.displayName ? ` (${escapeHtml(profile.displayName)})` : ""} · ${profile.followersCount} seguidores · ${ago(post.record.createdAt || post.indexedAt)}`,
    `«${escapeHtml(original)}»`,
    `https://bsky.app/profile/${escapeHtml(post.author.handle)}/post/${rkey}`,
    "",
    MARK_REPLY,
    escapeHtml(draft.text),
    "",
    `${MARK_LINK}${escapeHtml(draft.url.replace(/^https?:\/\//, ""))}`,
  ];
  if (draft.fact) lines.push(`📊 ${escapeHtml(draft.fact)}`);
  return lines.join("\n");
}

async function sendProposal(candidate) {
  const { post, draft } = candidate;
  const did = post.author.did;
  const rkey = post.uri.split("/").pop();
  if (!did.startsWith("did:plc:")) throw new Error("Solo se admiten cuentas did:plc");
  const plc = did.slice("did:plc:".length);
  const sig = sign(did, rkey, draft.text, draft.url);
  return telegram("sendMessage", {
    chat_id: process.env.TELEGRAM_CHAT_ID,
    text: proposalMessage(candidate),
    parse_mode: "HTML",
    link_preview_options: { is_disabled: true },
    reply_markup: { inline_keyboard: [[{ text: "✅ Publicar", callback_data: `y:${plc}:${rkey}:${sig}` }, { text: "❌ Descartar", callback_data: "n" }]] },
  });
}

// Tarea programada: busca y manda una propuesta. dryRun devuelve las candidatas sin mandar nada.
async function proposeReply({ dryRun = false, now = new Date() } = {}) {
  const session = process.env.BLUESKY_HANDLE && process.env.BLUESKY_APP_PASSWORD ? await bluesky.login() : null;
  const found = await findCandidates({ now, session });
  const summary = { window: found.window, scanned: found.scanned, topical: found.topical, people: found.people };
  const preview = found.candidates.map((c) => ({ uri: c.post.uri, handle: c.post.author.handle, followers: c.profile.followersCount, post: c.post.record.text, reply: c.draft.text, url: c.draft.url, fact: c.draft.fact }));
  if (dryRun) return { ...summary, dryRun: true, candidates: preview };
  if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) throw new Error("Faltan TELEGRAM_BOT_TOKEN y TELEGRAM_CHAT_ID");
  await ensureWebhook();
  if (!found.candidates.length) return { ...summary, proposed: false };
  await sendProposal(found.candidates[0]);
  return { ...summary, proposed: true, proposal: preview[0] };
}

// ---------- Webhook (pulsación de un botón) ----------

function isWebhookAuthorized(headerValue) {
  const expected = webhookSecret();
  if (!expected) return false;
  const given = Buffer.from(String(headerValue || ""));
  const wanted = Buffer.from(expected);
  return given.length === wanted.length && crypto.timingSafeEqual(given, wanted);
}

function parseDraft(messageText) {
  const text = String(messageText || "");
  const start = text.indexOf(`${MARK_REPLY}\n`);
  const linkAt = text.indexOf(`\n\n${MARK_LINK}`, start);
  if (start < 0 || linkAt < 0) return null;
  const reply = text.slice(start + MARK_REPLY.length + 1, linkAt);
  const link = text.slice(linkAt + 2 + MARK_LINK.length).split("\n")[0].trim();
  return { reply, url: `https://${link}` };
}

async function publishReply({ did, rkey, text, url }) {
  const session = await bluesky.login();
  const uri = `at://${did}/app.bsky.feed.post/${rkey}`;
  if (await alreadyReplied(uri, session.did)) return { skipped: "Ya habías respondido a ese post" };
  const { posts = [] } = await bluesky.xrpc("GET", "app.bsky.feed.getPosts", { token: session.accessJwt, query: { uris: uri } });
  const parent = posts[0];
  if (!parent) return { skipped: "El post ya no existe" };
  if (parent.viewer && parent.viewer.replyDisabled) return { skipped: "El autor no permite respuestas" };
  const root = (parent.record && parent.record.reply && parent.record.reply.root) || { uri: parent.uri, cid: parent.cid };
  const { slug, card } = cardForUrl(url);
  const record = {
    $type: "app.bsky.feed.post",
    text,
    langs: ["es"],
    reply: { root, parent: { uri: parent.uri, cid: parent.cid } },
    createdAt: new Date().toISOString(),
  };
  const thumb = await bluesky.uploadThumb(session.accessJwt, slug);
  record.embed = { $type: "app.bsky.embed.external", external: { ...card, ...(thumb ? { thumb } : {}) } };
  const created = await bluesky.createRecord(session, "app.bsky.feed.post", record);
  return { posted: true, link: `https://bsky.app/profile/${session.handle}/post/${created.uri.split("/").pop()}` };
}

// Procesa una actualización de Telegram ya autenticada (cabecera secreta comprobada por el servidor).
async function handleUpdate(update, now = Date.now()) {
  const query = update && update.callback_query;
  if (!query || !query.message) return { ignored: true };
  const chatId = String(process.env.TELEGRAM_CHAT_ID || "");
  const answer = (text) => telegram("answerCallbackQuery", { callback_query_id: query.id, text }).catch(() => {});
  if (!chatId || String(query.from.id) !== chatId || String(query.message.chat.id) !== chatId) {
    await answer("No autorizado");
    return { ignored: true, reason: "otro usuario" };
  }
  const message = query.message;
  const base = { chat_id: message.chat.id, message_id: message.message_id };
  const original = escapeHtml(message.text || "");

  if (query.data === "n") {
    await telegram("editMessageText", { ...base, text: `${original}\n\n❌ Descartada`, parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch(() => {});
    await answer("Descartada");
    return { discarded: true };
  }

  const [kind, plc, rkey, sig] = String(query.data || "").split(":");
  const draft = parseDraft(message.text);
  if (kind !== "y" || !plc || !rkey || !sig || !draft) {
    await answer("Propuesta no válida");
    return { ignored: true, reason: "datos no válidos" };
  }
  const did = `did:plc:${plc}`;
  const expected = sign(did, rkey, draft.reply, draft.url);
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    await answer("Firma no válida");
    return { ignored: true, reason: "firma" };
  }
  if (now - message.date * 1000 > APPROVAL_MAX_AGE_MS) {
    await telegram("editMessageText", { ...base, text: `${original}\n\n⌛ Caducada (más de 12 h)`, parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch(() => {});
    await answer("Caducada");
    return { expired: true };
  }

  // Cerrojo: el primer toque quita los botones; un segundo toque llega a un mensaje ya editado y Telegram responde
  // «message is not modified», así que no se publica dos veces.
  try {
    await telegram("editMessageText", { ...base, text: `${original}\n\n⏳ Publicando…`, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
  } catch (error) {
    await answer("Ya se está publicando");
    return { ignored: true, reason: "doble toque" };
  }

  try {
    const result = await publishReply({ did, rkey, text: draft.reply, url: draft.url });
    const status = result.posted ? `✅ Publicada: ${escapeHtml(result.link)}` : `⚠️ No publicada: ${escapeHtml(result.skipped)}`;
    await telegram("editMessageText", { ...base, text: `${original}\n\n${status}`, parse_mode: "HTML", link_preview_options: { is_disabled: true } }).catch(() => {});
    await answer(result.posted ? "Publicada" : result.skipped);
    return result;
  } catch (error) {
    // Vuelven los botones para poder reintentar.
    await telegram("editMessageText", {
      ...base,
      text: `${original}\n\n⚠️ Error al publicar: ${escapeHtml(String(error.message || error).slice(0, 200))}`,
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
      reply_markup: message.reply_markup,
    }).catch(() => {});
    await answer("Error al publicar");
    throw error;
  }
}

module.exports = { proposeReply, findCandidates, handleUpdate, isWebhookAuthorized, windowFor, topicOf, capitalIn, looksLikePerson, parseDraft, proposalMessage, sign, heatDraft, cardForUrl };

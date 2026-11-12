// Noticias de terceros en Bluesky (clima, energía, ciencia del clima e inventos), además de los posts de datos propios.
// Lee los RSS de data/editorial.json (news.sources), filtra por tema, descarta opinión, publicidad, política de partidos
// y sucesos, evita repetir la misma historia contada por dos medios y publica UNA por pasada del cron, hasta news.perDay al día.
// El post es el titular literal + «Vía <medio>» + la tarjeta con enlace a la noticia original: nada de texto propio,
// nada inventado y sin LLM (coste cero).
const editorial = require("../data/editorial.json");
const bluesky = require("./bluesky");

const config = () => editorial.news || {};
const SITE_HOST = () => new URL(process.env.SITE_URL || "https://secalienta.com").hostname;
const MAX_GRAPHEMES = 300;
const USER_AGENT = "Mozilla/5.0 (compatible; secalienta-bot/1.0; +https://secalienta.com)";

const normalize = (text) =>
  String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();

// Temas: una fuente no «topical» solo entra si el titular o la entradilla encajan con alguno.
const CLIMATE = /calentamiento|cambio climatico|crisis climatica|emergencia climatica|\bclima\b|climatic|emisiones|\bco2\b|dioxido de carbono|metano|efecto invernadero|temperatura|ola de calor|calor extremo|record de calor|sequia|glaciar|deshielo|hielo marino|permafrost|nivel del mar|oceano|corales|incendios? forestal|\bdana\b|inundaci|cop ?31|cumbre del clima|ipcc|copernicus|aemet|biodiversidad|contaminacion|adaptacion|descarboniz|huella de carbono|captura de carbono|meteorolog|fenomeno (de )?el nino|fenomeno (de )?la nina|atmosfera/;
const ENERGY = /energia|renovable|energia solar|placas? solares?|paneles? solares?|(planta|parque|central) solar|termosolar|fotovoltaic|eolic|aerogenerador|hidrogeno|bateria|almacenamiento|red electrica|autoconsumo|nuclear|fusion nuclear|geotermi|petroleo|combustible|coche electrico|vehiculo electrico|bomba de calor|eficiencia energetica|electrificacion|apagon|biocombustible|hidroelectric/;

// Fuera: opinión, publicidad y ofertas, gadgets, directos, autopromoción de los medios, política de partidos y guerras
// (cuenta neutral) y sucesos con víctimas (no se usa una tragedia para crecer).
const EXCLUDE = /opinion|tribuna|editorial|columna|carta al director|patrocinad|publicidad|contenido de marca|oferta|chollo|descuento|rebaja|precio de su|black friday|cyber monday|singles day|amazon|aliexpress|cupon|sorteo|horoscopo|anuncios de empresas|podcast|newsletter|boletin semanal|programa|episodio|en directo|en vivo|minuto a minuto|ultima hora|entradas|premios|organiza|\bdebate|partidos|\b(pp|psoe|vox|sumar|podemos|junts|erc|bildu)\b|sanchez|feijoo|abascal|ayuso|puigdemont|trump|milei|maduro|putin|netanyahu|guerra|israel|gaza|palestin|ucrania|rusia|\biran\b|muert|fallec|victima|cadaver|asesin|herido|movil|smartphone|iphone|samsung|xiaomi|realme|portatil|auriculares|smartwatch|tablet|consola|\bmah\b/;
const EXCLUDE_URL = /\/opinion\/|\/tribuna\/|\/blogs?\/|\/branded|\/patrocinado|\/escaparate\/|\/compras\/|\/ofertas?\//;
// Titulares que son una cita («…» o "…" larga) o una firma («… Por Fulana»): son opinión de alguien, no un hecho.
// También los que acaban en número de episodio («… Mangas Verdes 505»).
const QUOTE_OR_BYLINE = /[«"“][^»"”]{12,}[»"”]|\.\s+Por\s+\p{Lu}|\s\d{2,4}$/u;

// ---------- Lectura de RSS / Atom (sin dependencias) ----------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", laquo: "«", raquo: "»", ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’", ndash: "–", mdash: "—", iexcl: "¡", iquest: "¿" };

function decodeEntities(text) {
  return String(text || "").replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, code) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

const stripCdata = (text) => String(text || "").replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
// Texto plano: sin CDATA, sin etiquetas y sin entidades (en ese orden; algunas entradillas vienen con HTML escapado dos veces).
function plain(text) {
  let out = decodeEntities(stripCdata(text).replace(/<[^>]+>/g, " "));
  if (/<[a-z/][^>]*>/i.test(out)) out = decodeEntities(out.replace(/<[^>]+>/g, " "));
  return out.replace(/\s+/g, " ").trim();
}

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return match ? match[1] : "";
}

function attr(block, tagName, attribute, filter) {
  const regex = new RegExp(`<${tagName}\\b[^>]*>`, "gi");
  for (const element of block.match(regex) || []) {
    if (filter && !filter.test(element)) continue;
    const value = element.match(new RegExp(`\\b${attribute}=["']([^"']+)["']`, "i"));
    if (value) return decodeEntities(value[1]);
  }
  return "";
}

function parseFeed(xml) {
  const items = [];
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>/gi) || xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  for (const block of blocks) {
    const title = plain(tag(block, "title"));
    const link = plain(tag(block, "link")) || attr(block, "link", "href", /rel=["']alternate["']|^(?!.*rel=)/i) || attr(block, "link", "href");
    const date = plain(tag(block, "pubDate") || tag(block, "published") || tag(block, "updated") || tag(block, "dc:date"));
    const description = plain(tag(block, "description") || tag(block, "summary") || tag(block, "content:encoded") || tag(block, "content"));
    const categories = (block.match(/<category\b[^>]*>[\s\S]*?<\/category>/gi) || []).map((c) => plain(c.replace(/^<category\b[^>]*>|<\/category>$/gi, "")));
    const image =
      attr(block, "media:content", "url", /medium=["']image|type=["']image|\.(jpe?g|png|webp)/i) ||
      attr(block, "media:thumbnail", "url") ||
      attr(block, "enclosure", "url", /type=["']image/i);
    const time = Date.parse(date);
    if (!title || !/^https?:\/\//.test(link)) continue;
    items.push({ title, link, time: Number.isFinite(time) ? time : null, description, categories, image });
  }
  return items;
}

async function readSource(source) {
  const response = await fetch(source.url, { headers: { "User-Agent": USER_AGENT, Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml" }, signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`${source.name}: ${response.status}`);
  return parseFeed(await response.text()).map((item) => ({ ...item, source: source.name, category: source.category, topical: Boolean(source.topical) }));
}

// ---------- Selección ----------
// Enlace sin parámetros de campaña ni ancla: sirve para reconocer una noticia ya publicada.
function canonicalLink(link) {
  try {
    const url = new URL(link);
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|ref$|fbclid|gclid|mc_|ns_|int$|ocid)/i.test(key)) url.searchParams.delete(key);
    return url.toString().replace(/\/$/, "");
  } catch (_error) {
    return link;
  }
}

// Palabras con peso de un titular, para detectar la misma historia en dos medios.
const STOPWORDS = new Set("para por con sin sobre entre desde hasta como cuando donde segun tras ante bajo contra durante mediante esta este estos estas esos esas aquel otra otro otras otros todo toda todos todas cada mas menos muy tambien solo pero porque aunque mientras unos unas una uno los las del que han hay ser sera son fue era tiene tienen puede pueden nueva nuevo nuevas nuevos".split(" "));
function keywords(title) {
  return new Set(
    normalize(title)
      .replace(/[^a-z0-9ñ ]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 3 && !STOPWORDS.has(word))
  );
}
function similar(a, b) {
  const x = keywords(a);
  const y = keywords(b);
  if (!x.size || !y.size) return false;
  let shared = 0;
  for (const word of x) if (y.has(word)) shared += 1;
  return shared / Math.min(x.size, y.size) >= 0.6 || shared / new Set([...x, ...y]).size >= 0.4;
}

function isEligible(item, now, maxAgeHours) {
  if (!item.time || item.time > now + 3600 * 1000 || now - item.time > maxAgeHours * 3600 * 1000) return false;
  if (EXCLUDE_URL.test(item.link)) return false;
  const text = normalize(`${item.title} ${item.categories.join(" ")}`);
  if (EXCLUDE.test(text) || QUOTE_OR_BYLINE.test(item.title)) return false;
  // Titulares muy cortos (o con pinta de portada de sección) no se entienden solos.
  if (item.title.length < 30) return false;
  if (item.topical) return true;
  // En medios generalistas solo cuenta el titular: la entradilla menciona el clima o una batería con demasiada facilidad.
  const title = normalize(item.title);
  return CLIMATE.test(title) || ENERGY.test(title);
}

// Elige la siguiente noticia: el tema que toca según «order», fuente que no se haya usado hoy si puede ser, y la más reciente.
// `published`: noticias propias recientes ({ link, title, source, createdAt }).
function pickNews(items, published, now = Date.now()) {
  const cfg = config();
  const today = bluesky.madridParts(new Date(now)).key;
  const todays = published.filter((p) => bluesky.madridParts(new Date(p.createdAt)).key === today);
  const order = cfg.order && cfg.order.length ? cfg.order : ["clima", "energia", "ciencia", "inventos"];
  const usedLinks = new Set(published.map((p) => canonicalLink(p.link)));
  const usedSources = new Set(todays.map((p) => p.source));
  const lastSource = todays.length ? todays[0].source : null;

  const seen = [];
  const pool = items
    .filter((item) => isEligible(item, now, cfg.maxAgeHours || 30))
    .filter((item) => !usedLinks.has(canonicalLink(item.link)))
    .filter((item) => !published.some((p) => similar(p.title, item.title)))
    .sort((a, b) => b.time - a.time)
    // Dentro del lote, la misma historia en varios medios cuenta una vez (se queda la más reciente).
    .filter((item) => {
      if (seen.some((title) => similar(title, item.title))) return false;
      seen.push(item.title);
      return true;
    });

  const start = todays.length % order.length;
  for (let i = 0; i < order.length; i += 1) {
    const category = order[(start + i) % order.length];
    const inCategory = pool.filter((item) => item.category === category && item.source !== lastSource);
    if (!inCategory.length) continue;
    return inCategory.find((item) => !usedSources.has(item.source)) || inCategory[0];
  }
  return pool.find((item) => item.source !== lastSource) || null;
}

// ---------- Post ----------
function graphemes(text) {
  return [...new Intl.Segmenter("es", { granularity: "grapheme" }).segment(text)].length;
}

function truncate(text, max) {
  const parts = [...new Intl.Segmenter("es", { granularity: "grapheme" }).segment(text)].map((s) => s.segment);
  return parts.length <= max ? text : `${parts.slice(0, max - 1).join("").replace(/\s+\S*$/, "")}…`;
}

function composeNews(item, date = new Date()) {
  const cfg = config();
  const tags = [];
  const event = bluesky.activeEvent(date);
  if (event && new RegExp(event.keywords, "i").test(normalize(`${item.title} ${item.description}`))) tags.push(...event.hashtags);
  const categoryTag = (cfg.hashtags || {})[item.category];
  if (categoryTag) tags.push(categoryTag);
  const suffix = `\n\nVía ${item.source}`;
  const tagsLength = tags.length ? 2 + tags.map((t) => `#${t}`).join(" ").length : 0;
  const title = truncate(item.title, MAX_GRAPHEMES - graphemes(suffix) - tagsLength);
  const { text, facets } = bluesky.withFacets(`${title}${suffix}`, { tags });
  const card = { uri: item.link, title: truncate(item.title, 300), description: truncate(item.description || "", 280) };
  return { kind: "news", text, facets, card, image: item.image || null, source: item.source, category: item.category, link: item.link, graphemes: graphemes(text) };
}

// Imagen de la tarjeta: la del RSS o, si no trae, la og:image de la página. Si pesa demasiado o falla, la tarjeta sale sin imagen.
async function findImage(item) {
  if (item.image) return item.image;
  try {
    const response = await fetch(item.link, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return null;
    const html = (await response.text()).slice(0, 300000);
    const meta = html.match(/<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image)["'][^>]*>/i);
    const content = meta && meta[0].match(/content=["']([^"']+)["']/i);
    return content ? new URL(decodeEntities(content[1]), item.link).toString() : null;
  } catch (_error) {
    return null;
  }
}

async function uploadCardImage(token, imageUrl) {
  if (!imageUrl) return null;
  try {
    const response = await fetch(imageUrl, { headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
    const type = (response.headers.get("content-type") || "").split(";")[0].trim();
    if (!response.ok || !/^image\/(jpeg|png|webp)$/.test(type)) return null;
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > 950000) return null; // límite de Bluesky para miniaturas (~1 MB)
    return (await bluesky.xrpc("POST", "com.atproto.repo.uploadBlob", { token, body: bytes, headers: { "Content-Type": type } })).blob;
  } catch (_error) {
    return null;
  }
}

// Noticias ya publicadas por la cuenta: posts con tarjeta que enlaza fuera de secalienta.com.
function ownNews(records) {
  const host = SITE_HOST();
  return records
    .filter((value) => value.embed && value.embed.$type === "app.bsky.embed.external" && value.embed.external)
    .filter((value) => {
      try {
        return !new URL(value.embed.external.uri).hostname.endsWith(host);
      } catch (_error) {
        return false;
      }
    })
    .map((value) => ({
      link: value.embed.external.uri,
      title: value.embed.external.title || "",
      source: (String(value.text || "").match(/\nVía ([^\n]+)/) || [])[1] || "",
      createdAt: value.createdAt,
    }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function readAllSources() {
  const sources = config().sources || [];
  const results = await Promise.allSettled(sources.map(readSource));
  const items = [];
  const failed = [];
  results.forEach((result, index) => (result.status === "fulfilled" ? items.push(...result.value) : failed.push(sources[index].name)));
  return { items, failed, total: sources.length };
}

// opciones: dryRun (muestra la noticia elegida sin publicar; si hay contraseña también descarta las ya publicadas), now (para pruebas)
async function publishNews({ dryRun = false, now = Date.now() } = {}) {
  const cfg = config();
  if (!cfg.enabled) return { posted: false, skipped: "Noticias desactivadas en data/editorial.json" };
  const date = new Date(now);
  const { items, failed, total } = await readAllSources();
  // Si fallan casi todas las fuentes algo va mal (bloqueo, cambio de formato): se avisa.
  const alert = failed.length > total / 2 ? `fallan ${failed.length} de ${total} fuentes RSS (${failed.join(", ")})` : undefined;

  const { BLUESKY_HANDLE: handle, BLUESKY_APP_PASSWORD: password } = process.env;
  let session = null;
  let published = [];
  if (handle && password) {
    session = await bluesky.login();
    published = ownNews(await bluesky.recentOwnPosts(session.accessJwt, session.did, 100));
  } else if (!dryRun) {
    throw new Error("Faltan BLUESKY_HANDLE y BLUESKY_APP_PASSWORD");
  }

  const today = bluesky.madridParts(date).key;
  const doneToday = published.filter((p) => bluesky.madridParts(new Date(p.createdAt)).key === today).length;
  if (doneToday >= (cfg.perDay || 10)) return { posted: false, skipped: `Ya van ${doneToday} noticias hoy`, alert };

  const item = pickNews(items, published, now);
  if (!item) return { posted: false, skipped: "No hay noticias nuevas que encajen", read: items.length, failed, alert };
  const post = composeNews(item, date);
  if (dryRun) return { posted: false, dryRun: true, doneToday, category: post.category, source: post.source, text: post.text, graphemes: post.graphemes, link: post.link, image: post.image || "(og:image al publicar)", read: items.length, failed, dedupe: session ? "activo" : "no comprobado (sin contraseña)" };

  const thumb = await uploadCardImage(session.accessJwt, await findImage(item));
  const record = {
    $type: "app.bsky.feed.post",
    text: post.text,
    facets: post.facets,
    langs: ["es"],
    createdAt: new Date().toISOString(),
    embed: { $type: "app.bsky.embed.external", external: { ...post.card, ...(thumb ? { thumb } : {}) } },
  };
  const created = await bluesky.createRecord(session, "app.bsky.feed.post", record);
  return { posted: true, kind: "news", category: post.category, source: post.source, title: item.title, link: item.link, uri: created.uri, withThumb: Boolean(thumb), doneToday: doneToday + 1, alert };
}

module.exports = { publishNews, pickNews, parseFeed, composeNews, readAllSources, isEligible, similar, ownNews, findImage };

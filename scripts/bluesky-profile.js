// Ajustes del perfil de Bluesky que no van por cron: nombre, bio, post fijado y starter pack (ver «profile» en data/editorial.json).
// Uso (con BLUESKY_HANDLE y BLUESKY_APP_PASSWORD en .env):
//   node scripts/bluesky-profile.js --dry-run                     (muestra qué cambiaría, sin tocar nada)
//   node scripts/bluesky-profile.js                               (nombre y bio; quita el post fijado si ya no existe)
//   node scripts/bluesky-profile.js --pin=https://bsky.app/profile/secalienta.bsky.social/post/3m...   (fija ese post)
//   node scripts/bluesky-profile.js --starter-pack                (crea el starter pack si no existe y muestra su enlace)
require("dotenv").config({ quiet: true });
const editorial = require("../data/editorial.json");
const { xrpc, login, createRecord } = require("../lib/bluesky");

const PUBLIC_API = "https://public.api.bsky.app";
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const pinArg = (args.find((arg) => arg.startsWith("--pin=")) || "").slice("--pin=".length);
const config = editorial.profile || {};

async function publicGet(method, query) {
  const response = await fetch(`${PUBLIC_API}/xrpc/${method}?${new URLSearchParams(query)}`, { signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw new Error(`${method}: ${response.status}`);
  return response.json();
}

// https://bsky.app/profile/<handle o did>/post/<rkey>  o  at://<did>/app.bsky.feed.post/<rkey>  →  { uri, cid } (null si no existe)
async function resolvePost(link) {
  let uri = link;
  const web = link.match(/bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/);
  if (web) {
    const did = web[1].startsWith("did:") ? web[1] : (await publicGet("com.atproto.identity.resolveHandle", { handle: web[1] })).did;
    uri = `at://${did}/app.bsky.feed.post/${web[2]}`;
  }
  const { posts = [] } = await publicGet("app.bsky.feed.getPosts", { uris: uri });
  return posts[0] ? { uri: posts[0].uri, cid: posts[0].cid } : null;
}

async function updateProfile(session) {
  const current = await xrpc("GET", "com.atproto.repo.getRecord", { token: session.accessJwt, query: { repo: session.did, collection: "app.bsky.actor.profile", rkey: "self" } });
  const record = { ...current.value };
  const changes = [];
  if (config.displayName && record.displayName !== config.displayName) {
    changes.push(`nombre: «${record.displayName || ""}» → «${config.displayName}»`);
    record.displayName = config.displayName;
  }
  if (config.description && record.description !== config.description) {
    changes.push("bio actualizada");
    record.description = config.description;
  }
  if (pinArg) {
    const pinned = await resolvePost(pinArg);
    if (!pinned) throw new Error(`No existe el post ${pinArg}`);
    changes.push(`post fijado: ${pinned.uri}`);
    record.pinnedPost = pinned;
  } else if (record.pinnedPost && !(await resolvePost(record.pinnedPost.uri))) {
    // El post fijado se borró: el perfil enseña un hueco. Se quita (y conviene fijar otro con --pin).
    changes.push("quitado el post fijado (ya no existe)");
    delete record.pinnedPost;
  }
  if (!changes.length) return ["perfil sin cambios"];
  if (!dryRun) {
    await xrpc("POST", "com.atproto.repo.putRecord", {
      token: session.accessJwt,
      body: JSON.stringify({ repo: session.did, collection: "app.bsky.actor.profile", rkey: "self", record, swapRecord: current.cid }),
      headers: { "Content-Type": "application/json" },
    });
  }
  return changes;
}

async function createStarterPack(session) {
  const pack = config.starterPack;
  if (!pack) return "No hay starterPack en data/editorial.json";
  const existing = await xrpc("GET", "com.atproto.repo.listRecords", { token: session.accessJwt, query: { repo: session.did, collection: "app.bsky.graph.starterpack", limit: "50" } });
  const found = (existing.records || []).find((r) => r.value && r.value.name === pack.name);
  const handle = process.env.BLUESKY_HANDLE;
  if (found) return `Ya existe: https://bsky.app/starter-pack/${handle}/${found.uri.split("/").pop()}`;

  const members = [];
  for (const member of pack.members) {
    try {
      members.push({ handle: member, did: (await publicGet("com.atproto.identity.resolveHandle", { handle: member })).did });
    } catch (_error) {
      console.warn(`Se salta ${member}: no se encuentra`);
    }
  }
  if (dryRun) return `Crearía «${pack.name}» con ${members.length} cuentas (más esta): ${members.map((m) => m.handle).join(", ")}`;

  const now = () => new Date().toISOString();
  const list = await createRecord(session, "app.bsky.graph.list", { $type: "app.bsky.graph.list", purpose: "app.bsky.graph.defs#referencelist", name: pack.name, description: pack.description, createdAt: now() });
  // La propia cuenta va en la lista: quien use el pack también la sigue.
  for (const did of [session.did, ...members.map((m) => m.did)]) {
    await createRecord(session, "app.bsky.graph.listitem", { $type: "app.bsky.graph.listitem", subject: did, list: list.uri, createdAt: now() });
  }
  const created = await createRecord(session, "app.bsky.graph.starterpack", { $type: "app.bsky.graph.starterpack", name: pack.name, description: pack.description, list: list.uri, createdAt: now() });
  return `Creado: https://bsky.app/starter-pack/${handle}/${created.uri.split("/").pop()}`;
}

(async () => {
  const session = await login();
  for (const change of await updateProfile(session)) console.log(`${dryRun ? "[dry-run] " : ""}${change}`);
  if (args.includes("--starter-pack")) console.log(`${dryRun ? "[dry-run] " : ""}${await createStarterPack(session)}`);
})()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => process.exit());

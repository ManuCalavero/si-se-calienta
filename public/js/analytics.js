// Consentimiento y Google Tag Manager.
// Hasta que el visitante pulsa «Aceptar» no se carga nada de Google. «Declinar» no carga nada y se recuerda.
// La etiqueta de GA4 (G-N7Q7DCPW4L) se configura dentro del contenedor GTM, no aquí.
const GTM_ID = "GTM-5CW9RVXM";
const STORAGE_KEY = "secalienta-consent";

const banner = document.getElementById("consent");
const acceptBtn = document.getElementById("consent-accept");
const declineBtn = document.getElementById("consent-decline");
const reopenBtn = document.getElementById("consent-reopen");

let gtmLoaded = false;

function readChoice() {
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

function saveChoice(value) {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    // Sin almacenamiento (modo privado): la decisión vale solo para esta visita.
  }
}

// Snippet estándar de GTM.
function loadGtm() {
  if (gtmLoaded) return;
  gtmLoaded = true;
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ "gtm.start": Date.now(), event: "gtm.js" });
  const script = document.createElement("script");
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtm.js?id=${GTM_ID}`;
  document.head.appendChild(script);
}

// Quien retira el consentimiento después de darlo: se borran las cookies de Google y se recarga sin GTM.
function clearGoogleCookies() {
  const host = location.hostname.split(".");
  const domains = ["", ...host.map((_, i) => `.${host.slice(i).join(".")}`)];
  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0].trim();
    if (!/^_ga|^_gid|^_gat/.test(name)) continue;
    for (const domain of domains) {
      document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/${domain ? `; domain=${domain}` : ""}`;
    }
  }
}

// La altura del banner la usan los elementos fijos de abajo (barra, hoja, aviso) para no quedar tapados.
function syncHeight() {
  const height = banner.hidden ? 0 : banner.offsetHeight;
  document.body.style.setProperty("--consent-h", `${height}px`);
  document.body.classList.toggle("has-consent", height > 0);
}

function show() {
  banner.hidden = false;
  syncHeight();
}

function hide() {
  banner.hidden = true;
  syncHeight();
}

function decide(value) {
  const wasGranted = readChoice() === "granted";
  saveChoice(value);
  hide();
  if (value === "granted") {
    loadGtm();
  } else if (wasGranted || gtmLoaded) {
    clearGoogleCookies();
    location.reload();
  }
}

if (banner && acceptBtn && declineBtn) {
  new ResizeObserver(syncHeight).observe(banner);
  acceptBtn.addEventListener("click", () => decide("granted"));
  declineBtn.addEventListener("click", () => decide("denied"));
  reopenBtn?.addEventListener("click", show);

  const choice = readChoice();
  if (choice === "granted") loadGtm();
  else if (choice !== "denied") show();
}

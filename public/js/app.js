import { analyze } from "./stats.js";
import { anomalyColor, formatDuration, formatNumber, formatSigned, monthName, prettyDay, titleCase } from "./format.js";
import { anomalyScale, highlightYear, onChartHover, renderTemperatureChart, resizeCharts, setSeriesVisibility } from "./charts.js";
import { clearSelection, createMap, focusStation, resetView, setStations, updateCached } from "./map.js";
import { canvasToBlob, drawShareCard, shareCaption, shareFileName } from "./share.js";
import { COFFEE_EUROS, KOFI_USERNAME, LINKS, MONTHLY_COSTS, QUICK_PICKS, VISIT_EUROS } from "./config.js";

const $ = (id) => document.getElementById(id);

const els = {
  map: $("map"),
  searchInput: $("search-input"),
  searchResults: $("search-results"),
  dateInput: $("date"),
  dayLabel: $("day-label"),
  dayText: $("day-text"),
  prevDay: $("prev-day"),
  nextDay: $("next-day"),
  todayBtn: $("today-btn"),
  aboutBtn: $("about-btn"),
  backgroundPill: $("background-download"),
  backgroundText: $("background-download-text"),
  home: $("home"),
  backBtn: $("back-btn"),
  quickPicks: $("quick-picks"),
  dock: $("dock"),
  dockLocate: $("dock-locate"),
  searchLocate: $("search-locate"),
  panel: $("panel"),
  panelBody: $("panel-body"),
  sheetHandle: $("sheet-handle"),
  eyebrow: $("panel-eyebrow"),
  title: $("panel-title"),
  sub: $("panel-sub"),
  rigorBtn: $("rigor-btn"),
  rigorPop: $("rigor-pop"),
  rigorWindow: $("rigor-window"),
  expandBtn: $("expand-btn"),
  tabSummaryBtn: $("tab-btn-summary"),
  tabTableBtn: $("tab-btn-table"),
  tabSummary: $("tab-summary"),
  tabTable: $("tab-table"),
  tabTableCount: $("tab-table-count"),
  progressBox: $("panel-progress"),
  progressBar: $("progress-bar"),
  status: $("status"),
  hero: document.querySelector(".hero"),
  headline: $("headline"),
  subline: $("subline"),
  kpis: $("kpis"),
  modeToggle: document.querySelector(".chart-card .segmented"),
  chartNote: $("chart-note"),
  stripes: $("stripes"),
  stripesStart: $("stripes-start"),
  stripesEnd: $("stripes-end"),
  stripesHover: $("stripes-hover"),
  chart: $("chart"),
  seriesToggles: $("series-toggles"),
  stationFacts: $("station-facts"),
  stationBtn: $("station-btn"),
  stationPop: $("station-pop"),
  stationWarn: $("station-warn"),
  qualityFacts: $("quality-facts"),
  statsFacts: $("stats-facts"),
  tableCaption: $("table-caption"),
  tableBody: document.querySelector("#results-table tbody"),
  csvBtn: $("csv-btn"),
  shareBtn: $("share-btn"),
  shareDialog: $("share-dialog"),
  shareClose: $("share-close"),
  shareCanvas: $("share-canvas"),
  shareFormats: document.querySelector(".share-formats"),
  shareNative: $("share-native"),
  shareDownload: $("share-download"),
  shareCopy: $("share-copy"),
  donateTotal: $("donate-total"),
  costList: $("cost-list"),
  kofiLink: $("kofi-link"),
  donateEq: $("donate-equivalence"),
  donateVisit: $("donate-visit"),
  donateBtn: $("donate-btn"),
  donateBtnAmount: $("donate-btn-amount"),
  donateCard: document.querySelector(".donate"),
  toast: $("toast"),
};

const state = {
  stations: [],
  byId: new Map(),
  cached: new Map(),
  selectedId: "",
  month: "",
  day: "",
  result: null,
  analysis: null,
  jobToken: "",
  mode: "window",
  direction: 0,
  tab: "summary",
  shareFormat: "square",
  visibility: { tmax: true, tmin: true, prec: true },
  scanningStations: new Set(),
  searchMatches: [],
  searchIndex: -1,
};

// Resultados ya vistos por estación y día: volver a un día es instantáneo.
const resultCache = new Map();
const prefetching = new Set();
const RESULT_CACHE_LIMIT = 60;
// Año bisiesto de referencia para poder navegar también por el 29 de febrero.
const REF_YEAR = 2024;

let audioContext = null;
let toastTimer = 0;
let backgroundTimer = 0;
let loadTimer = 0;

const isMobile = () => window.matchMedia("(max-width: 760px)").matches;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const pad = (value) => String(value).padStart(2, "0");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- Datos de estaciones ----------

function parseCoordinate(rawValue, isLatitude) {
  if (rawValue === undefined || rawValue === null || rawValue === "") return null;
  const text = String(rawValue).trim().toUpperCase();
  const asNumber = Number(text.replace(",", "."));
  if (Number.isFinite(asNumber)) return asNumber;

  const match = text.replace(/\s+/g, "").match(isLatitude ? /^(\d{2})(\d{2})(\d{2})([NS])$/ : /^(\d{2,3})(\d{2})(\d{2})([EW])$/);
  if (!match) return null;
  const decimal = Number(match[1]) + Number(match[2]) / 60 + Number(match[3]) / 3600;
  return match[4] === "S" || match[4] === "W" ? -decimal : decimal;
}

function normalizeText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

function normalizeStation(raw) {
  const station = {
    idema: raw.idema || raw.indicativo,
    nombre: raw.nombre,
    provincia: raw.provincia,
    altitud: Number.isFinite(Number(raw.altitud)) && raw.altitud !== null ? Number(raw.altitud) : null,
    latitud: parseCoordinate(raw.latitud, true),
    longitud: parseCoordinate(raw.longitud, false),
  };
  station.nombreVisible = titleCase(station.nombre);
  station.provinciaVisible = titleCase(station.provincia);
  station.searchName = normalizeText(station.nombre);
  station.searchProvince = normalizeText(station.provincia);
  return station;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const contentType = String(response.headers.get("content-type") || "");
  const payload = contentType.includes("application/json") ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    throw new Error((payload && payload.error) || "El servidor no ha respondido correctamente");
  }
  return payload;
}

async function refreshCached() {
  try {
    const payload = await fetchJson("/api/stations/cached");
    state.cached = new Map(payload.stations.map((item) => [item.station, item]));
    updateCached(new Set(state.cached.keys()));
  } catch (_error) {
    // Sin esta lista solo se pierde el color de las estaciones descargadas.
  }
}


// ---------- Sonido y avisos ----------

// Safari y Chrome solo permiten audio si el contexto se crea/reanuda durante un gesto del usuario.
function unlockAudio() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    if (!audioContext) audioContext = new AudioCtx();
    if (audioContext.state === "suspended") audioContext.resume();
  } catch (_error) {
    audioContext = null;
  }
}

function playChime(isError = false) {
  if (!audioContext) return;
  try {
    const notes = isError ? [440, 330] : [660, 880];
    const now = audioContext.currentTime;
    notes.forEach((frequency, index) => {
      const oscillator = audioContext.createOscillator();
      const gain = audioContext.createGain();
      const start = now + index * 0.15;
      oscillator.type = "sine";
      oscillator.frequency.value = frequency;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.18, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      oscillator.connect(gain).connect(audioContext.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.4);
    });
  } catch (_error) {
    // Sin audio la notificacion visual sigue funcionando.
  }
}


function showToast(text, isError = false) {
  els.toast.textContent = text;
  els.toast.classList.toggle("toast-error", isError);
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    els.toast.hidden = true;
  }, 6000);
}

// ---------- Fecha ----------

function dateFromState() {
  return new Date(REF_YEAR, Number(state.month) - 1, Number(state.day));
}

function todayParts() {
  const today = new Date();
  return { month: pad(today.getMonth() + 1), day: pad(today.getDate()) };
}

function isToday() {
  const today = todayParts();
  return today.month === state.month && today.day === state.day;
}

function shortDay(month, day) {
  return `${Number(day)} ${monthName(month).slice(0, 3)}`;
}

function windowText(month, day) {
  const center = new Date(REF_YEAR, Number(month) - 1, Number(day));
  const from = new Date(center);
  from.setDate(center.getDate() - 7);
  const to = new Date(center);
  to.setDate(center.getDate() + 7);
  return `del ${shortDay(pad(from.getMonth() + 1), from.getDate())} al ${shortDay(pad(to.getMonth() + 1), to.getDate())}`;
}

function renderDayNav() {
  const long = prettyDay(state.month, state.day);
  const text = document.createElement("span");
  text.className = "day-text-inner";
  const longEl = document.createElement("span");
  longEl.className = "day-long";
  longEl.textContent = long;
  const shortEl = document.createElement("span");
  shortEl.className = "day-short";
  shortEl.textContent = shortDay(state.month, state.day);
  text.append(longEl, shortEl);

  // Con pulsaciones rápidas solo se anima la última salida; las anteriores se retiran ya.
  while (els.dayText.children.length > 1) els.dayText.firstElementChild.remove();
  const previous = els.dayText.lastElementChild;
  if (previous && state.direction && !reducedMotion()) {
    previous.classList.add(state.direction > 0 ? "leave-next" : "leave-prev");
    text.classList.add(state.direction > 0 ? "enter-next" : "enter-prev");
    els.dayText.appendChild(text);
    setTimeout(() => previous.remove(), 260);
  } else {
    els.dayText.replaceChildren(text);
  }

  const today = isToday();
  els.todayBtn.classList.toggle("is-today", today);
  els.todayBtn.disabled = today;
  els.todayBtn.setAttribute("aria-label", today ? "Estás viendo el día de hoy" : "Volver a hoy");
  els.dayLabel.setAttribute("aria-label", `Elegir día. Ahora: ${long}${today ? ", hoy" : ""}`);
  els.dateInput.value = `${REF_YEAR}-${state.month}-${state.day}`;
}

function setDay(month, day, direction = 0) {
  if (month === state.month && day === state.day) return;
  state.month = month;
  state.day = day;
  state.direction = direction;
  renderDayNav();
  updateUrl();
  if (state.selectedId) {
    unlockAudio();
    scheduleLoad();
  }
}

function shiftDay(delta) {
  const date = dateFromState();
  date.setDate(date.getDate() + delta);
  setDay(pad(date.getMonth() + 1), pad(date.getDate()), delta);
}

function goToday() {
  const today = todayParts();
  const target = new Date(REF_YEAR, Number(today.month) - 1, Number(today.day));
  setDay(today.month, today.day, Math.sign(target - dateFromState()));
}

function openDatePicker() {
  if (typeof els.dateInput.showPicker === "function") {
    try {
      els.dateInput.showPicker();
      return;
    } catch (_error) {
      // Algunos navegadores lo bloquean fuera de un gesto; se cae al foco.
    }
  }
  els.dateInput.focus();
  els.dateInput.click();
}

// ---------- Bienvenida y llamada a la acción ----------

// El inicio tiene tres estados que comparten los mismos nodos (marca, buscador y día):
//   "home"    · tarjeta abierta con la explicación (body.welcome-open)
//   "station" · barra compacta con «Volver» y el panel de resultado (body.has-selection)
//   "compact" · solo la barra, en móvil, mientras se explora el mapa
// Los cambios de estado pasan por morph(), que los anima con View Transitions cuando hay soporte.

function viewState() {
  if (document.body.classList.contains("has-selection")) return "station";
  return document.body.classList.contains("welcome-open") ? "home" : "compact";
}

let morphing = null;

function morph(update) {
  if (!document.startViewTransition || reducedMotion() || document.hidden) {
    update();
    return;
  }
  if (morphing) morphing.skipTransition();
  document.documentElement.classList.add("is-morphing");
  morphing = document.startViewTransition(update);
  const done = morphing;
  done.finished.finally(() => {
    if (morphing !== done) return;
    morphing = null;
    document.documentElement.classList.remove("is-morphing");
  });
}

function applyViewState(next) {
  document.body.classList.toggle("welcome-open", next === "home");
  els.aboutBtn.setAttribute("aria-expanded", String(next === "home"));
  // Volver solo existe para el teclado y los lectores cuando hay estación.
  els.backBtn.tabIndex = next === "station" ? 0 : -1;
  els.aboutBtn.tabIndex = next === "station" ? -1 : 0;
  if (next === "home") els.home.scrollTop = 0;
  // En la bienvenida el buscador es la acción principal y pregunta; con estación, solo etiqueta.
  els.searchInput.placeholder = next === "home" ? "Busca tu ciudad" : "Ciudad o estación";
}

function setViewState(next, { animate = true } = {}) {
  if (viewState() === next) return;
  if (animate) morph(() => applyViewState(next));
  else applyViewState(next);
}

// «Volver» deja la app como al llegar: sin estación, con la tarjeta abierta y el mapa entero.
function goHome() {
  if (viewState() !== "station") return;
  const focusBack = document.activeElement === els.backBtn;
  morph(() => {
    closePanel();
    applyViewState("home");
  });
  resetView();
  if (focusBack) requestAnimationFrame(() => els.aboutBtn.focus({ preventScroll: true }));
}

function renderQuickPicks() {
  const picks = QUICK_PICKS.filter((pick) => state.byId.has(pick.id) && state.cached.has(pick.id)).slice(0, 5);
  els.quickPicks.parentElement.hidden = picks.length === 0;
  els.quickPicks.replaceChildren(
    ...picks.map((pick) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chip-btn";
      button.dataset.id = pick.id;
      const since = state.cached.get(pick.id).firstYear;
      button.innerHTML = `<span></span>`;
      button.firstChild.textContent = pick.label;
      if (since) {
        const small = document.createElement("small");
        small.textContent = `desde ${since}`;
        button.appendChild(small);
      }
      return button;
    })
  );
}

function applyLinks() {
  for (const link of document.querySelectorAll("[data-link]")) {
    const href = LINKS[link.dataset.link];
    if (href) link.href = href;
  }
}

function renderDonate() {
  const total = MONTHLY_COSTS.reduce((acc, item) => acc + item.euros, 0);
  els.donateTotal.textContent = `${formatNumber(total, 0)} € al mes`;
  // Barra de KPIs: una celda por gasto con su nombre y su importe.
  els.costList.replaceChildren(
    ...MONTHLY_COSTS.map((item) => {
      const li = document.createElement("li");
      const label = document.createElement("span");
      label.className = "cost-label";
      label.textContent = item.label;
      const value = document.createElement("strong");
      value.className = "cost-value";
      value.textContent = `${formatNumber(item.euros, 0)} €`;
      li.append(label, value);
      return li;
    })
  );
  const visit = `${formatNumber(VISIT_EUROS, 2)} €`;
  els.donateBtnAmount.textContent = visit;
  els.donateBtn.setAttribute("aria-label", `Aportar ${visit}: ver cómo ayudar a mantener la web`);
  els.donateVisit.textContent =
    `Cada visita cuesta de media unos ${visit}. Pero en aportes tan pequeños las comisiones del pago se comen casi todo, así que, si puedes, pon algo más.`;
  const days = Math.floor(COFFEE_EUROS / (total / 30));
  els.donateEq.textContent = `Con ${COFFEE_EUROS} € cubres ${days === 1 ? "un día" : `unos ${days} días`} de la app.`;
  els.kofiLink.href = `https://ko-fi.com/${encodeURIComponent(KOFI_USERNAME)}`;
}

// El botón de la cantidad lleva al módulo de donación del resumen y lo resalta un momento.
function goToDonate() {
  if (state.tab !== "summary") setTab("summary");
  els.donateCard.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "center" });
  els.donateCard.classList.remove("is-flash");
  void els.donateCard.offsetWidth;
  els.donateCard.classList.add("is-flash");
}

// ---------- Panel ----------

function openPanel() {
  document.body.classList.add("has-selection");
  if (!els.panel.hidden && els.panel.classList.contains("open")) return;
  els.panel.hidden = false;
  requestAnimationFrame(() => {
    els.panel.classList.add("open");
    placeTabIndicator();
  });
}

function closePanel() {
  state.jobToken = "";
  state.selectedId = "";
  state.result = null;
  state.analysis = null;
  clearTimeout(loadTimer);
  document.body.classList.remove("has-selection");
  els.panel.classList.remove("open", "expanded", "is-refreshing");
  els.expandBtn.setAttribute("aria-expanded", "false");
  toggleRigor(false);
  toggleStationPop(false);
  clearSelection();
  updateUrl();
  setTimeout(() => {
    if (!els.panel.classList.contains("open")) els.panel.hidden = true;
  }, reducedMotion() ? 0 : 400);
}

function toggleExpanded(force) {
  const expanded = force ?? !els.panel.classList.contains("expanded");
  els.panel.classList.toggle("expanded", expanded);
  els.expandBtn.setAttribute("aria-expanded", String(expanded));
  els.sheetHandle.setAttribute("aria-label", expanded ? "Reducir panel" : "Ampliar panel");
  setTimeout(resizeCharts, reducedMotion() ? 0 : 480);
}

// En móvil la barra de inicio va abajo: su altura la usan el aviso, la atribución y el mapa para no quedar tapados.
function watchBottomBar() {
  const apply = () => {
    const compact =
      isMobile() && !document.body.classList.contains("has-selection") && !document.body.classList.contains("welcome-open");
    document.body.style.setProperty("--bar-h", compact ? `${els.home.offsetHeight}px` : "0px");
  };
  new ResizeObserver(apply).observe(els.home);
  new MutationObserver(apply).observe(document.body, { attributes: true, attributeFilter: ["class"] });
  window.addEventListener("resize", apply);
  apply();
}

// Desplazamiento para centrar la península en el hueco libre: a la izquierda de la tarjeta en escritorio,
// por encima de la hoja en móvil. El margen derecho de la tarjeta (--gap) también cuenta como ocupado.
function homeOffset() {
  const gap = 16;
  if (isMobile()) return [0, Math.round(els.home.offsetHeight / 2)];
  return [Math.round((els.home.offsetWidth + gap) / 2), 0];
}

function panelOffset() {
  if (isMobile()) {
    return [0, Math.round(window.innerHeight * 0.3)];
  }
  return [Math.round((els.panel.offsetWidth + 24) / 2), 0];
}

function setTab(tab, { focus = false } = {}) {
  state.tab = tab;
  const isSummary = tab === "summary";
  els.tabSummaryBtn.setAttribute("aria-selected", String(isSummary));
  els.tabTableBtn.setAttribute("aria-selected", String(!isSummary));
  els.tabSummaryBtn.tabIndex = isSummary ? 0 : -1;
  els.tabTableBtn.tabIndex = isSummary ? -1 : 0;
  els.tabSummary.hidden = !isSummary;
  els.tabTable.hidden = isSummary;
  els.panel.dataset.tab = tab;
  els.panelBody.scrollTop = 0;
  placeTabIndicator();
  if (focus) (isSummary ? els.tabSummaryBtn : els.tabTableBtn).focus();
  if (isSummary) requestAnimationFrame(resizeCharts);
}

function placeTabIndicator() {
  const active = state.tab === "summary" ? els.tabSummaryBtn : els.tabTableBtn;
  const indicator = document.querySelector(".tab-indicator");
  if (!active.offsetWidth) return;
  indicator.style.width = `${active.offsetWidth}px`;
  indicator.style.transform = `translateX(${active.offsetLeft - els.tabSummaryBtn.offsetLeft}px)`;
}

function toggleRigor(force) {
  const open = force ?? els.rigorPop.hidden;
  els.rigorPop.hidden = !open;
  els.rigorBtn.setAttribute("aria-expanded", String(open));
  if (open) toggleStationPop(false);
}

function toggleStationPop(force) {
  const open = force ?? els.stationPop.hidden;
  els.stationPop.hidden = !open;
  els.stationBtn.setAttribute("aria-expanded", String(open));
  if (open) toggleRigor(false);
}

function setProgress(percent, message) {
  const active = percent !== null;
  els.progressBox.hidden = !active;
  els.panelBody.classList.toggle("is-loading", active && !state.result);
  if (active) {
    els.progressBar.style.width = `${Math.max(3, Math.min(100, percent))}%`;
    els.status.textContent = message;
  }
}

function describeProgress(progress) {
  const percent = Number(progress.percent || 0);
  const eta = formatDuration(progress.etaSeconds);
  if (Number(progress.throttledSeconds || 0) > 0) {
    return `AEMET pide una pausa (límite de peticiones). Reanudando en ${progress.throttledSeconds} s · ${percent}% · quedan ${eta}`;
  }
  if (Number(progress.completed || 0) === 0 && Number(progress.chunksAhead || 0) > 0) {
    return `En cola detrás de otras descargas · listo en ${eta}`;
  }
  return `Descargando el histórico de AEMET por primera vez · ${percent}% · quedan ${eta}`;
}

// ---------- Render ----------

// Interpola desde el valor que ya se mostraba: al cambiar de día los números ruedan, no saltan.
function tweenNumber(element, target, format, { from = null, duration = 620 } = {}) {
  cancelAnimationFrame(element._raf || 0);
  const start = from ?? element._value;
  element._value = target;
  if (reducedMotion() || target === null || !Number.isFinite(target) || start === null || start === undefined || !Number.isFinite(start)) {
    element.textContent = format(target);
    return;
  }
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / duration);
    const eased = 1 - (1 - t) ** 4;
    element.textContent = format(start + (target - start) * eased);
    if (t < 1) element._raf = requestAnimationFrame(step);
  };
  element._raf = requestAnimationFrame(step);
}

function nudge(element) {
  if (reducedMotion() || !state.direction) return;
  const name = state.direction > 0 ? "nudge-next" : "nudge-prev";
  element.classList.remove("nudge-next", "nudge-prev");
  void element.offsetWidth;
  element.classList.add(name);
}

function renderHeader(station, analysis) {
  els.eyebrow.textContent = `Estación ${station.idema} · ${station.provinciaVisible}`;
  els.title.textContent = station.nombreVisible;
  const period = analysis && analysis.firstYear ? ` · ${analysis.firstYear}–${analysis.lastYear}` : "";
  // El día ya está en el selector de arriba: aquí solo cómo se calcula y el periodo.
  const how = state.mode === "day" ? "Solo ese día" : `Media ${windowText(state.month, state.day)}`;
  els.sub.textContent = `${how}${period}`;
  els.rigorWindow.textContent =
    state.mode === "day"
      ? `Ahora ves el valor del ${prettyDay(state.month, state.day)} exacto. Un día suelto varía mucho de un año a otro: la media de ±7 días es más fiable.`
      : `Cada punto es la media de 15 días (${windowText(state.month, state.day)}) para que un día raro no domine. Si quieres, cambia a “Día exacto”.`;
}

function renderHeadline(station, analysis) {
  const day = prettyDay(state.month, state.day);
  els.headline.replaceChildren();
  els.subline.textContent = "";

  if (!analysis.change) {
    els.headline.textContent = `Aún no hay suficientes años con datos para medir cómo ha cambiado el ${day} en ${station.nombreVisible}.`;
    els.headline._delta = null;
    return;
  }

  const { delta, earlyRange, lateRange } = analysis.change;
  const warm = delta >= 0;
  const emphasis = document.createElement("span");
  emphasis.className = `delta ${warm ? "is-warm" : "is-cool"}`;
  const number = document.createElement("span");
  number.className = "delta-num";
  emphasis.append(number, ` °C más ${warm ? "cálido" : "fresco"}`);
  // El día y la estación ya están en la cabecera: aquí solo va el dato.
  els.headline.append(emphasis, ` en ${lateRange[0]}–${lateRange[1]} que en ${earlyRange[0]}–${earlyRange[1]}.`);
  tweenNumber(number, Math.abs(delta), (v) => formatNumber(v), { from: els.headline._delta ?? null });
  els.headline._delta = Math.abs(delta);

  const parts = [];
  if (analysis.latest) {
    const { year, rank, of } = analysis.latest;
    if (rank === 1) parts.push(`${year}, el más cálido de ${of} años.`);
    else parts.push(`${year}, ${rank}.º más cálido de ${of} años.`);
  }
  if (analysis.verdict !== "warming" && analysis.verdict !== "cooling") {
    parts.push("Tendencia poco clara.");
  }
  if (analysis.pending) {
    const { year, tmed, days, of } = analysis.pending;
    parts.push(`${year}, pendiente: ${formatNumber(tmed)} °C con ${days} de ${of} días.`);
  }
  els.subline.textContent = parts.join(" ");
}

const KPI_DEFS = [
  { key: "change", label: "Cambio" },
  { key: "trend", label: "Tendencia" },
  { key: "warmest", label: "Año más cálido" },
  { key: "record", label: "Récord del día" },
  { key: "rain", label: "Lluvia" },
];

function ensureKpis() {
  if (els.kpis.children.length === KPI_DEFS.length) return;
  els.kpis.replaceChildren(
    ...KPI_DEFS.map((def) => {
      const card = document.createElement("article");
      card.className = "kpi";
      card.dataset.key = def.key;
      card.innerHTML = '<span class="kpi-label"></span><strong class="kpi-value">—</strong><span class="kpi-sub">&nbsp;</span>';
      card.querySelector(".kpi-label").textContent = def.label;
      return card;
    })
  );
}

function toneFor(value, threshold = 0.05) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  if (value > threshold) return "tone-warm";
  if (value < -threshold) return "tone-cool";
  return "";
}

function setKpi(key, { value, format, sub, tone = "", title = "" }) {
  const card = els.kpis.querySelector(`[data-key="${key}"]`);
  if (!card) return;
  card.className = `kpi ${tone}`;
  card.title = title;
  tweenNumber(card.querySelector(".kpi-value"), value, format);
  card.querySelector(".kpi-sub").textContent = sub;
}

const degrees = (v) => (v === null || v === undefined || !Number.isFinite(v) ? "—" : `${formatNumber(v)} °C`);

function renderKpis(analysis) {
  ensureKpis();
  const { change, trend, record, warmest } = analysis;
  setKpi("change", {
    value: change ? change.delta : null,
    format: (v) => (v === null ? "—" : `${formatSigned(v)} °C`),
    sub: change ? `${change.lateRange[0]}–${change.lateRange[1]} vs ${change.earlyRange[0]}–${change.earlyRange[1]}` : "Pocos años con datos",
    tone: toneFor(change && change.delta),
    title: "Media de los últimos años frente a la de los primeros",
  });
  setKpi("trend", {
    value: trend ? trend.slopePerDecade : null,
    format: (v) => (v === null ? "—" : `${formatSigned(v, 2)} °C`),
    sub: trend ? `por década · ${trend.firstYear}–${trend.lastYear}` : "Mínimo 10 años",
    tone: toneFor(trend && trend.slopePerDecade, 0.02),
    title: "Pendiente de la recta de tendencia",
  });
  setKpi("warmest", {
    value: warmest ? warmest.year : null,
    format: (v) => (v === null ? "—" : String(Math.round(v))),
    sub: warmest ? `${degrees(warmest.tmed)} de media` : "Sin datos",
    title: state.mode === "day" ? "Año con la media más alta ese día" : "Año con la media de ±7 días más alta",
  });
  setKpi("record", {
    value: record ? record.value : null,
    format: degrees,
    sub: record ? `Máxima del día exacto · ${record.year}` : "Sin datos",
    title: "Temperatura máxima registrada exactamente ese día",
  });
  setKpi("rain", {
    value: analysis.precipMean,
    format: (v) => (v === null ? "—" : `${formatNumber(v)} mm`),
    sub: state.mode === "day" ? "Media de ese día" : "Media diaria · ±7 días",
  });
}

function renderSkeleton() {
  els.headline.textContent = "";
  els.headline._delta = null;
  els.subline.textContent = "";
  ensureKpis();
  for (const value of els.kpis.querySelectorAll(".kpi-value")) {
    cancelAnimationFrame(value._raf || 0);
    value._value = null;
    value.textContent = "00,0 °C";
  }
  for (const sub of els.kpis.querySelectorAll(".kpi-sub")) sub.innerHTML = "&nbsp;";
  els.stripes.replaceChildren();
  els.stationFacts.replaceChildren();
  els.qualityFacts.replaceChildren();
  els.tableBody.replaceChildren();
  els.tabTableCount.textContent = "";
}

function renderStripes(analysis) {
  if (!analysis.firstYear) {
    els.stripes.replaceChildren();
    els.stripesStart.textContent = "";
    els.stripesEnd.textContent = "";
    return;
  }

  const scale = anomalyScale(analysis);
  const rows = analysis.complete.filter((row) => row.year >= analysis.firstYear && row.year <= analysis.lastYear);
  const reuse = els.stripes.children.length === rows.length && els.stripes.firstElementChild.dataset.year === String(rows[0].year);
  if (!reuse) els.stripes.replaceChildren(...rows.map(() => document.createElement("span")));

  // El cambio de color avanza como una ola en el sentido en que se ha movido el día.
  const waveStep = reuse && !reducedMotion() ? Math.min(6, 280 / rows.length) : 0;
  rows.forEach((row, index) => {
    const stripe = els.stripes.children[index];
    const anomaly = analysis.anomalies.get(row.year);
    const color = anomalyColor(anomaly, scale);
    const order = state.direction < 0 ? rows.length - 1 - index : index;
    stripe.style.transitionDelay = `${Math.round(order * waveStep)}ms`;
    stripe.dataset.year = String(row.year);
    stripe.dataset.label = color ? `${row.year} · ${formatSigned(anomaly)} °C` : `${row.year} · sin datos`;
    stripe.className = color ? "" : "stripe-missing";
    stripe.style.backgroundColor = color || "";
  });
  els.stripesStart.textContent = analysis.firstYear;
  els.stripesEnd.textContent = analysis.lastYear;
}

function markStripe(year) {
  for (const stripe of els.stripes.querySelectorAll(".is-hot")) stripe.classList.remove("is-hot");
  const stripe = year === null ? null : els.stripes.querySelector(`[data-year="${year}"]`);
  if (stripe) stripe.classList.add("is-hot");
  els.stripes.classList.toggle("has-hot", Boolean(stripe));
  els.stripesHover.textContent = stripe ? stripe.dataset.label : "";
}

function stripeFromPointer(event) {
  const rect = els.stripes.getBoundingClientRect();
  const count = els.stripes.children.length;
  if (!count) return null;
  const index = Math.floor(((event.clientX - rect.left) / rect.width) * count);
  return els.stripes.children[Math.max(0, Math.min(count - 1, index))];
}

function fact(list, label, value) {
  const dt = document.createElement("dt");
  dt.textContent = label;
  const dd = document.createElement("dd");
  dd.textContent = value;
  list.append(dt, dd);
}

function renderFacts(station, result, analysis) {
  els.stationFacts.replaceChildren();
  fact(els.stationFacts, "Indicativo", station.idema);
  fact(els.stationFacts, "Provincia", station.provinciaVisible);
  fact(els.stationFacts, "Altitud", Number.isFinite(station.altitud) ? `${station.altitud} m` : "—");
  if (Number.isFinite(station.latitud) && Number.isFinite(station.longitud)) {
    const lat = `${formatNumber(Math.abs(station.latitud), 2)}° ${station.latitud >= 0 ? "N" : "S"}`;
    const lon = `${formatNumber(Math.abs(station.longitud), 2)}° ${station.longitud >= 0 ? "E" : "O"}`;
    fact(els.stationFacts, "Coordenadas", `${lat}, ${lon}`);
  }
  const history = result.history || {};
  fact(els.stationFacts, "Registros", history.complete && history.firstYear ? `${history.firstYear}–${history.lastYear}` : "Buscando…");
  fact(els.stationFacts, "Fuente", "AEMET OpenData");

  els.qualityFacts.replaceChildren();
  const span = analysis.firstYear ? analysis.lastYear - analysis.firstYear + 1 : 0;
  fact(els.qualityFacts, "Años con dato", span ? `${analysis.valid.length} de ${span}` : "—");
  fact(els.qualityFacts, "Huecos", analysis.gaps.length ? analysis.gaps.join(", ") : "Ninguno");
  fact(els.qualityFacts, "Cálculo", state.mode === "day" ? "Valor del día exacto" : "Media de ±7 días (mín. 10 con dato)");
  fact(
    els.qualityFacts,
    "Histórico",
    history.complete ? "Completo" : history.scanning ? "Buscando registros más antiguos…" : "Desde 1976 de momento"
  );
  const pending = Array.isArray(result.failedYears) && result.failedYears.length;
  if (pending) {
    fact(els.qualityFacts, "Pendiente", `${result.failedYears.length} años por descargar (se reintentan solos)`);
  }

  // Aviso en la badge solo cuando importa: pocos años, muchos huecos o años sin descargar.
  const coverage = span ? analysis.valid.length / span : 0;
  els.stationWarn.hidden = !(pending || analysis.valid.length < 30 || coverage < 0.85);
}

function renderStats(analysis) {
  const { trend, trendCommon, change } = analysis;
  els.statsFacts.replaceChildren();
  fact(
    els.statsFacts,
    "Pendiente",
    trend ? `${formatSigned(trend.slopePerDecade, 2)} ± ${formatNumber(trend.stderrPerDecade * 2, 2)} °C/década` : "—"
  );
  fact(els.statsFacts, "R²", trend ? formatNumber(trend.r2, 2) : "—");
  fact(els.statsFacts, "Años usados", trend ? String(trend.n) : String(analysis.valid.length));
  fact(els.statsFacts, "Tendencia 1976–hoy", trendCommon ? `${formatSigned(trendCommon.slopePerDecade, 2)} °C/década` : "—");
  fact(
    els.statsFacts,
    "Medias comparadas",
    change ? `${formatNumber(change.earlyMean)} → ${formatNumber(change.lateMean)} °C (${change.size} años)` : "—"
  );
}

function hasAnyData(row) {
  return row.tmed !== null || row.tmax !== null || row.tmin !== null || row.prec !== null;
}

// Tabla completa: todos los años desde el primero con dato, también los huecos, del más reciente al más antiguo.
function renderTable(analysis) {
  const firstIndex = analysis.rows.findIndex(hasAnyData);
  const rows = firstIndex === -1 ? [] : analysis.rows.slice(firstIndex).reverse();
  const scale = anomalyScale(analysis);
  const lastComplete = analysis.complete.length ? analysis.complete[analysis.complete.length - 1].year : null;
  let coldest = null;
  for (const row of analysis.valid) if (!coldest || row.tmed < coldest.tmed) coldest = row;
  const gapCount = rows.filter((row) => !hasAnyData(row)).length;

  els.tabTableCount.textContent = rows.length ? String(rows.length) : "";
  requestAnimationFrame(placeTabIndicator);
  els.tableCaption.textContent = rows.length
    ? `${rows.length} años · ${rows[rows.length - 1].year}–${rows[0].year} · ${gapCount ? `${gapCount} sin datos` : "sin huecos"} · ${
        state.mode === "day" ? "día exacto" : "media ±7 días"
      }`
    : "Sin datos todavía";

  els.tableBody.replaceChildren(
    ...rows.map((row) => {
      const tr = document.createElement("tr");
      const yearCell = document.createElement("th");
      yearCell.scope = "row";
      yearCell.textContent = String(row.year);
      tr.appendChild(yearCell);

      if (row.year > lastComplete) {
        const tag = document.createElement("span");
        tag.className = "row-tag";
        tag.textContent = analysis.pending && row.year === analysis.pending.year ? "pendiente" : "en curso";
        yearCell.appendChild(tag);
        tr.classList.add("is-current");
      } else if (analysis.warmest && row.year === analysis.warmest.year) {
        tr.classList.add("is-warmest");
      } else if (coldest && row.year === coldest.year) {
        tr.classList.add("is-coldest");
      }

      if (!hasAnyData(row)) {
        tr.classList.add("is-gap");
        const td = document.createElement("td");
        td.colSpan = 5;
        td.textContent = row.year > lastComplete ? "Este día aún no tiene datos" : "Sin datos de AEMET";
        tr.appendChild(td);
        return tr;
      }

      const anomaly = analysis.anomalies.get(row.year);
      const barCell = document.createElement("td");
      barCell.className = "col-anomaly";
      if (anomaly !== undefined) {
        const bar = document.createElement("span");
        bar.className = "anomaly";
        const fill = document.createElement("i");
        const share = Math.min(1, Math.abs(anomaly) / scale);
        fill.style.width = `${share * 50}%`;
        fill.style[anomaly >= 0 ? "left" : "right"] = "50%";
        fill.style.background = anomalyColor(anomaly, scale);
        const label = document.createElement("b");
        label.textContent = formatSigned(anomaly);
        bar.append(fill);
        barCell.append(bar, label);
      } else {
        barCell.textContent = "—";
      }
      tr.appendChild(barCell);

      for (const value of [formatNumber(row.tmed), formatNumber(row.tmax), formatNumber(row.tmin), row.prec === null ? "—" : `${formatNumber(row.prec)} mm`]) {
        const td = document.createElement("td");
        td.textContent = value;
        if (value === "—") td.className = "is-missing";
        tr.appendChild(td);
      }
      return tr;
    })
  );
}

function renderChartNote() {
  els.chartNote.textContent =
    state.mode === "day"
      ? `Cada punto es el ${prettyDay(state.month, state.day)} de un año. Línea discontinua: tendencia. Pasa el dedo o el ratón por el gráfico.`
      : `Cada punto es la media ${windowText(state.month, state.day)} de un año. Línea discontinua: tendencia.`;
}

function renderResult(result, { partial = false } = {}) {
  const station = state.byId.get(state.selectedId);
  if (!station) return;
  const analysis = analyze(result, state.mode);
  state.analysis = analysis;

  renderHeader(station, analysis);
  renderHeadline(station, analysis);
  nudge(els.hero);
  renderKpis(analysis);
  renderStripes(analysis);
  renderTemperatureChart(els.chart, analysis, state.visibility);
  renderChartNote();
  renderFacts(station, result, analysis);
  renderStats(analysis);
  renderTable(analysis);
  els.panelBody.classList.remove("is-loading");
  els.shareBtn.disabled = partial;
  state.direction = 0;
}

function downloadCsv() {
  const station = state.byId.get(state.selectedId);
  if (!station || !state.analysis) return;
  const header = "ano,tmed_15d,tmax_15d,tmin_15d,lluvia_15d_mm_dia,tmed_dia,tmax_dia,tmin_dia,lluvia_dia_mm";
  const value = (v) => (v === null || v === undefined ? "" : String(v));
  const lines = state.analysis.rows.map((row) =>
    [
      row.year,
      row.tmed,
      row.tmax,
      row.tmin,
      row.prec,
      row.day ? row.day.tmed : null,
      row.day ? row.day.tmax : null,
      row.day ? row.day.tmin : null,
      row.day ? row.day.prec : null,
    ]
      .map(value)
      .join(",")
  );
  const blob = new Blob([[header, ...lines].join("\n")], { type: "text/csv;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `secalienta_${station.idema}_${state.month}-${state.day}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}


// ---------- Consultas ----------

function cacheKey(id, month, day) {
  return `${id}|${month}-${day}`;
}

function rememberResult(result) {
  if (!result || (Array.isArray(result.failedYears) && result.failedYears.length)) return;
  const key = cacheKey(result.station, result.month, result.day);
  resultCache.delete(key);
  resultCache.set(key, result);
  if (resultCache.size > RESULT_CACHE_LIMIT) resultCache.delete(resultCache.keys().next().value);
}

async function enqueue(station, month = state.month, day = state.day) {
  const params = new URLSearchParams({ station, month, day });
  const response = await fetch(`/api/evolution/jobs/enqueue?${params}`);
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error((payload && payload.error) || "Error consultando AEMET");
  return payload;
}

async function waitForJob(jobId, token) {
  while (state.jobToken === token) {
    const snapshot = await fetchJson(`/api/evolution/jobs/${encodeURIComponent(jobId)}`);
    if (snapshot.status === "done") return snapshot.result;
    if (snapshot.status === "failed") throw new Error(snapshot.error || "No se pudo completar la consulta");
    showSnapshot(snapshot);
    await sleep(1500);
  }
  return null;
}

function showSnapshot(snapshot) {
  setProgress(Number(snapshot.progress.percent || 0), describeProgress(snapshot.progress));
  if (snapshot.partial && snapshot.partial.data.some((row) => row.tmed !== null)) {
    renderResult({ ...snapshot.partial, history: { complete: false, scanning: true } }, { partial: true });
  }
}

// Precarga el día anterior y el siguiente de estaciones ya descargadas: las flechas responden al instante.
function prefetchNeighbors() {
  const id = state.selectedId;
  if (!id || !state.cached.has(id)) return;
  for (const delta of [1, -1]) {
    const date = dateFromState();
    date.setDate(date.getDate() + delta);
    const month = pad(date.getMonth() + 1);
    const day = pad(date.getDate());
    const key = cacheKey(id, month, day);
    if (resultCache.has(key) || prefetching.has(key)) continue;
    prefetching.add(key);
    enqueue(id, month, day)
      .then((payload) => {
        if (payload.status === "done") rememberResult(payload.result);
      })
      .catch(() => {})
      .finally(() => prefetching.delete(key));
  }
}

function setRefreshing(active) {
  els.panel.classList.toggle("is-refreshing", active);
}

// Al cambiar de día no se vacía el panel: si el resultado está en memoria se anima al momento;
// si no, se espera un instante por si el usuario sigue pulsando las flechas.
function scheduleLoad() {
  clearTimeout(loadTimer);
  const cached = resultCache.get(cacheKey(state.selectedId, state.month, state.day));
  if (cached && state.result) {
    state.jobToken = `cache_${Date.now()}`;
    setRefreshing(false);
    setProgress(null);
    state.result = cached;
    renderResult(cached);
    prefetchNeighbors();
    return;
  }
  if (!state.result) {
    runQuery();
    return;
  }
  setRefreshing(true);
  loadTimer = setTimeout(() => runQuery({ mode: "transition" }), 220);
}

async function runQuery({ mode = "fresh" } = {}) {
  const station = state.byId.get(state.selectedId);
  if (!station) return null;

  const token = `${Date.now()}_${station.idema}_${state.month}_${state.day}`;
  state.jobToken = token;
  if (mode === "fresh") {
    state.result = null;
    state.analysis = null;
    renderHeader(station, null);
    renderSkeleton();
    els.shareBtn.disabled = true;
    els.panelBody.classList.add("is-loading");
    setProgress(2, "Buscando datos…");
  }

  try {
    const payload = await enqueue(station.idema);
    let result = payload.status === "done" ? payload.result : null;
    if (!result) {
      showSnapshot(payload);
      result = await waitForJob(payload.jobId, token);
    }
    if (!result || state.jobToken !== token) return null;

    state.result = result;
    rememberResult(result);
    setProgress(null);
    setRefreshing(false);
    renderResult(result);

    if (payload.status !== "done") {
      const analysis = state.analysis;
      const failed = Array.isArray(result.failedYears) ? result.failedYears.length : 0;
      playChime(failed > 0);
      showToast(
        failed > 0
          ? `Faltan ${failed} años por un corte de AEMET. Se reintentan solos; vuelve a consultar en unos minutos.`
          : `${station.nombreVisible}, ${prettyDay(state.month, state.day)}: ${analysis.valid.length} años con datos.`,
        failed > 0
      );
    }

    refreshCached();
    refreshBackground();
    prefetchNeighbors();
    return result;
  } catch (error) {
    if (state.jobToken === token) {
      setProgress(null);
      setRefreshing(false);
      els.panelBody.classList.remove("is-loading");
      showToast(error.message || "Error inesperado", true);
    }
    return null;
  }
}

function selectStation(stationId, { userGesture = true } = {}) {
  const station = state.byId.get(stationId);
  if (!station) return;
  if (userGesture) unlockAudio();
  state.selectedId = station.idema;
  state.direction = 0;
  closeSearch();
  const reveal = () => {
    applyViewState("station");
    openPanel();
    setTab("summary");
  };
  if (viewState() === "station" || !userGesture) reveal();
  else morph(reveal);
  updateUrl();
  // Evento para GTM/GA4: cada estación consultada. Solo llega a Google si el visitante aceptó (ver js/analytics.js).
  window.dataLayer = window.dataLayer || [];
  window.dataLayer.push({ event: "station_view", station: station.idema, station_name: station.nombreVisible, origin: userGesture ? "mapa" : "enlace" });
  requestAnimationFrame(() => focusStation(station, panelOffset()));
  runQuery();
}

// ---------- Segundo plano ----------

async function refreshBackground() {
  clearTimeout(backgroundTimer);
  let downloads = [];
  try {
    downloads = (await fetchJson("/api/background")).downloads || [];
  } catch (_error) {
    downloads = [];
  }

  const active = new Set(downloads.map((item) => item.station));
  const finished = [...state.scanningStations].filter((id) => !active.has(id));
  state.scanningStations = active;
  if (finished.length) {
    refreshCached();
    if (finished.includes(state.selectedId)) announceFullHistory();
  }

  const current = downloads.find((item) => item.station === state.selectedId) || downloads[0];
  if (!current) {
    els.backgroundPill.hidden = true;
    return;
  }

  const station = state.byId.get(current.station);
  const name = station ? station.nombreVisible : current.station;
  els.backgroundText.textContent = current.searchingOlder
    ? `Buscando registros antiguos de ${name} · ${current.year}`
    : `Completando histórico de ${name} · ${formatDuration(current.etaSeconds)}`;
  els.backgroundPill.hidden = false;
  backgroundTimer = setTimeout(refreshBackground, 3000);
}


async function announceFullHistory() {
  const previousStart = state.result ? state.result.startYear : null;
  const result = await runQuery({ mode: "silent" });
  if (!result || !result.history || !result.history.complete) return;
  const firstYear = result.history.firstYear;
  const station = state.byId.get(state.selectedId);
  if (firstYear && previousStart && firstYear < previousStart) {
    playChime();
    showToast(`Histórico completo de ${station.nombreVisible}: registros desde ${firstYear}.`);
  }
}

// ---------- Compartir ----------

async function drawShare() {
  const station = state.byId.get(state.selectedId);
  if (!station || !state.analysis) return;
  els.shareDialog.dataset.format = state.shareFormat;
  await drawShareCard(els.shareCanvas, {
    format: state.shareFormat,
    station,
    dayText: prettyDay(state.month, state.day),
    analysis: state.analysis,
    host: location.host,
    method:
      state.mode === "day"
        ? `Valor del ${prettyDay(state.month, state.day)} de cada año · ${state.analysis.valid.length} años con datos`
        : `Media ${windowText(state.month, state.day)} de cada año · ${state.analysis.valid.length} años con datos`,
  });
  if (!reducedMotion()) {
    els.shareCanvas.classList.remove("is-swapping");
    void els.shareCanvas.offsetWidth;
    els.shareCanvas.classList.add("is-swapping");
  }
}

function canShareFiles() {
  try {
    const probe = new File([new Blob()], "x.png", { type: "image/png" });
    return Boolean(navigator.canShare && navigator.canShare({ files: [probe] }));
  } catch (_error) {
    return false;
  }
}

async function openShare() {
  if (!state.analysis) return;
  els.shareNative.hidden = !canShareFiles();
  els.shareDownload.classList.toggle("btn-primary", els.shareNative.hidden);
  els.shareDownload.classList.toggle("btn-ghost", !els.shareNative.hidden);
  if (typeof els.shareDialog.showModal === "function") els.shareDialog.showModal();
  else els.shareDialog.setAttribute("open", "");
  await drawShare();
}

function closeShare() {
  if (typeof els.shareDialog.close === "function") els.shareDialog.close();
  else els.shareDialog.removeAttribute("open");
}

async function shareFile() {
  const station = state.byId.get(state.selectedId);
  const blob = await canvasToBlob(els.shareCanvas);
  return new File([blob], shareFileName(station, state.month, state.day, state.shareFormat), { type: "image/png" });
}

async function downloadShare() {
  const file = await shareFile();
  const link = document.createElement("a");
  link.href = URL.createObjectURL(file);
  link.download = file.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  flashButton(els.shareDownload, "Descargada");
}

async function nativeShare() {
  const station = state.byId.get(state.selectedId);
  try {
    const file = await shareFile();
    await navigator.share({
      files: [file],
      title: "secalienta.com",
      text: `${shareCaption(station, prettyDay(state.month, state.day), state.analysis)} ${location.href}`,
    });
  } catch (error) {
    if (error && error.name !== "AbortError") showToast("No se pudo compartir. Descarga la imagen.", true);
  }
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    flashButton(els.shareCopy, "¡Enlace copiado!");
  } catch (_error) {
    showToast("No se pudo copiar. Copia la dirección desde el navegador.", true);
  }
}

function flashButton(button, text) {
  const label = button.querySelector("span") || button;
  if (!button._label) button._label = label.textContent;
  label.textContent = text;
  button.classList.add("is-done");
  clearTimeout(button._timer);
  button._timer = setTimeout(() => {
    label.textContent = button._label;
    button.classList.remove("is-done");
  }, 1800);
}

// ---------- Busqueda ----------

function searchStations(query) {
  const q = normalizeText(query).trim();
  if (!q) {
    return state.stations.filter((station) => state.cached.has(station.idema)).slice(0, 8);
  }
  const scored = [];
  for (const station of state.stations) {
    let score = -1;
    if (station.idema.toLowerCase() === q) score = 0;
    else if (station.searchName.split(/[\s,.\-/()]+/).some((word) => word.startsWith(q))) score = 0;
    else if (station.searchName.includes(q)) score = 1;
    else if (station.idema.toLowerCase().startsWith(q)) score = 2;
    else if (station.searchProvince.includes(q)) score = 3;
    if (score >= 0) scored.push({ station, score });
  }
  scored.sort((a, b) => a.score - b.score || a.station.nombreVisible.localeCompare(b.station.nombreVisible, "es"));
  return scored.slice(0, 8).map((item) => item.station);
}

function renderSearch() {
  const query = els.searchInput.value;
  state.searchMatches = searchStations(query);
  state.searchIndex = state.searchMatches.length ? 0 : -1;
  els.searchResults.replaceChildren();

  if (!query.trim()) {
    const heading = document.createElement("li");
    heading.className = "search-heading";
    heading.textContent = state.searchMatches.length ? "Descargadas · respuesta instantánea" : "Escribe una ciudad, provincia o indicativo";
    els.searchResults.appendChild(heading);
  } else if (!state.searchMatches.length) {
    const empty = document.createElement("li");
    empty.className = "search-heading";
    empty.textContent = "Sin resultados";
    els.searchResults.appendChild(empty);
  }

  state.searchMatches.forEach((station, index) => {
    const item = document.createElement("li");
    item.className = "search-item";
    item.id = `search-option-${index}`;
    item.setAttribute("role", "option");
    item.dataset.id = station.idema;
    const name = document.createElement("span");
    name.className = "search-name";
    name.textContent = station.nombreVisible;
    const meta = document.createElement("span");
    meta.className = "search-meta";
    meta.textContent = `${station.provinciaVisible} · ${station.idema}`;
    item.append(name, meta);
    if (state.cached.has(station.idema)) {
      const badge = document.createElement("span");
      badge.className = "search-badge";
      badge.textContent = "Instantánea";
      item.appendChild(badge);
    }
    els.searchResults.appendChild(item);
  });

  highlightSearch();
  els.searchResults.hidden = false;
  els.searchInput.setAttribute("aria-expanded", "true");
}

function highlightSearch() {
  els.searchResults.querySelectorAll(".search-item").forEach((item, index) => {
    const active = index === state.searchIndex;
    item.classList.toggle("active", active);
    item.setAttribute("aria-selected", String(active));
    if (active) els.searchInput.setAttribute("aria-activedescendant", item.id);
  });
}

function closeSearch() {
  els.searchResults.hidden = true;
  els.searchInput.setAttribute("aria-expanded", "false");
  els.searchInput.removeAttribute("aria-activedescendant");
}

function focusSearch() {
  els.searchInput.focus();
  els.searchInput.select();
  renderSearch();
}


// ---------- Ubicacion, URL y fecha ----------

function distanceKm(lat1, lon1, lat2, lon2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

function locateUser() {
  unlockAudio();
  if (!navigator.geolocation) {
    showToast("Tu navegador no permite obtener la ubicación. Busca la estación por nombre.", true);
    return;
  }
  for (const button of [els.dockLocate, els.searchLocate]) {
    button.disabled = true;
    button.classList.add("is-busy");
  }
  navigator.geolocation.getCurrentPosition(
    (position) => {
      const { latitude, longitude } = position.coords;
      let nearest = null;
      let best = Infinity;
      for (const station of state.stations) {
        if (!Number.isFinite(station.latitud) || !Number.isFinite(station.longitud)) continue;
        const distance = distanceKm(latitude, longitude, station.latitud, station.longitud);
        if (distance < best) {
          best = distance;
          nearest = station;
        }
      }
      resetLocateButton();
      if (nearest) {
        showToast(`Estación más cercana: ${nearest.nombreVisible} (a ${formatNumber(best, 0)} km).`);
        selectStation(nearest.idema);
      }
    },
    () => {
      resetLocateButton();
      showToast("No se pudo obtener tu ubicación. Busca la estación por nombre.", true);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 }
  );
}


function resetLocateButton() {
  for (const button of [els.dockLocate, els.searchLocate]) {
    button.disabled = false;
    button.classList.remove("is-busy");
  }
}

function updateUrl() {
  const params = new URLSearchParams();
  if (state.selectedId) params.set("estacion", state.selectedId);
  params.set("dia", `${state.month}-${state.day}`);
  history.replaceState(null, "", `${location.pathname}?${params}`);
}

function readInitialState() {
  const params = new URLSearchParams(location.search);
  const match = String(params.get("dia") || "").match(/^(\d{2})-(\d{2})$/);
  const valid = match && !Number.isNaN(new Date(`${REF_YEAR}-${match[1]}-${match[2]}T00:00:00`).getTime());
  const today = todayParts();
  state.month = valid ? match[1] : today.month;
  state.day = valid ? match[2] : today.day;
  renderDayNav();
  return String(params.get("estacion") || "").toUpperCase();
}

// ---------- Eventos ----------

function isTyping() {
  const tag = document.activeElement && document.activeElement.tagName;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(tag);
}

function bindEvents() {
  els.searchInput.addEventListener("input", renderSearch);
  els.searchInput.addEventListener("focus", renderSearch);
  els.searchInput.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!state.searchMatches.length) return;
      const delta = event.key === "ArrowDown" ? 1 : -1;
      state.searchIndex = (state.searchIndex + delta + state.searchMatches.length) % state.searchMatches.length;
      highlightSearch();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const station = state.searchMatches[state.searchIndex];
      if (station) {
        els.searchInput.value = "";
        els.searchInput.blur();
        selectStation(station.idema);
      }
    } else if (event.key === "Escape") {
      closeSearch();
      els.searchInput.blur();
    }
  });

  els.searchResults.addEventListener("mousedown", (event) => {
    const item = event.target.closest(".search-item");
    if (!item) return;
    event.preventDefault();
    els.searchInput.value = "";
    els.searchInput.blur();
    selectStation(item.dataset.id);
  });

  els.searchInput.addEventListener("blur", () => setTimeout(closeSearch, 120));

  document.addEventListener("keydown", (event) => {
    if (els.shareDialog.open) return;
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      focusSearch();
    } else if (event.key === "/" && !isTyping()) {
      event.preventDefault();
      focusSearch();
    } else if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && !isTyping() && !event.target.closest('[role="tablist"], [role="radiogroup"]')) {
      event.preventDefault();
      shiftDay(event.key === "ArrowRight" ? 1 : -1);
    } else if (event.key === "Escape" && !isTyping()) {
      if (!els.rigorPop.hidden) toggleRigor(false);
      else if (!els.stationPop.hidden) toggleStationPop(false);
      else if (state.selectedId) goHome();
    }
  });

  els.prevDay.addEventListener("click", () => shiftDay(-1));
  els.nextDay.addEventListener("click", () => shiftDay(1));
  els.todayBtn.addEventListener("click", goToday);
  els.dayLabel.addEventListener("click", openDatePicker);
  els.dateInput.addEventListener("change", () => {
    const match = els.dateInput.value.match(/^\d{4}-(\d{2})-(\d{2})$/);
    if (!match) return;
    const target = new Date(REF_YEAR, Number(match[1]) - 1, Number(match[2]));
    setDay(match[1], match[2], Math.sign(target - dateFromState()));
  });

  // En la barra compacta, la marca vuelve a desplegar la explicación.
  els.aboutBtn.addEventListener("click", () => {
    if (viewState() === "compact") setViewState("home");
  });
  els.backBtn.addEventListener("click", goHome);
  els.quickPicks.addEventListener("click", (event) => {
    const button = event.target.closest("[data-id]");
    if (button) selectStation(button.dataset.id);
  });

  els.expandBtn.addEventListener("click", () => toggleExpanded());
  els.sheetHandle.addEventListener("click", () => toggleExpanded());
  els.searchLocate.addEventListener("click", locateUser);
  els.dockLocate.addEventListener("click", locateUser);
  els.csvBtn.addEventListener("click", downloadCsv);
  els.toast.addEventListener("click", () => {
    els.toast.hidden = true;
  });

  els.rigorBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleRigor();
  });
  els.stationBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    toggleStationPop();
  });
  document.addEventListener("click", (event) => {
    if (!els.rigorPop.hidden && !event.target.closest(".rigor")) toggleRigor(false);
    if (!els.stationPop.hidden && !event.target.closest(".station-info")) toggleStationPop(false);
  });

  els.tabSummaryBtn.addEventListener("click", () => setTab("summary"));
  els.tabTableBtn.addEventListener("click", () => setTab("table"));
  document.querySelector(".tabs").addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      setTab(state.tab === "summary" ? "table" : "summary", { focus: true });
    }
  });

  els.modeToggle.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-mode]");
    if (!button || button.dataset.mode === state.mode) return;
    state.mode = button.dataset.mode;
    for (const item of els.modeToggle.querySelectorAll("button")) item.setAttribute("aria-checked", String(item === button));
    els.modeToggle.dataset.value = state.mode;
    if (state.result) renderResult(state.result);
  });

  els.seriesToggles.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-series]");
    if (!button) return;
    const id = button.dataset.series;
    state.visibility[id] = !state.visibility[id];
    button.setAttribute("aria-pressed", String(state.visibility[id]));
    setSeriesVisibility(id, state.visibility[id]);
  });

  // Franjas: se pueden recorrer con el ratón o arrastrando el dedo, y señalan el año en el gráfico.
  const scrub = (event) => {
    const stripe = stripeFromPointer(event);
    if (!stripe) return;
    const year = Number(stripe.dataset.year);
    markStripe(year);
    highlightYear(year);
  };
  els.stripes.addEventListener("pointermove", scrub);
  els.stripes.addEventListener("pointerdown", (event) => {
    if (event.pointerType !== "mouse") els.stripes.setPointerCapture(event.pointerId);
    scrub(event);
  });
  const endScrub = () => {
    markStripe(null);
    highlightYear(null);
  };
  els.stripes.addEventListener("pointerleave", endScrub);
  els.stripes.addEventListener("pointerup", (event) => {
    if (event.pointerType !== "mouse") endScrub();
  });
  onChartHover((year) => markStripe(year));

  els.shareBtn.addEventListener("click", openShare);
  els.donateBtn.addEventListener("click", goToDonate);
  els.shareClose.addEventListener("click", closeShare);
  els.shareDialog.addEventListener("click", (event) => {
    if (event.target === els.shareDialog) closeShare();
  });
  els.shareFormats.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-format]");
    if (!button || button.dataset.format === state.shareFormat) return;
    state.shareFormat = button.dataset.format;
    for (const item of els.shareFormats.querySelectorAll("button")) item.setAttribute("aria-checked", String(item === button));
    els.shareFormats.dataset.value = state.shareFormat;
    drawShare();
  });
  els.shareDownload.addEventListener("click", downloadShare);
  els.shareNative.addEventListener("click", nativeShare);
  els.shareCopy.addEventListener("click", copyLink);

  let resizeTimer = 0;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.result) renderTemperatureChart(els.chart, state.analysis, state.visibility);
    }, 200);
  });
}

// ---------- Vídeo de la portada ----------

// Con «reducir movimiento», el vídeo queda parado en el primer fotograma.
function setupHeroVideo() {
  const video = document.querySelector(".welcome-video");
  if (!video || !reducedMotion()) return;
  video.removeAttribute("autoplay");
  video.pause();
}

// ---------- Inicio ----------

async function init() {
  const initialStation = readInitialState();
  applyLinks();
  renderDonate();
  bindEvents();
  setupHeroVideo();
  // La tarjeta sale abierta en cada carga, salvo si se llega con una estación en el enlace.
  // Va antes del mapa: su tamaño decide dónde se centra la península.
  applyViewState(initialStation ? "station" : "home");
  watchBottomBar();
  createMap(els.map, {
    onSelect: selectStation,
    homeOffset,
    // En móvil la tarjeta tapa casi todo el mapa: al moverlo, se recoge en la barra para dejar sitio.
    onExplore: () => {
      if (isMobile() && viewState() === "home") setViewState("compact");
    },
  });
  els.dock.hidden = false;
  els.modeToggle.dataset.value = state.mode;
  els.shareFormats.dataset.value = state.shareFormat;

  try {
    const [rawStations] = await Promise.all([fetchJson("/api/stations"), refreshCached()]);
    state.stations = rawStations.map(normalizeStation).sort((a, b) => a.nombreVisible.localeCompare(b.nombreVisible, "es"));
    state.byId = new Map(state.stations.map((station) => [station.idema, station]));
    setStations(state.stations, new Set(state.cached.keys()));
    renderQuickPicks();
  } catch (error) {
    showToast(error.message || "No se pudieron cargar las estaciones", true);
    return;
  }

  if (initialStation && state.byId.has(initialStation)) {
    selectStation(initialStation, { userGesture: false });
  } else {
    if (initialStation) setViewState("home");
    updateUrl();
  }
  refreshBackground();
}

init();

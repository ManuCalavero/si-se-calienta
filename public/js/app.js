import { analyze } from "./stats.js";
import { anomalyColor, formatDuration, formatNumber, formatSigned, prettyDay, titleCase } from "./format.js";
import { anomalyScale, renderTemperatureChart, resizeCharts, setSeriesVisibility } from "./charts.js";
import { clearSelection, createMap, focusStation, setStations, updateCached } from "./map.js";

const $ = (id) => document.getElementById(id);

const els = {
  map: $("map"),
  searchInput: $("search-input"),
  searchResults: $("search-results"),
  dateInput: $("date"),
  backgroundPill: $("background-download"),
  backgroundText: $("background-download-text"),
  welcome: $("welcome"),
  locateBtn: $("locate-btn"),
  focusSearchBtn: $("focus-search-btn"),
  panel: $("panel"),
  panelBody: $("panel-body"),
  sheetHandle: $("sheet-handle"),
  eyebrow: $("panel-eyebrow"),
  title: $("panel-title"),
  sub: $("panel-sub"),
  verdict: $("verdict"),
  expandBtn: $("expand-btn"),
  closeBtn: $("close-btn"),
  progressBox: $("panel-progress"),
  progressBar: $("progress-bar"),
  status: $("status"),
  headline: $("headline"),
  kpis: $("kpis"),
  stripes: $("stripes"),
  stripesStart: $("stripes-start"),
  stripesEnd: $("stripes-end"),
  chart: $("chart"),
  seriesToggles: $("series-toggles"),
  stationFacts: $("station-facts"),
  qualityFacts: $("quality-facts"),
  statsFacts: $("stats-facts"),
  tableBody: document.querySelector("#results-table tbody"),
  csvBtn: $("csv-btn"),
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
  visibility: { tmax: true, tmin: true, prec: true },
  scanningStations: new Set(),
  searchMatches: [],
  searchIndex: -1,
};

let audioContext = null;
let toastTimer = 0;
let backgroundTimer = 0;

const isMobile = () => window.matchMedia("(max-width: 760px)").matches;
const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;
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
  }, 8000);
}

// ---------- Panel ----------

function openPanel() {
  document.body.classList.add("has-selection");
  if (!els.panel.hidden && els.panel.classList.contains("open")) return;
  els.panel.hidden = false;
  requestAnimationFrame(() => els.panel.classList.add("open"));
}

function closePanel() {
  state.jobToken = "";
  state.selectedId = "";
  document.body.classList.remove("has-selection");
  els.panel.classList.remove("open", "expanded");
  els.expandBtn.setAttribute("aria-expanded", "false");
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

function panelOffset() {
  if (isMobile()) {
    return [0, Math.round(window.innerHeight * 0.3)];
  }
  return [Math.round((els.panel.offsetWidth + 24) / 2), 0];
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
  return `Descargando datos de AEMET · ${percent}% · quedan ${eta}`;
}

// ---------- Render ----------

function animateValue(element, target, format) {
  if (reducedMotion() || target === null || !Number.isFinite(target)) {
    element.textContent = format(target);
    return;
  }
  const start = performance.now();
  const duration = 650;
  const step = (now) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - t) ** 3;
    element.textContent = format(target * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderHeader(station, analysis) {
  els.eyebrow.textContent = `Estación ${station.idema} · ${station.provinciaVisible}`;
  els.title.textContent = station.nombreVisible;
  const period = analysis && analysis.firstYear ? ` · ${analysis.firstYear}–${analysis.lastYear}` : "";
  els.sub.textContent = `${prettyDay(state.month, state.day)} · media de 15 días${period}`;
}

const VERDICTS = {
  warming: { text: "Se calienta", className: "chip-warm" },
  cooling: { text: "Se enfría", className: "chip-cool" },
  unclear: { text: "Sin tendencia clara", className: "chip-neutral" },
  insufficient: { text: "Pocos datos", className: "chip-neutral" },
};

function renderVerdict(analysis) {
  const verdict = VERDICTS[analysis.verdict];
  els.verdict.textContent = verdict.text;
  els.verdict.className = `chip ${verdict.className}`;
  els.verdict.title = analysis.trend
    ? "Tendencia clara si la pendiente es al menos el doble de su margen de error"
    : "Hacen falta al menos 10 años con datos";
}

function renderHeadline(station, analysis) {
  const day = prettyDay(state.month, state.day);
  if (!analysis.change) {
    els.headline.textContent = `Aún no hay suficientes años con datos para medir cómo ha cambiado el ${day} en ${station.nombreVisible}.`;
    return;
  }
  const { delta, earlyRange, lateRange } = analysis.change;
  const amount = `${formatNumber(Math.abs(delta))} °C`;
  const direction = delta >= 0 ? "más cálido" : "más fresco";
  const caveat =
    analysis.verdict === "warming" || analysis.verdict === "cooling"
      ? ""
      : " Aun así, la tendencia no es clara: hay pocos años o mucha variación entre ellos.";
  els.headline.textContent = `En ${station.nombreVisible}, el ${day} es ${amount} ${direction} en ${lateRange[0]}–${lateRange[1]} que en ${earlyRange[0]}–${earlyRange[1]}.${caveat}`;
}

function kpi(label, value, format, sub, tone = "") {
  const card = document.createElement("article");
  card.className = `kpi ${tone}`;
  const labelEl = document.createElement("span");
  labelEl.className = "kpi-label";
  labelEl.textContent = label;
  const valueEl = document.createElement("strong");
  valueEl.className = "kpi-value";
  const subEl = document.createElement("span");
  subEl.className = "kpi-sub";
  subEl.textContent = sub;
  card.append(labelEl, valueEl, subEl);
  return { card, valueEl, value, format };
}

function toneFor(value, threshold = 0.05) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "";
  if (value > threshold) return "tone-warm";
  if (value < -threshold) return "tone-cool";
  return "";
}

function renderKpis(analysis, animate) {
  const { change, trend, record } = analysis;
  const items = [
    kpi(
      "Cambio",
      change ? change.delta : null,
      (v) => (v === null ? "—" : `${formatSigned(v)} °C`),
      change ? `${change.lateRange[0]}–${change.lateRange[1]} vs ${change.earlyRange[0]}–${change.earlyRange[1]}` : "Pocos años con datos",
      toneFor(change && change.delta)
    ),
    kpi(
      "Tendencia",
      trend ? trend.slopePerDecade : null,
      (v) => (v === null ? "—" : `${formatSigned(v, 2)} °C`),
      trend ? `por década · ${trend.firstYear}–${trend.lastYear}` : "Mínimo 10 años",
      toneFor(trend && trend.slopePerDecade, 0.02)
    ),
    kpi("Temp. media", analysis.meanTmed, (v) => (v === null ? "—" : `${formatNumber(v)} °C`), "Media de todos los años"),
    kpi(
      "Récord de calor",
      record ? record.value : null,
      (v) => (v === null ? "—" : `${formatNumber(v)} °C`),
      record ? `Máxima del día exacto · ${record.year}` : "Sin datos"
    ),
    kpi("Lluvia", analysis.precipMean, (v) => (v === null ? "—" : `${formatNumber(v)} mm`), "Media diaria · ±7 días"),
  ];

  els.kpis.replaceChildren(...items.map((item) => item.card));
  for (const item of items) {
    if (animate) animateValue(item.valueEl, item.value, item.format);
    else item.valueEl.textContent = item.format(item.value);
  }
}

function renderSkeleton() {
  els.headline.textContent = "";
  els.verdict.textContent = "Analizando…";
  els.verdict.className = "chip chip-neutral";
  const labels = ["Cambio", "Tendencia", "Temp. media", "Récord de calor", "Lluvia"];
  els.kpis.replaceChildren(...labels.map((label) => kpi(label, null, () => "—", " ").card));
  for (const value of els.kpis.querySelectorAll(".kpi-value")) value.textContent = "00,0 °C";
  els.stripes.replaceChildren();
  els.stationFacts.replaceChildren();
  els.qualityFacts.replaceChildren();
}

function renderStripes(analysis) {
  els.stripes.replaceChildren();
  if (!analysis.firstYear) {
    els.stripesStart.textContent = "";
    els.stripesEnd.textContent = "";
    return;
  }

  const scale = anomalyScale(analysis);
  for (const row of analysis.complete) {
    if (row.year < analysis.firstYear || row.year > analysis.lastYear) continue;
    const stripe = document.createElement("span");
    const anomaly = analysis.anomalies.get(row.year);
    const color = anomalyColor(anomaly, scale);
    if (color) {
      stripe.style.background = color;
      stripe.title = `${row.year}: ${formatSigned(anomaly)} °C respecto a la media`;
    } else {
      stripe.className = "stripe-missing";
      stripe.title = `${row.year}: sin datos`;
    }
    els.stripes.appendChild(stripe);
  }
  els.stripesStart.textContent = analysis.firstYear;
  els.stripesEnd.textContent = analysis.lastYear;
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
  fact(els.qualityFacts, "Cálculo", "Media de ±7 días (mín. 10 con dato)");
  fact(
    els.qualityFacts,
    "Histórico",
    history.complete ? "Completo" : history.scanning ? "Buscando registros más antiguos…" : "Desde 1976 de momento"
  );
  if (Array.isArray(result.failedYears) && result.failedYears.length) {
    fact(els.qualityFacts, "Pendiente", `${result.failedYears.length} años por descargar (se reintentan solos)`);
  }
}

function renderDetail(analysis) {
  const { trend, trendCommon, change } = analysis;
  els.statsFacts.replaceChildren();
  fact(
    els.statsFacts,
    "Pendiente",
    trend ? `${formatSigned(trend.slopePerDecade, 2)} ± ${formatNumber(trend.stderrPerDecade * 2, 2)} °C/década` : "—"
  );
  fact(els.statsFacts, "R²", trend ? formatNumber(trend.r2, 2) : "—");
  fact(els.statsFacts, "Años usados", trend ? String(trend.n) : String(analysis.valid.length));
  fact(
    els.statsFacts,
    "Tendencia 1976–hoy",
    trendCommon ? `${formatSigned(trendCommon.slopePerDecade, 2)} °C/década` : "—"
  );
  fact(
    els.statsFacts,
    "Medias comparadas",
    change ? `${formatNumber(change.earlyMean)} → ${formatNumber(change.lateMean)} °C (${change.size} años)` : "—"
  );

  const rows = [...analysis.rows].reverse();
  els.tableBody.replaceChildren(
    ...rows.map((row) => {
      const tr = document.createElement("tr");
      const cells = [
        String(row.year),
        formatNumber(row.tmed),
        formatNumber(row.tmax),
        formatNumber(row.tmin),
        formatNumber(row.prec, 2),
        formatNumber(row.day ? row.day.tmed : null),
        formatNumber(row.day ? row.day.tmax : null),
      ];
      for (const value of cells) {
        const td = document.createElement("td");
        td.textContent = value;
        tr.appendChild(td);
      }
      return tr;
    })
  );
}

function renderResult(result, { partial = false } = {}) {
  const station = state.byId.get(state.selectedId);
  if (!station) return;
  const analysis = analyze(result);
  state.analysis = analysis;

  renderHeader(station, analysis);
  renderVerdict(analysis);
  renderHeadline(station, analysis);
  renderKpis(analysis, !partial);
  renderStripes(analysis);
  renderTemperatureChart(els.chart, analysis, state.visibility);
  renderFacts(station, result, analysis);
  renderDetail(analysis);
  els.panelBody.classList.remove("is-loading");
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
  link.download = `si-se-calienta_${station.idema}_${state.month}-${state.day}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

// ---------- Consultas ----------

async function enqueue(station) {
  const params = new URLSearchParams({ station, month: state.month, day: state.day });
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

async function runQuery({ silent = false } = {}) {
  const station = state.byId.get(state.selectedId);
  if (!station) return null;

  const token = `${Date.now()}_${station.idema}_${state.month}_${state.day}`;
  state.jobToken = token;
  if (!silent) {
    state.result = null;
    renderHeader(station, null);
    renderSkeleton();
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
    setProgress(null);
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
    return result;
  } catch (error) {
    if (state.jobToken === token) {
      setProgress(null);
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
  closeSearch();
  openPanel();
  updateUrl();
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
  const result = await runQuery({ silent: true });
  if (!result || !result.history || !result.history.complete) return;
  const firstYear = result.history.firstYear;
  const station = state.byId.get(state.selectedId);
  if (firstYear && previousStart && firstYear < previousStart) {
    playChime();
    showToast(`Histórico completo de ${station.nombreVisible}: registros desde ${firstYear}.`);
  }
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
  els.locateBtn.disabled = true;
  els.locateBtn.textContent = "Localizando…";
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
  els.locateBtn.disabled = false;
  els.locateBtn.textContent = "Usar mi ubicación";
}

function updateUrl() {
  const params = new URLSearchParams();
  if (state.selectedId) params.set("estacion", state.selectedId);
  params.set("dia", `${state.month}-${state.day}`);
  history.replaceState(null, "", `${location.pathname}?${params}`);
}

function setDate(month, day) {
  state.month = month;
  state.day = day;
  els.dateInput.value = `${new Date().getFullYear()}-${month}-${day}`;
}

function readInitialState() {
  const params = new URLSearchParams(location.search);
  const match = String(params.get("dia") || "").match(/^(\d{2})-(\d{2})$/);
  const today = new Date();
  if (match) setDate(match[1], match[2]);
  else setDate(String(today.getMonth() + 1).padStart(2, "0"), String(today.getDate()).padStart(2, "0"));
  return String(params.get("estacion") || "").toUpperCase();
}

// ---------- Eventos ----------

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
    const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement && document.activeElement.tagName);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      focusSearch();
    } else if (event.key === "/" && !typing) {
      event.preventDefault();
      focusSearch();
    } else if (event.key === "Escape" && !typing && state.selectedId) {
      closePanel();
    }
  });

  els.dateInput.addEventListener("change", () => {
    const match = els.dateInput.value.match(/^\d{4}-(\d{2})-(\d{2})$/);
    if (!match) return;
    state.month = match[1];
    state.day = match[2];
    updateUrl();
    if (state.selectedId) {
      unlockAudio();
      runQuery();
    }
  });

  els.closeBtn.addEventListener("click", closePanel);
  els.expandBtn.addEventListener("click", () => toggleExpanded());
  els.sheetHandle.addEventListener("click", () => toggleExpanded());
  els.locateBtn.addEventListener("click", locateUser);
  els.focusSearchBtn.addEventListener("click", focusSearch);
  els.csvBtn.addEventListener("click", downloadCsv);
  els.toast.addEventListener("click", () => {
    els.toast.hidden = true;
  });

  els.seriesToggles.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-series]");
    if (!button) return;
    const id = button.dataset.series;
    state.visibility[id] = !state.visibility[id];
    button.setAttribute("aria-pressed", String(state.visibility[id]));
    setSeriesVisibility(id, state.visibility[id]);
  });
}

// ---------- Inicio ----------

async function init() {
  const initialStation = readInitialState();
  bindEvents();
  createMap(els.map, { onSelect: selectStation });

  try {
    const [rawStations] = await Promise.all([fetchJson("/api/stations"), refreshCached()]);
    state.stations = rawStations.map(normalizeStation).sort((a, b) => a.nombreVisible.localeCompare(b.nombreVisible, "es"));
    state.byId = new Map(state.stations.map((station) => [station.idema, station]));
    setStations(state.stations, new Set(state.cached.keys()));
  } catch (error) {
    showToast(error.message || "No se pudieron cargar las estaciones", true);
    return;
  }

  if (initialStation && state.byId.has(initialStation)) {
    selectStation(initialStation, { userGesture: false });
  } else {
    updateUrl();
  }
  refreshBackground();
}

init();

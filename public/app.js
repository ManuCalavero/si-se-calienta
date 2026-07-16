const form = document.getElementById("query-form");
const dateInput = document.getElementById("date");
const submitButton = form.querySelector("button[type='submit']");
const submitButtonLabel = submitButton.querySelector(".btn-label");
const statusEl = document.getElementById("status");
const statusSpinner = document.getElementById("status-spinner");
const summaryEl = document.getElementById("summary");
const tableBody = document.querySelector("#results-table tbody");
const chartTitle = document.getElementById("chart-title");
const selectionSummary = document.getElementById("selection-summary");
const selectedStationLabel = document.getElementById("selected-station");
const stationsMapEl = document.getElementById("stations-map");

let chart;
let stations = [];
let selectedStationId = "";
let map;
let mapMarkersLayer;
const markerById = new Map();
let activeJobToken = "";

const defaultMarkerStyle = {
  radius: 5,
  color: "#b42318",
  weight: 1,
  fillColor: "#ef4444",
  fillOpacity: 0.9,
};

const selectedMarkerStyle = {
  radius: 8,
  color: "#7f1d1d",
  weight: 2,
  fillColor: "#dc2626",
  fillOpacity: 1,
};

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#b42318" : "";
}

function setLoadingState(isLoading) {
  document.body.classList.toggle("loading", isLoading);
  dateInput.disabled = isLoading;
  submitButton.disabled = isLoading;
  submitButtonLabel.textContent = isLoading ? "Consultando" : "Ver evolucion";
  statusSpinner.classList.toggle("hidden", !isLoading);
}

function parseCoordinate(rawValue, isLatitude) {
  if (rawValue === undefined || rawValue === null || rawValue === "") return null;

  const text = String(rawValue).trim().toUpperCase();
  const asNumber = Number(text.replace(",", "."));
  if (Number.isFinite(asNumber)) {
    return asNumber;
  }

  const compact = text.replace(/\s+/g, "");
  const regex = isLatitude ? /^(\d{2})(\d{2})(\d{2})([NS])$/ : /^(\d{2,3})(\d{2})(\d{2})([EW])$/;
  const match = compact.match(regex);
  if (!match) return null;

  const degrees = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);
  const hemisphere = match[4];

  if (!Number.isFinite(degrees) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }

  if (minutes > 59 || seconds > 59) return null;

  const decimal = degrees + minutes / 60 + seconds / 3600;
  if (isLatitude && decimal > 90) return null;
  if (!isLatitude && decimal > 180) return null;

  const sign = hemisphere === "S" || hemisphere === "W" ? -1 : 1;
  return decimal * sign;
}

function parseNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const normalized = String(value).replace(",", ".").trim();
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStation(station) {
  return {
    idema: station.idema || station.indicativo,
    nombre: station.nombre,
    provincia: station.provincia,
    altitud: parseNumber(station.altitud),
    latitud: parseCoordinate(station.latitud, true),
    longitud: parseCoordinate(station.longitud, false),
  };
}

function stationDisplayLabel(station) {
  if (!station) return "";
  return `${station.nombre} (${station.idema}) - ${station.provincia}`;
}

function getSelectedStation() {
  return stations.find((station) => station.idema === selectedStationId) || null;
}

function paintSelectedMarker() {
  for (const [id, marker] of markerById.entries()) {
    marker.setStyle(id === selectedStationId ? selectedMarkerStyle : defaultMarkerStyle);
  }
}

function selectStation(stationId, options = {}) {
  const station = stations.find((item) => item.idema === stationId);
  if (!station) return;

  selectedStationId = station.idema;
  selectedStationLabel.textContent = stationDisplayLabel(station);
  paintSelectedMarker();

  if (options.panTo !== false && Number.isFinite(station.latitud) && Number.isFinite(station.longitud) && map) {
    map.setView([station.latitud, station.longitud], Math.max(map.getZoom(), 7), { animate: true });
  }

  try {
    const { month, day } = extractMonthDay(dateInput.value);
    updateSelectionSummary(stationDisplayLabel(station), day, month, 0);
  } catch (_error) {
    // Ignorar hasta que haya una fecha valida.
  }
}

function initializeMap() {
  map = L.map(stationsMapEl, {
    minZoom: 5,
    maxZoom: 14,
    zoomControl: true,
  }).setView([40.35, -3.65], 6);

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);

  mapMarkersLayer = L.layerGroup().addTo(map);
}

function buildStationPopupNode(station) {
  const wrapper = document.createElement("div");
  wrapper.className = "station-popup";

  const title = document.createElement("p");
  title.className = "station-popup-title";
  title.textContent = station.nombre || "Estacion";

  const meta = document.createElement("p");
  meta.className = "station-popup-meta";
  meta.textContent = `${station.idema || "-"} - ${station.provincia || "-"}`;

  const action = document.createElement("button");
  action.type = "button";
  action.className = "station-popup-action";
  action.dataset.stationId = station.idema || "";
  action.textContent = "Consultar datos";

  wrapper.appendChild(title);
  wrapper.appendChild(meta);
  wrapper.appendChild(action);
  return wrapper;
}

function renderStationMarkers() {
  markerById.clear();
  mapMarkersLayer.clearLayers();

  const bounds = [];
  for (const station of stations) {
    if (!Number.isFinite(station.latitud) || !Number.isFinite(station.longitud)) continue;

    const marker = L.circleMarker([station.latitud, station.longitud], defaultMarkerStyle)
      .bindPopup(buildStationPopupNode(station))
      .on("click", () => {
        selectStation(station.idema, { panTo: false });
      })
      .on("popupopen", (event) => {
        const popupElement = event.popup && event.popup.getElement ? event.popup.getElement() : null;
        const actionButton = popupElement ? popupElement.querySelector(".station-popup-action") : null;
        if (!actionButton) return;

        actionButton.onclick = async (clickEvent) => {
          clickEvent.preventDefault();
          clickEvent.stopPropagation();

          if (submitButton.disabled) return;

          const stationId = actionButton.getAttribute("data-station-id") || station.idema;
          selectStation(stationId, { panTo: false });
          await runSelectedStationQuery();
        };
      });

    marker.addTo(mapMarkersLayer);
    markerById.set(station.idema, marker);
    bounds.push([station.latitud, station.longitud]);
  }

  if (bounds.length > 1) {
    map.fitBounds(bounds, { padding: [28, 28], maxZoom: 8 });
  } else if (bounds.length === 1) {
    map.setView(bounds[0], 8);
  }

  return bounds.length;
}

function formatValue(value, unit = "") {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${value.toFixed(1)}${unit}`;
}

function avg(values) {
  const valid = values.filter((v) => v !== null && v !== undefined && Number.isFinite(v));
  if (!valid.length) return null;
  const sum = valid.reduce((acc, curr) => acc + curr, 0);
  return sum / valid.length;
}

function createMetricCard(title, value, unit) {
  const card = document.createElement("article");
  card.className = "metric card";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const content = document.createElement("p");
  content.textContent = formatValue(value, unit);
  card.appendChild(heading);
  card.appendChild(content);
  return card;
}

function renderSummary(data) {
  const tmaxValues = data.map((d) => d.tmax).filter((v) => v !== null);
  const tminValues = data.map((d) => d.tmin).filter((v) => v !== null);
  const tmedValues = data.map((d) => d.tmed).filter((v) => v !== null);
  const precValues = data.map((d) => d.prec).filter((v) => v !== null);

  summaryEl.innerHTML = "";
  summaryEl.appendChild(createMetricCard("T. Max media", avg(tmaxValues), " C"));
  summaryEl.appendChild(createMetricCard("T. Min media", avg(tminValues), " C"));
  summaryEl.appendChild(createMetricCard("T. Media media", avg(tmedValues), " C"));
  summaryEl.appendChild(createMetricCard("Precipitacion media", avg(precValues), " mm"));
}

function renderTable(data) {
  tableBody.innerHTML = "";

  for (const row of data) {
    const tr = document.createElement("tr");

    const values = [
      String(row.year),
      formatValue(row.tmax),
      formatValue(row.tmin),
      formatValue(row.tmed),
      formatValue(row.prec),
    ];

    for (const value of values) {
      const td = document.createElement("td");
      td.textContent = value;
      tr.appendChild(td);
    }

    tableBody.appendChild(tr);
  }
}

function renderChart(data) {
  const ctx = document.getElementById("chart");
  const labels = data.map((d) => d.year);

  if (chart) {
    chart.destroy();
  }

  chart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [
        {
          label: "T. Max",
          data: data.map((d) => d.tmax),
          borderColor: "#ff9500",
          backgroundColor: "rgba(255, 149, 0, 0.2)",
          borderWidth: 1,
          spanGaps: true,
          tension: 0,
          yAxisID: "yTemp",
        },
        {
          label: "T. Min",
          data: data.map((d) => d.tmin),
          borderColor: "#7e7e7e",
          backgroundColor: "rgba(185, 189, 193, 0.2)",
          borderWidth: 1,
          spanGaps: true,
          tension: 0,
          yAxisID: "yTemp",
        },
        {
          label: "T. Media",
          data: data.map((d) => d.tmed),
          borderColor: "#b1b1b1",
          backgroundColor: "rgba(177, 177, 177, 0.2)",
          borderWidth: 1,
          spanGaps: true,
          tension: 0,
          yAxisID: "yTemp",
        },
        {
          label: "Precipitacion",
          data: data.map((d) => d.prec),
          borderColor: "#77e9f8",
          backgroundColor: "rgba(119, 233, 248, 0.2)",
          borderWidth: 1,
          spanGaps: true,
          tension: 0,
          yAxisID: "yPrec",
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      resizeDelay: 150,
      interaction: {
        mode: "index",
        intersect: false,
      },
      plugins: {
        legend: {
          position: "bottom",
          labels: {
            color: "#cfdaf1",
            usePointStyle: true,
            boxWidth: 10,
          },
        },
      },
      scales: {
        x: {
          grid: {
            color: "rgba(154, 175, 209, 0.18)",
          },
          ticks: {
            color: "#b8c8e5",
            maxTicksLimit: 14,
          },
        },
        yTemp: {
          type: "linear",
          position: "left",
          grid: {
            color: "rgba(154, 175, 209, 0.18)",
          },
          ticks: {
            color: "#b8c8e5",
          },
          title: {
            display: true,
            text: "Temperatura (C)",
            color: "#c4d3ef",
          },
        },
        yPrec: {
          type: "linear",
          position: "right",
          ticks: {
            color: "#b8c8e5",
          },
          title: {
            display: true,
            text: "Precipitacion (mm)",
            color: "#c4d3ef",
          },
          grid: {
            drawOnChartArea: false,
          },
        },
      },
    },
  });
}

function monthNameEs(month) {
  const names = [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ];
  const monthIndex = Number(month) - 1;
  return names[monthIndex] || month;
}

function updateSelectionSummary(stationLabel, day, month, yearsWithAnyData) {
  const prettyDate = `${Number(day)} de ${monthNameEs(month)}`;
  selectionSummary.textContent = `${prettyDate} · ${yearsWithAnyData} anos con datos disponibles`;
  chartTitle.textContent = `Evolucion anual para ${prettyDate}`;
}

async function parseApiResponse(response) {
  const contentType = String(response.headers.get("content-type") || "").toLowerCase();

  if (contentType.includes("application/json")) {
    try {
      return await response.json();
    } catch (_error) {
      return null;
    }
  }

  const text = await response.text();
  return {
    error: text || "Respuesta no JSON recibida del servidor",
    rawText: text,
  };
}

async function loadStations() {
  setStatus("Cargando estaciones...");
  const response = await fetch("/api/stations");
  const rawStations = await parseApiResponse(response);

  if (!response.ok) {
    const reason = rawStations && rawStations.error ? rawStations.error : "No se pudieron cargar estaciones";
    throw new Error(reason);
  }

  if (!Array.isArray(rawStations)) {
    throw new Error("La API de estaciones devolvio un formato inesperado");
  }

  stations = rawStations
    .map(normalizeStation)
    .sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

  const renderedMarkers = renderStationMarkers();

  const firstWithCoordinates = stations.find(
    (station) => Number.isFinite(station.latitud) && Number.isFinite(station.longitud)
  );
  const firstAvailable = firstWithCoordinates || stations[0];
  if (firstAvailable) {
    selectStation(firstAvailable.idema, { panTo: false });
  }

  setStatus(`Estaciones cargadas: ${stations.length} (marcadores visibles: ${renderedMarkers})`);
  const { month, day } = extractMonthDay(dateInput.value);
  updateSelectionSummary(stationDisplayLabel(firstAvailable), day, month, 0);
}

async function fetchEvolution(station, month, day) {
  const params = new URLSearchParams({ station, month, day });
  const response = await fetch(`/api/evolution/jobs/enqueue?${params.toString()}`);
  const payload = await parseApiResponse(response);

  if (!response.ok) {
    const reason = payload && payload.error ? payload.error : "Error consultando evolucion";
    throw new Error(reason);
  }

  if (payload && payload.status === "done" && payload.result) {
    return payload.result;
  }

  const jobId = payload && payload.jobId ? String(payload.jobId) : "";
  if (!jobId) {
    throw new Error("No se pudo encolar el trabajo de evolucion");
  }

  return { jobId };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForEvolutionJob(jobId, jobToken) {
  while (true) {
    if (activeJobToken !== jobToken) {
      throw new Error("Consulta sustituida por una nueva peticion");
    }

    const response = await fetch(`/api/evolution/jobs/${encodeURIComponent(jobId)}`);
    const payload = await parseApiResponse(response);

    if (!response.ok) {
      const reason = payload && payload.error ? payload.error : "Error consultando el estado del trabajo";
      throw new Error(reason);
    }

    if (payload.status === "queued") {
      const position = Number(payload.queuePosition || 0);
      if (position > 0) {
        setStatus(`Consulta en cola (posicion ${position}). Puedes seguir usando el mapa.`);
      } else {
        setStatus("Consulta en cola. Puedes seguir usando el mapa.");
      }
    } else if (payload.status === "running") {
      const progress = payload.progress || {};
      const percent = Number(progress.percent || 0);
      const completed = Number(progress.completed || 0);
      const total = Number(progress.total || 0);
      setStatus(`Procesando en segundo plano: ${percent}% (${completed}/${total} anos).`);
    } else if (payload.status === "failed") {
      throw new Error(payload.error || "No se pudo completar la consulta en segundo plano");
    } else if (payload.status === "done") {
      if (!payload.result) {
        throw new Error("El trabajo finalizo sin resultados");
      }
      return payload.result;
    }

    await sleep(2000);
  }
}

function extractMonthDay(dateValue) {
  const parts = dateValue.split("-");
  if (parts.length !== 3) {
    throw new Error("Fecha no valida");
  }

  return { month: parts[1], day: parts[2] };
}

async function runSelectedStationQuery() {
  setLoadingState(true);

  try {
    const selectedStation = getSelectedStation();
    if (!selectedStation) {
      throw new Error("Selecciona una estacion en el mapa");
    }

    const station = selectedStation.idema;
    const stationLabel = stationDisplayLabel(selectedStation);
    const { month, day } = extractMonthDay(dateInput.value);
    const jobToken = `${Date.now()}_${station}_${month}_${day}`;
    activeJobToken = jobToken;

    setStatus("Encolando consulta historica...");
    const queued = await fetchEvolution(station, month, day);
    setLoadingState(false);

    const result = queued && queued.jobId ? await waitForEvolutionJob(queued.jobId, jobToken) : queued;
    if (activeJobToken !== jobToken) {
      return;
    }

    const rows = result.data;
    const yearsWithAnyData = Number(result.yearsWithAnyData || 0);
    const failedYears = Array.isArray(result.failedYears) ? result.failedYears : [];

    renderSummary(rows);
    renderTable(rows);
    renderChart(rows);

    updateSelectionSummary(stationLabel, day, month, yearsWithAnyData);
    if (failedYears.length > 0) {
      setStatus(
        `Consulta parcial: ${yearsWithAnyData} anos con datos y ${failedYears.length} anos con error de descarga (limite/cuota o red).`,
        true
      );
    } else if (yearsWithAnyData === 0) {
      setStatus("No hay datos disponibles para esa estacion y fecha en 1976-2026.", true);
    } else {
      setStatus(`Consulta completada: ${yearsWithAnyData} anos con datos.`);
    }
  } catch (error) {
    setStatus(error.message || "Error inesperado", true);
  } finally {
    setLoadingState(false);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  await runSelectedStationQuery();
});

(async () => {
  try {
    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    dateInput.value = `2000-${mm}-${dd}`;

    initializeMap();
    await loadStations();
  } catch (error) {
    setStatus(error.message || "Error inicializando la app", true);
  }
})();

dateInput.addEventListener("change", () => {
  try {
    const stationLabel = stationDisplayLabel(getSelectedStation());
    const { month, day } = extractMonthDay(dateInput.value);
    updateSelectionSummary(stationLabel, day, month, 0);
  } catch (_error) {
    // Ignorar hasta que haya una fecha valida.
  }
});

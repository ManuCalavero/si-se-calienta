const stationSelect = document.getElementById("station");
const form = document.getElementById("query-form");
const dateInput = document.getElementById("date");
const submitButton = form.querySelector("button[type='submit']");
const submitButtonLabel = submitButton.querySelector(".btn-label");
const statusEl = document.getElementById("status");
const statusSpinner = document.getElementById("status-spinner");
const summaryEl = document.getElementById("summary");
const tableBody = document.querySelector("#results-table tbody");
const tableCaption = document.getElementById("table-caption");
const chartTitle = document.getElementById("chart-title");
const selectionSummary = document.getElementById("selection-summary");

let chart;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#b42318" : "";
}

function setLoadingState(isLoading) {
  document.body.classList.toggle("loading", isLoading);
  stationSelect.disabled = isLoading;
  dateInput.disabled = isLoading;
  submitButton.disabled = isLoading;
  submitButtonLabel.textContent = isLoading ? "Consultando" : "Ver evolucion";
  statusSpinner.classList.toggle("hidden", !isLoading);
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
  card.innerHTML = `
    <h3>${title}</h3>
    <p>${formatValue(value, unit)}</p>
  `;
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
    tr.innerHTML = `
      <td>${row.year}</td>
      <td>${formatValue(row.tmax)}</td>
      <td>${formatValue(row.tmin)}</td>
      <td>${formatValue(row.tmed)}</td>
      <td>${formatValue(row.prec)}</td>
    `;
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
  if (stationLabel) {
    tableCaption.textContent = `${stationLabel} | ${String(day).padStart(2, "0")}/${String(month).padStart(2, "0")}`;
  }
}

async function loadStations() {
  setStatus("Cargando estaciones...");
  const response = await fetch("/api/stations");
  const stations = await response.json();

  if (!response.ok) {
    throw new Error(stations.error || "No se pudieron cargar estaciones");
  }

  stationSelect.innerHTML = stations
    .map(
      (s) =>
        `<option value="${s.idema}">${s.nombre} (${s.idema}) - ${s.provincia}</option>`
    )
    .join("");

  setStatus(`Estaciones cargadas: ${stations.length}`);
  const initialLabel = stationSelect.options[stationSelect.selectedIndex]?.text || "";
  const { month, day } = extractMonthDay(dateInput.value);
  updateSelectionSummary(initialLabel, day, month, 0);
}

async function fetchEvolution(station, month, day) {
  const params = new URLSearchParams({ station, month, day });
  const response = await fetch(`/api/evolution?${params.toString()}`);
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Error consultando evolucion");
  }

  return payload;
}

function extractMonthDay(dateValue) {
  const parts = dateValue.split("-");
  if (parts.length !== 3) {
    throw new Error("Fecha no valida");
  }

  return { month: parts[1], day: parts[2] };
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setLoadingState(true);

  try {
    const station = stationSelect.value;
    const stationLabel = stationSelect.options[stationSelect.selectedIndex]?.text || station;
    const { month, day } = extractMonthDay(dateInput.value);

    setStatus("Consultando datos historicos en AEMET (modo completo, puede tardar 1-3 minutos)...");
    const result = await fetchEvolution(station, month, day);
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
});

(async () => {
  try {
    const today = new Date();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    dateInput.value = `2000-${mm}-${dd}`;

    await loadStations();
  } catch (error) {
    setStatus(error.message || "Error inicializando la app", true);
  }
})();

stationSelect.addEventListener("change", () => {
  try {
    const stationLabel = stationSelect.options[stationSelect.selectedIndex]?.text || "";
    const { month, day } = extractMonthDay(dateInput.value);
    updateSelectionSummary(stationLabel, day, month, 0);
  } catch (_error) {
    // Ignorar hasta que haya una fecha valida.
  }
});

dateInput.addEventListener("change", () => {
  try {
    const stationLabel = stationSelect.options[stationSelect.selectedIndex]?.text || "";
    const { month, day } = extractMonthDay(dateInput.value);
    updateSelectionSummary(stationLabel, day, month, 0);
  } catch (_error) {
    // Ignorar hasta que haya una fecha valida.
  }
});

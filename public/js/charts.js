import { anomalyColor, formatNumber } from "./format.js";

const annotationPlugin = window["chartjs-plugin-annotation"];
if (annotationPlugin) Chart.register(annotationPlugin);

Chart.defaults.font.family = '"Google Sans", system-ui, -apple-system, "Segoe UI", sans-serif';
Chart.defaults.font.size = 11;
Chart.defaults.color = "#6b6b6b";

// Mismos tonos que los tokens de styles.css: tinta #171717 sobre blanco, rojo, índigo y azul lluvia.
const INK = "#171717";
const MUTED = "#6b6b6b";
const SURFACE = "rgba(255, 255, 255, 0.92)";
const GRID = "rgba(23, 23, 23, 0.07)";
const WARM_LINE = "rgba(240, 86, 58, 0.85)";
const COOL_LINE = "rgba(90, 88, 227, 0.85)";
const RAIN = "#8fbdf0";
const RAIN_FILL = "rgba(143, 189, 240, 0.45)";
const RAIN_TEXT = "#2f6fb0";
// La lluvia ocupa como mucho el tercio inferior para no tapar las temperaturas.
const RAIN_HEADROOM = 3;

function rainAxis(analysis) {
  const values = analysis.complete.map((row) => row.prec).filter((value) => value !== null);
  const maxRain = values.length ? Math.max(...values) : 0;
  return {
    type: "linear",
    position: "right",
    display: "auto",
    beginAtZero: true,
    max: maxRain > 0 ? maxRain * RAIN_HEADROOM : 1,
    grid: { display: false },
    border: { display: false },
    afterBuildTicks: (axis) => {
      axis.ticks = maxRain > 0 ? [{ value: 0 }, { value: maxRain }] : [{ value: 0 }];
    },
    ticks: {
      color: RAIN_TEXT,
      callback: (value) => `${formatNumber(value, value > 0 && value < 10 ? 1 : 0)} mm`,
    },
  };
}

let tempChart = null;

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function anomalyScale(analysis) {
  const values = [...analysis.anomalies.values()].map(Math.abs);
  return Math.max(0.8, ...values);
}

function yearAxis(rows) {
  return {
    type: "linear",
    offset: false,
    min: rows.length ? rows[0].year - 0.5 : undefined,
    max: rows.length ? rows[rows.length - 1].year + 0.5 : undefined,
    grid: { display: false },
    border: { color: GRID },
    ticks: { maxTicksLimit: 8, maxRotation: 0, callback: (value) => (Number.isInteger(value) ? String(value) : null) },
  };
}

function tooltip() {
  return {
    mode: "index",
    intersect: false,
    backgroundColor: "rgba(255, 255, 255, 0.97)",
    titleColor: INK,
    bodyColor: INK,
    borderColor: "rgba(23, 23, 23, 0.12)",
    borderWidth: 1,
    padding: 10,
    boxPadding: 4,
    callbacks: {
      title: (items) => (items.length ? String(items[0].parsed.x) : ""),
      label: (item) => {
        const isRain = item.dataset.id === "prec";
        return `${item.dataset.label}: ${formatNumber(item.parsed.y, isRain ? 2 : 1)} ${isRain ? "mm/día" : "°C"}`;
      },
    },
  };
}

function boxAnnotation(range, color, text, align) {
  return {
    type: "box",
    xMin: range[0] - 0.5,
    xMax: range[1] + 0.5,
    backgroundColor: color,
    borderWidth: 0,
    label: {
      display: true,
      content: text,
      position: { x: align, y: "start" },
      color: INK,
      font: { size: 10, weight: "500" },
      padding: 4,
    },
  };
}

function temperatureAnnotations(analysis) {
  const annotations = {};
  if (analysis.meanTmed !== null) {
    annotations.mean = {
      type: "line",
      yMin: analysis.meanTmed,
      yMax: analysis.meanTmed,
      borderColor: MUTED,
      borderWidth: 1.5,
      borderDash: [2, 4],
      label: {
        display: true,
        content: `Media ${formatNumber(analysis.meanTmed)} °C`,
        position: "center",
        backgroundColor: SURFACE,
        color: MUTED,
        font: { size: 10 },
        padding: 3,
      },
    };
  }
  if (analysis.change) {
    const { earlyRange, lateRange, earlyMean, lateMean } = analysis.change;
    annotations.early = boxAnnotation(earlyRange, "rgba(90, 88, 227, 0.08)", `Primeros años · ${formatNumber(earlyMean)} °C`, "start");
    annotations.late = boxAnnotation(lateRange, "rgba(240, 86, 58, 0.08)", `Últimos años · ${formatNumber(lateMean)} °C`, "end");
  }
  return annotations;
}

// Con más de un siglo de años los puntos se pisan: se encogen según el ancho disponible.
function pointRadiusFor(count, width) {
  const perPoint = width / Math.max(1, count);
  if (perPoint < 4) return 1.6;
  if (perPoint < 6) return 2.2;
  if (perPoint < 9) return 2.8;
  return 3.4;
}

function temperatureDatasets(analysis, visibility, width) {
  const rows = analysis.complete;
  const scale = anomalyScale(analysis);
  const radius = pointRadiusFor(rows.length, width);
  const exact = analysis.mode === "day";
  const datasets = [
    {
      id: "tmed",
      label: exact ? "T. media del día" : "T. media",
      data: rows.map((row) => ({ x: row.year, y: row.tmed })),
      borderColor: "rgba(23, 23, 23, 0.3)",
      borderWidth: radius < 2.5 ? 1.2 : 1.8,
      pointRadius: radius,
      pointHoverRadius: radius + 2.6,
      pointHoverBorderWidth: 2,
      pointHoverBorderColor: INK,
      pointBackgroundColor: rows.map((row) => anomalyColor(analysis.anomalies.get(row.year), scale) || MUTED),
      pointBorderColor: "rgba(23, 23, 23, 0.25)",
      pointBorderWidth: 1,
      tension: 0,
      order: 1,
    },
    {
      id: "tmax",
      label: "T. máxima",
      data: rows.map((row) => ({ x: row.year, y: row.tmax })),
      borderColor: WARM_LINE,
      borderWidth: radius < 2.5 ? 1.1 : 1.5,
      pointRadius: 0,
      hidden: !visibility.tmax,
      order: 3,
    },
    {
      id: "tmin",
      label: "T. mínima",
      data: rows.map((row) => ({ x: row.year, y: row.tmin })),
      borderColor: COOL_LINE,
      borderWidth: radius < 2.5 ? 1.1 : 1.5,
      pointRadius: 0,
      hidden: !visibility.tmin,
      order: 3,
    },
  ];

  datasets.push({
    id: "prec",
    type: "bar",
    label: "Lluvia",
    yAxisID: "yRain",
    data: rows.map((row) => ({ x: row.year, y: row.prec })),
    backgroundColor: RAIN_FILL,
    hoverBackgroundColor: RAIN,
    borderRadius: 2,
    barPercentage: 0.85,
    categoryPercentage: 1,
    hidden: !visibility.prec,
    order: 10,
  });

  if (analysis.trend) {
    const { intercept, slope, firstYear, lastYear } = analysis.trend;
    datasets.push({
      id: "trend",
      label: "Tendencia",
      data: [
        { x: firstYear, y: intercept + slope * firstYear },
        { x: lastYear, y: intercept + slope * lastYear },
      ],
      borderColor: INK,
      borderWidth: 2.4,
      borderDash: [6, 4],
      pointRadius: 0,
      order: 0,
    });
  }
  return datasets;
}

let hoverHandler = () => {};

export function onChartHover(handler) {
  hoverHandler = handler;
}

// Se mutan los datasets existentes en vez de sustituirlos: así Chart.js desplaza cada punto
// desde su valor anterior al nuevo y el cambio de día se percibe como una transición.
function mergeDatasets(chart, next) {
  const current = chart.data.datasets;
  const merged = next.map((dataset) => {
    const existing = current.find((item) => item.id === dataset.id);
    if (!existing) return dataset;
    const hidden = existing.hidden;
    Object.assign(existing, dataset);
    existing.hidden = dataset.id === "trend" ? false : hidden;
    return existing;
  });
  chart.data.datasets = merged;
}

export function renderTemperatureChart(canvas, analysis, visibility) {
  const width = canvas.parentElement ? canvas.parentElement.clientWidth : 600;
  const datasets = temperatureDatasets(analysis, visibility, width);
  const annotations = temperatureAnnotations(analysis);

  if (tempChart) {
    mergeDatasets(tempChart, datasets);
    tempChart.options.scales.x = yearAxis(analysis.complete);
    tempChart.options.scales.yRain = rainAxis(analysis);
    tempChart.options.plugins.annotation.annotations = annotations;
    tempChart.update();
    return;
  }

  tempChart = new Chart(canvas, {
    type: "line",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: reducedMotion() ? false : { duration: 650, easing: "easeOutQuart" },
      transitions: {
        active: { animation: { duration: 160 } },
      },
      interaction: { mode: "index", intersect: false },
      spanGaps: false,
      onHover: (_event, elements) => {
        const point = elements.find((item) => item.datasetIndex === 0) || elements[0];
        const year = point ? tempChart.data.datasets[point.datasetIndex].data[point.index].x : null;
        hoverHandler(year);
      },
      scales: {
        x: yearAxis(analysis.complete),
        y: {
          grid: { color: GRID },
          border: { display: false },
          grace: "4%",
          ticks: { callback: (value) => `${formatNumber(value, 0)}°` },
        },
        yRain: rainAxis(analysis),
      },
      plugins: {
        legend: { display: false },
        tooltip: tooltip(),
        annotation: { annotations },
      },
    },
  });
  canvas.addEventListener("mouseleave", () => hoverHandler(null));
}

// Resalta un año desde fuera del gráfico (franjas, tabla) con su tooltip.
export function highlightYear(year) {
  if (!tempChart) return;
  if (year === null) {
    tempChart.setActiveElements([]);
    tempChart.tooltip.setActiveElements([], { x: 0, y: 0 });
    tempChart.update("none");
    return;
  }
  const index = tempChart.data.datasets[0].data.findIndex((point) => point.x === year && point.y !== null);
  if (index === -1) return;
  const active = [{ datasetIndex: 0, index }];
  const element = tempChart.getDatasetMeta(0).data[index];
  tempChart.setActiveElements(active);
  tempChart.tooltip.setActiveElements(active, { x: element.x, y: element.y });
  tempChart.update("none");
}

export function setSeriesVisibility(id, visible) {
  if (!tempChart) return;
  const index = tempChart.data.datasets.findIndex((dataset) => dataset.id === id);
  if (index === -1) return;
  tempChart.data.datasets[index].hidden = !visible;
  tempChart.update();
}

export function resizeCharts() {
  if (tempChart) tempChart.resize();
}


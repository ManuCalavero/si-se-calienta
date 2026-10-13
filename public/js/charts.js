import { anomalyColor, formatNumber } from "./format.js";

const annotationPlugin = window["chartjs-plugin-annotation"];
if (annotationPlugin) Chart.register(annotationPlugin);

Chart.defaults.font.family = '"Google Sans", system-ui, -apple-system, "Segoe UI", sans-serif';
Chart.defaults.font.size = 11;
Chart.defaults.color = "#6d746e";

const INK = "#24302a";
const MUTED = "#6d746e";
const GRID = "rgba(36, 48, 42, 0.07)";
const WARM_LINE = "rgba(240, 86, 58, 0.8)";
const COOL_LINE = "rgba(46, 155, 240, 0.8)";
const RAIN = "#3ec1d9";
const RAIN_FILL = "rgba(62, 193, 217, 0.32)";
const RAIN_TEXT = "#1f8ea6";
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
    backgroundColor: "rgba(251, 252, 247, 0.97)",
    titleColor: INK,
    bodyColor: INK,
    borderColor: "rgba(36, 48, 42, 0.12)",
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
        backgroundColor: "rgba(251, 252, 247, 0.9)",
        color: MUTED,
        font: { size: 10 },
        padding: 3,
      },
    };
  }
  if (analysis.change) {
    const { earlyRange, lateRange, earlyMean, lateMean } = analysis.change;
    annotations.early = boxAnnotation(earlyRange, "rgba(46, 155, 240, 0.08)", `Primeros años · ${formatNumber(earlyMean)} °C`, "start");
    annotations.late = boxAnnotation(lateRange, "rgba(240, 86, 58, 0.08)", `Últimos años · ${formatNumber(lateMean)} °C`, "end");
  }
  return annotations;
}

function temperatureDatasets(analysis, visibility) {
  const rows = analysis.complete;
  const scale = anomalyScale(analysis);
  const datasets = [
    {
      id: "tmed",
      label: "T. media",
      data: rows.map((row) => ({ x: row.year, y: row.tmed })),
      borderColor: "rgba(36, 48, 42, 0.35)",
      borderWidth: 1.8,
      pointRadius: 3.2,
      pointHoverRadius: 5,
      pointBackgroundColor: rows.map((row) => anomalyColor(analysis.anomalies.get(row.year), scale) || MUTED),
      pointBorderColor: "rgba(36, 48, 42, 0.25)",
      pointBorderWidth: 1,
      tension: 0,
      order: 1,
    },
    {
      id: "tmax",
      label: "T. máxima",
      data: rows.map((row) => ({ x: row.year, y: row.tmax })),
      borderColor: WARM_LINE,
      borderWidth: 1.5,
      pointRadius: 0,
      hidden: !visibility.tmax,
      order: 3,
    },
    {
      id: "tmin",
      label: "T. mínima",
      data: rows.map((row) => ({ x: row.year, y: row.tmin })),
      borderColor: COOL_LINE,
      borderWidth: 1.5,
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

export function renderTemperatureChart(canvas, analysis, visibility) {
  const datasets = temperatureDatasets(analysis, visibility);
  const annotations = temperatureAnnotations(analysis);

  if (tempChart) {
    tempChart.data.datasets = datasets;
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
      animation: reducedMotion() ? false : { duration: 700, easing: "easeOutCubic" },
      interaction: { mode: "index", intersect: false },
      spanGaps: false,
      scales: {
        x: yearAxis(analysis.complete),
        y: {
          grid: { color: GRID },
          border: { display: false },
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


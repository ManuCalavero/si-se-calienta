import { anomalyColor, formatNumber } from "./format.js";

const annotationPlugin = window["chartjs-plugin-annotation"];
if (annotationPlugin) Chart.register(annotationPlugin);

Chart.defaults.font.family = '"IBM Plex Mono", ui-monospace, monospace';
Chart.defaults.font.size = 11;

// Mismos tonos que los tokens de styles.css: tarjeta blanca rota (#f1f0ea) con texto casi negro.
// Rojo para la máxima, azul para la mínima y turquesa para la lluvia.
const C = {
  ink: "#111111",
  muted: "#6a6962",
  surface: "rgba(241, 240, 234, 0.92)",
  grid: "rgba(17, 17, 17, 0.07)",
  warmLine: "#f7394b",
  coolLine: "#029dff",
  rain: "#05e1cf",
  rainFill: "rgba(5, 225, 207, 0.35)",
  rainText: "#00796f",
  tooltip: "rgba(250, 249, 245, 0.97)",
  tooltipBorder: "rgba(17, 17, 17, 0.12)",
  earlyBand: "rgba(2, 157, 255, 0.08)",
  lateBand: "rgba(247, 57, 75, 0.08)",
  meanLine: "rgba(17, 17, 17, 0.3)",
  pointBorder: "rgba(17, 17, 17, 0.25)",
};

Chart.defaults.color = C.muted;

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
      color: C.rainText,
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

// El eje llega hasta el año pendiente, si lo hay, para que su punto quepa a la derecha.
function yearAxis(analysis) {
  const rows = analysis.complete;
  const lastYear = analysis.pending ? analysis.pending.year : rows.length ? rows[rows.length - 1].year : undefined;
  return {
    type: "linear",
    offset: false,
    min: rows.length ? rows[0].year - 0.5 : undefined,
    max: lastYear !== undefined ? lastYear + 0.5 : undefined,
    grid: { display: false },
    border: { color: C.grid },
    ticks: { maxTicksLimit: 8, maxRotation: 0, callback: (value) => (Number.isInteger(value) ? String(value) : null) },
  };
}

function tooltip() {
  return {
    mode: "index",
    intersect: false,
    backgroundColor: C.tooltip,
    titleColor: C.ink,
    bodyColor: C.ink,
    borderColor: C.tooltipBorder,
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
      color: C.ink,
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
      borderColor: C.muted,
      borderWidth: 1.5,
      borderDash: [2, 4],
      label: {
        display: true,
        content: `Media ${formatNumber(analysis.meanTmed)} °C`,
        position: "center",
        backgroundColor: C.surface,
        color: C.muted,
        font: { size: 10 },
        padding: 3,
      },
    };
  }
  if (analysis.change) {
    const { earlyRange, lateRange, earlyMean, lateMean } = analysis.change;
    // En móvil las dos etiquetas no caben en una línea sin pisarse.
    const label = (title, value) => (window.matchMedia("(max-width: 760px)").matches ? [title, `${formatNumber(value)} °C`] : `${title} · ${formatNumber(value)} °C`);
    annotations.early = boxAnnotation(earlyRange, C.earlyBand, label("Primeros años", earlyMean), "start");
    annotations.late = boxAnnotation(lateRange, C.lateBand, label("Últimos años", lateMean), "end");
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
      borderColor: C.meanLine,
      borderWidth: radius < 2.5 ? 1.2 : 1.8,
      pointRadius: radius,
      pointHoverRadius: radius + 2.6,
      pointHoverBorderWidth: 2,
      pointHoverBorderColor: C.ink,
      pointBackgroundColor: rows.map((row) => anomalyColor(analysis.anomalies.get(row.year), scale) || C.muted),
      pointBorderColor: C.pointBorder,
      pointBorderWidth: 1,
      tension: 0,
      order: 1,
    },
    {
      id: "tmax",
      label: "T. máxima",
      data: rows.map((row) => ({ x: row.year, y: row.tmax })),
      borderColor: C.warmLine,
      borderWidth: radius < 2.5 ? 1.1 : 1.5,
      pointRadius: 0,
      hidden: !visibility.tmax,
      order: 3,
    },
    {
      id: "tmin",
      label: "T. mínima",
      data: rows.map((row) => ({ x: row.year, y: row.tmin })),
      borderColor: C.coolLine,
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
    backgroundColor: C.rainFill,
    hoverBackgroundColor: C.rain,
    borderRadius: 2,
    barPercentage: 0.85,
    categoryPercentage: 1,
    hidden: !visibility.prec,
    order: 10,
  });

  if (analysis.trend) {
    const { intercept, slope, firstYear, lastYear } = analysis.trend;
    // Un valor por año, alineado con las demás series: el tooltip agrupa por posición, y con solo
    // dos puntos juntaba el segundo con el segundo año de la serie.
    datasets.push({
      id: "trend",
      label: "Tendencia",
      data: rows.map((row) => ({
        x: row.year,
        y: row.year >= firstYear && row.year <= lastYear ? intercept + slope * row.year : null,
      })),
      borderColor: C.ink,
      borderWidth: 2.4,
      borderDash: [6, 4],
      pointRadius: 0,
      order: 0,
    });
  }

  // Año en curso con la ventana a medias: punto hueco, sin unir a la serie.
  // Va en la posición siguiente a la última de las otras series (con huecos antes): el tooltip agrupa
  // por posición y, si el punto fuera el primero, lo juntaría con los valores del primer año.
  if (analysis.pending) {
    const { year, tmed, days, of } = analysis.pending;
    datasets.push({
      id: "pending",
      label: `T. media (pendiente, ${days} de ${of} días)`,
      data: [...rows.map((row) => ({ x: row.year, y: null })), { x: year, y: tmed }],
      showLine: false,
      // Cae en el borde derecho del área: sin recorte, para que se vea el círculo entero.
      clip: false,
      pointRadius: radius + 0.6,
      pointHoverRadius: radius + 2.6,
      pointBackgroundColor: C.surface,
      pointBorderColor: C.muted,
      pointBorderWidth: 1.5,
      pointHoverBorderColor: C.ink,
      order: 1,
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
    tempChart.options.scales.x = yearAxis(analysis);
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
        x: yearAxis(analysis),
        y: {
          grid: { color: C.grid },
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


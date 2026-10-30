import { anomalyScale } from "./charts.js";
import { anomalyColor, formatNumber, formatSigned } from "./format.js";

const PAPER = "#fbfcf7";
const IVORY = "#f3f5ea";
const INK = "#24302a";
const MUTED = "#6d746e";
const LINE = "rgba(36, 48, 42, 0.12)";
const WARM_INK = "#c23a22";
const COOL_INK = "#1f6fb8";
const ACCENT_INK = "#4d6b00";
const BRAND_STRIPES = ["#2e9bf0", "#6bb6f2", "#aed3ef", "#eef1e4", "#f6c4b6", "#f4977f", "#f2735a", "#f0563a"];
const FONT = '"Google Sans", system-ui, -apple-system, "Segoe UI", sans-serif';

export const SHARE_FORMATS = {
  square: { width: 1080, height: 1080, label: "1:1" },
  story: { width: 1080, height: 1920, label: "9:16" },
};

function font(weight, size) {
  return `${weight} ${size}px ${FONT}`;
}

function wrapLines(ctx, text, maxWidth) {
  const words = text.split(" ");
  const lines = [];
  let line = "";
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawBrand(ctx, x, y, size) {
  ctx.save();
  roundRect(ctx, x, y, size, size, size * 0.28);
  ctx.clip();
  const w = size / BRAND_STRIPES.length;
  BRAND_STRIPES.forEach((color, index) => {
    ctx.fillStyle = color;
    ctx.fillRect(x + index * w, y, w + 0.5, size);
  });
  ctx.restore();
  ctx.fillStyle = INK;
  ctx.font = font(600, size * 0.62);
  ctx.textBaseline = "middle";
  ctx.fillText("Si se calienta", x + size + size * 0.4, y + size / 2 + 1);
}

// Mini gráfico: franjas climáticas abajo y la serie de temperatura con su tendencia encima.
function drawMiniChart(ctx, analysis, box) {
  const rows = analysis.complete.filter((row) => row.year >= analysis.firstYear && row.year <= analysis.lastYear);
  if (!rows.length) return;
  const scale = anomalyScale(analysis);
  const stripeHeight = Math.round(box.h * 0.26);
  const plotHeight = box.h - stripeHeight - 28;
  const step = box.w / rows.length;

  ctx.save();
  roundRect(ctx, box.x, box.y + plotHeight + 28, box.w, stripeHeight, 14);
  ctx.clip();
  rows.forEach((row, index) => {
    const color = anomalyColor(analysis.anomalies.get(row.year), scale);
    ctx.fillStyle = color || IVORY;
    ctx.fillRect(box.x + index * step, box.y + plotHeight + 28, step + 0.6, stripeHeight);
  });
  ctx.restore();

  const values = rows.map((row) => row.tmed).filter((value) => value !== null);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.12 || 1;
  const yFor = (value) => box.y + plotHeight - ((value - (min - pad)) / (max - min + 2 * pad)) * plotHeight;
  const xFor = (index) => box.x + step * (index + 0.5);

  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.setLineDash([3, 8]);
  ctx.beginPath();
  ctx.moveTo(box.x, yFor(analysis.meanTmed));
  ctx.lineTo(box.x + box.w, yFor(analysis.meanTmed));
  ctx.stroke();
  ctx.setLineDash([]);

  const radius = Math.max(4, Math.min(9, step * 0.42));
  rows.forEach((row, index) => {
    if (row.tmed === null) return;
    ctx.beginPath();
    ctx.arc(xFor(index), yFor(row.tmed), radius, 0, Math.PI * 2);
    ctx.fillStyle = anomalyColor(analysis.anomalies.get(row.year), scale) || MUTED;
    ctx.fill();
    ctx.lineWidth = 1.2;
    ctx.strokeStyle = "rgba(36, 48, 42, 0.28)";
    ctx.stroke();
  });

  if (analysis.trend) {
    const { intercept, slope } = analysis.trend;
    const first = rows[0].year;
    const last = rows[rows.length - 1].year;
    ctx.strokeStyle = INK;
    ctx.lineWidth = 5;
    ctx.lineCap = "round";
    ctx.setLineDash([18, 12]);
    ctx.beginPath();
    ctx.moveTo(xFor(0), yFor(intercept + slope * first));
    ctx.lineTo(xFor(last - first), yFor(intercept + slope * last));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  ctx.fillStyle = MUTED;
  ctx.font = font(500, 26);
  ctx.textBaseline = "top";
  ctx.textAlign = "left";
  ctx.fillText(String(rows[0].year), box.x, box.y + plotHeight + 28 + stripeHeight + 14);
  ctx.textAlign = "right";
  ctx.fillText(String(rows[rows.length - 1].year), box.x + box.w, box.y + plotHeight + 28 + stripeHeight + 14);
  ctx.textAlign = "left";
}

export async function drawShareCard(canvas, { format, station, dayText, analysis, host, method = "" }) {
  const { width, height } = SHARE_FORMATS[format];
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  try {
    await Promise.all([document.fonts.load(font(600, 40)), document.fonts.load(font(500, 40))]);
  } catch (_error) {
    // Sin la fuente se usa la del sistema.
  }

  const isStory = format === "story";
  const margin = isStory ? 96 : 80;
  const inner = width - margin * 2;

  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, width, height);
  const glow = ctx.createRadialGradient(width, 0, 0, width, 0, width * 1.1);
  glow.addColorStop(0, "rgba(240, 86, 58, 0.10)");
  glow.addColorStop(1, "rgba(240, 86, 58, 0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);

  let y = isStory ? 140 : margin;
  drawBrand(ctx, margin, y, 56);
  y += 56 + (isStory ? 120 : 64);

  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = ACCENT_INK;
  ctx.font = font(600, 30);
  const eyebrow = `${dayText.toUpperCase()} · ${station.nombreVisible.toUpperCase()}`;
  wrapLines(ctx, eyebrow, inner).slice(0, 2).forEach((line) => {
    ctx.fillText(line, margin, y);
    y += 40;
  });
  y += isStory ? 40 : 16;

  const change = analysis.change;
  const delta = change ? change.delta : null;
  ctx.fillStyle = delta === null ? INK : delta >= 0 ? WARM_INK : COOL_INK;
  const bigSize = isStory ? 250 : 200;
  ctx.font = font(600, bigSize);
  const big = delta === null ? "—" : `${formatSigned(delta)} °C`;
  y += bigSize * 0.78;
  ctx.fillText(big, margin - bigSize * 0.04, y);
  y += isStory ? 72 : 52;

  ctx.fillStyle = INK;
  ctx.font = font(500, isStory ? 52 : 44);
  const sentence = change
    ? `${delta >= 0 ? "más cálido" : "más fresco"} en ${change.lateRange[0]}–${change.lateRange[1]} que en ${change.earlyRange[0]}–${change.earlyRange[1]}`
    : "Aún hay pocos años con datos para comparar";
  const lineHeight = isStory ? 66 : 56;
  wrapLines(ctx, sentence, inner).slice(0, 3).forEach((line) => {
    ctx.fillText(line, margin, y);
    y += lineHeight;
  });

  ctx.fillStyle = MUTED;
  ctx.font = font(400, isStory ? 34 : 28);
  if (analysis.latest && analysis.latest.rank <= 10) {
    y += 4;
    const { year, rank, of } = analysis.latest;
    ctx.fillStyle = INK;
    ctx.fillText(
      rank === 1 ? `${year} fue el año más cálido de ${of} en este día.` : `${year} fue el ${rank}.º año más cálido de ${of}.`,
      margin,
      y
    );
    y += isStory ? 52 : 42;
    ctx.fillStyle = MUTED;
  }
  if (method) {
    wrapLines(ctx, method, inner).slice(0, 2).forEach((line) => {
      ctx.fillText(line, margin, y);
      y += isStory ? 46 : 38;
    });
  }

  const chartTop = y + (isStory ? 80 : 20);
  const chartBottom = height - (isStory ? 260 : 150);
  drawMiniChart(ctx, analysis, { x: margin, y: chartTop, w: inner, h: Math.max(160, chartBottom - chartTop) });

  const footerY = height - (isStory ? 130 : 58);
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(margin, footerY - 36);
  ctx.lineTo(width - margin, footerY - 36);
  ctx.stroke();
  ctx.font = font(500, 26);
  ctx.fillStyle = MUTED;
  ctx.textBaseline = "middle";
  ctx.fillText("Datos: © AEMET OpenData", margin, footerY);
  ctx.textAlign = "right";
  ctx.fillStyle = INK;
  ctx.fillText(host, width - margin, footerY);
  ctx.textAlign = "left";

  return canvas;
}

export function canvasToBlob(canvas) {
  return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
}

export function shareFileName(station, month, day, format) {
  return `si-se-calienta_${station.idema}_${month}-${day}_${SHARE_FORMATS[format].label.replace(":", "x")}.png`;
}

export function shareCaption(station, dayText, analysis) {
  if (!analysis.change) return `${dayText} en ${station.nombreVisible}, año a año desde que hay registros.`;
  const { delta, lateRange, earlyRange } = analysis.change;
  return `El ${dayText} en ${station.nombreVisible} es ${formatNumber(Math.abs(delta))} °C ${
    delta >= 0 ? "más cálido" : "más fresco"
  } en ${lateRange[0]}–${lateRange[1]} que en ${earlyRange[0]}–${earlyRange[1]}. Datos: AEMET.`;
}

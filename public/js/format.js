const MONTHS = [
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

const formatters = new Map();

export function formatNumber(value, decimals = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  if (!formatters.has(decimals)) {
    formatters.set(
      decimals,
      new Intl.NumberFormat("es-ES", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
    );
  }
  return formatters.get(decimals).format(value);
}

export function formatSigned(value, decimals = 1) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  const rounded = Number(value.toFixed(decimals));
  const sign = rounded > 0 ? "+" : rounded < 0 ? "−" : "";
  return `${sign}${formatNumber(Math.abs(rounded), decimals)}`;
}

export function monthName(month) {
  return MONTHS[Number(month) - 1] || String(month);
}

export function prettyDay(month, day) {
  return `${Number(day)} de ${monthName(month)}`;
}

export function formatDuration(seconds) {
  const s = Number(seconds) || 0;
  if (s <= 5) return "unos segundos";
  if (s < 60) return `~${Math.ceil(s / 5) * 5} s`;
  return `~${Math.ceil(s / 60)} min`;
}

export function titleCase(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/(^|[\s,.\-/(])(\p{L})/gu, (_match, sep, letter) => sep + letter.toUpperCase());
}

const COOL = [46, 155, 240];
const NEUTRAL = [243, 245, 234];
const WARM = [240, 86, 58];

function mix(a, b, t) {
  return a.map((value, index) => Math.round(value + (b[index] - value) * t));
}

export function anomalyColor(anomaly, scale) {
  if (anomaly === null || anomaly === undefined || !Number.isFinite(anomaly)) return null;
  const t = Math.max(-1, Math.min(1, anomaly / scale));
  const [r, g, b] = t < 0 ? mix(NEUTRAL, COOL, -t) : mix(NEUTRAL, WARM, t);
  return `rgb(${r}, ${g}, ${b})`;
}

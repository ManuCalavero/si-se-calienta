export const MIN_YEARS_FOR_TREND = 10;
const COMMON_PERIOD_START = 1976;

export function hasData(row) {
  return row.tmax !== null || row.tmin !== null || row.tmed !== null || row.prec !== null;
}

export function mean(values) {
  const valid = values.filter((value) => value !== null && value !== undefined && Number.isFinite(value));
  return valid.length ? valid.reduce((acc, value) => acc + value, 0) / valid.length : null;
}

export function regression(points) {
  const n = points.length;
  if (n < MIN_YEARS_FOR_TREND) return null;

  const meanX = mean(points.map((p) => p.x));
  const meanY = mean(points.map((p) => p.y));
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (const p of points) {
    sxx += (p.x - meanX) ** 2;
    sxy += (p.x - meanX) * (p.y - meanY);
    syy += (p.y - meanY) ** 2;
  }

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  const sse = points.reduce((acc, p) => acc + (p.y - (intercept + slope * p.x)) ** 2, 0);
  const stderr = Math.sqrt(sse / (n - 2)) / Math.sqrt(sxx);

  return {
    n,
    slope,
    intercept,
    slopePerDecade: slope * 10,
    stderrPerDecade: stderr * 10,
    r2: syy > 0 ? 1 - sse / syy : 0,
    t: stderr > 0 ? slope / stderr : 0,
    firstYear: points[0].x,
    lastYear: points[n - 1].x,
  };
}

function compressYears(years) {
  const ranges = [];
  for (const year of years) {
    const last = ranges[ranges.length - 1];
    if (last && year === last[1] + 1) last[1] = year;
    else ranges.push([year, year]);
  }
  return ranges.map(([a, b]) => (a === b ? String(a) : `${a}–${b}`));
}

// El ano en curso se excluye: su ventana de 15 dias puede estar incompleta o en el futuro.
export function analyze(result) {
  const rows = result.data || [];
  const lastCompleteYear = Number(result.endYear) - 1;
  const complete = rows.filter((row) => row.year <= lastCompleteYear);
  const valid = complete.filter((row) => row.tmed !== null);
  const points = valid.map((row) => ({ x: row.year, y: row.tmed }));

  const meanTmed = mean(valid.map((row) => row.tmed));
  const trend = regression(points);
  const trendCommon = regression(points.filter((p) => p.x >= COMMON_PERIOD_START));

  let change = null;
  if (valid.length >= MIN_YEARS_FOR_TREND) {
    const size = valid.length >= 20 ? 10 : 5;
    const early = valid.slice(0, size);
    const late = valid.slice(-size);
    const earlyMean = mean(early.map((row) => row.tmed));
    const lateMean = mean(late.map((row) => row.tmed));
    change = {
      delta: lateMean - earlyMean,
      size,
      earlyMean,
      lateMean,
      earlyRange: [early[0].year, early[early.length - 1].year],
      lateRange: [late[0].year, late[late.length - 1].year],
    };
  }

  let record = null;
  for (const row of complete) {
    const value = row.day ? row.day.tmax : null;
    if (value !== null && value !== undefined && (!record || value > record.value)) {
      record = { value, year: row.year };
    }
  }

  const anomalies = new Map(valid.map((row) => [row.year, row.tmed - meanTmed]));
  const firstYear = valid.length ? valid[0].year : null;
  const lastYear = valid.length ? valid[valid.length - 1].year : null;
  const missingYears = firstYear === null
    ? []
    : complete.filter((row) => row.year >= firstYear && row.year <= lastYear && row.tmed === null).map((row) => row.year);

  let verdict = "insufficient";
  if (trend) {
    if (trend.t >= 2 && trend.slope > 0) verdict = "warming";
    else if (trend.t <= -2 && trend.slope < 0) verdict = "cooling";
    else verdict = "unclear";
  }

  return {
    rows,
    complete,
    valid,
    firstYear,
    lastYear,
    meanTmed,
    trend,
    trendCommon,
    change,
    record,
    anomalies,
    precipMean: mean(valid.map((row) => row.prec)),
    gaps: compressYears(missingYears),
    missingCount: missingYears.length,
    verdict,
  };
}

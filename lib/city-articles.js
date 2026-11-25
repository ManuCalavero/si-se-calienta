// Artículos «tópico contra datos» por ciudad: cada uno pone a prueba un dicho sobre su clima con la estación de AEMET.
// Las cifras salen de data/city-stories.json (scripts/build-city-stories.js); el texto está escrito a mano para cada ciudad.
// Si se regeneran los datos, repasa las frases con adjetivos («casi se han triplicado»…): los números cambian solos, las palabras no.

const { cities, normal: NORMAL } = require("../data/city-stories.json");

const PUBLISHED = "2026-11-25";
const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const MONTHS_TITLE = MONTHS.map((m) => m[0].toUpperCase() + m.slice(1));

// ---------- Formato ----------

const n = (value, digits = 0) =>
  Number(value).toLocaleString("es-ES", { minimumFractionDigits: digits, maximumFractionDigits: digits, useGrouping: Math.abs(value) >= 10000 });
const deg = (value, digits = 1) => `${n(value, digits)}&nbsp;°C`;
const mm = (value) => `${n(value)}&nbsp;mm`;
const date = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} de ${MONTHS[m - 1]} de ${y}`;
};
const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
const shortDate = (iso) => {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d}&nbsp;${MONTHS_SHORT[m - 1]} ${y}`;
};
const dayMonth = (doy) => {
  const d = new Date(Date.UTC(2023, 0, doy));
  return `${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]}`;
};
const yearOf2 = (iso) => iso.slice(0, 4);
const period = (p) => `${p.firstYear}-${p.lastYear}`;
const yearOf = (s, year) => s.years.find((y) => y.year === year) || {};
const maxYear = (s, key) => s.years.filter((y) => Number.isFinite(y[key])).reduce((a, b) => (b[key] > a[key] ? b : a));
const lastFrostYear = (s) => (s.lastFrost ? Number(s.lastFrost.slice(0, 4)) : null);

// ---------- Piezas ----------

function keyFacts(items) {
  return `<ul class="key-facts" aria-label="Datos clave">${items.map(([value, text]) => `<li><strong>${value}</strong><span>${text}</span></li>`).join("")}</ul>`;
}

// Barras en HTML/CSS (sin JS): una sola serie, el título del gráfico dice qué es; cada barra lleva su valor en title para el ratón
// y se rotulan solo unas pocas (primera, última, máxima o las que se pidan).
function barChart({ title, note, items, tone = "warm", unit = "", digits = 0, labelEvery = 1, mark = [] }) {
  const values = items.map((i) => i.value).filter(Number.isFinite);
  const max = Math.max(...values) || 1;
  const maxIndex = items.findIndex((i) => i.value === Math.max(...values));
  const firstIndex = items.findIndex((i) => Number.isFinite(i.value));
  const lastIndex = items.length - 1 - [...items].reverse().findIndex((i) => Number.isFinite(i.value));
  const shown = new Set([firstIndex, lastIndex, maxIndex, ...mark.map((label) => items.findIndex((i) => i.label === label))]);
  const cols = items
    .map((item, index) => {
      if (!Number.isFinite(item.value)) return `<div class="chart-col is-missing" title="${item.label}: sin datos completos"></div>`;
      const text = `${n(item.value, digits)}${unit}`;
      const pct = Math.max((item.value / max) * 100, item.value > 0 ? 1.5 : 0);
      return `<div class="chart-col${shown.has(index) ? " is-labelled" : ""}" title="${item.label}: ${text}"><span class="chart-val">${shown.has(index) ? text : ""}</span><span class="chart-bar" style="height:${pct.toFixed(1)}%"></span></div>`;
    })
    .join("");
  const labels = items.map((item, index) => `<span>${index % labelEvery === 0 ? item.label : ""}</span>`).join("");
  return `<figure class="chart chart-${tone}" role="group" aria-label="${title}">
        <figcaption>${title}</figcaption>
        <div class="chart-bars">${cols}</div>
        <div class="chart-labels" aria-hidden="true">${labels}</div>
        ${note ? `<p class="chart-note">${note}</p>` : ""}
      </figure>`;
}

const decadeItems = (s, key, minYears = 5) =>
  s.decades.map((d) => ({ label: String(d.decade), value: (key === "prec" || key === "rain1" ? d.rainYears : d.tempYears) >= minYears ? d[key] : null }));

function monthlyTable(s, lugar) {
  const rows = s.months
    .map(
      (m) =>
        `<tr><th scope="row">${MONTHS_TITLE[m.month - 1]}</th><td class="num">${n(m.tmax, 1)} / ${deg(m.tmin)}</td><td class="num">${mm(m.prec)}</td>` +
        `<td class="num">${deg(m.recordMax.value)}<small>${shortDate(m.recordMax.date)}</small></td><td class="num">${deg(m.recordMin.value)}<small>${shortDate(m.recordMin.date)}</small></td></tr>`
    )
    .join("");
  return `<div class="table-wrap">
        <table class="capitals months">
          <caption>Medias de ${NORMAL[0]}-${NORMAL[1]} y récords de la estación en ${lugar}</caption>
          <thead><tr><th scope="col">Mes</th><th scope="col" class="num">Máx. / mín. media</th><th scope="col" class="num">Lluvia</th><th scope="col" class="num">Récord de calor</th><th scope="col" class="num">Récord de frío</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <p class="note">Los récords son los de esta estación con los datos diarios disponibles hasta el ${date(s.lastDate)}. Pueden no coincidir con los oficiales si faltan días en la serie, y los datos más recientes de AEMET son provisionales.</p>`;
}

function verdict(text) {
  return `<p class="verdict"><strong>Veredicto:</strong> ${text}</p>`;
}

function closing(stationSlug, lugar, stationName) {
  return `<aside class="cta">
        <h2>Compruébalo tú</h2>
        <p>En el mapa puedes elegir cualquier día del año y ver cómo ha cambiado en ${lugar} desde que hay datos, con la media de ±7 días y la lluvia, año a año. Los datos son de la estación ${stationName} de <a href="https://opendata.aemet.es/" target="_blank" rel="noopener noreferrer">AEMET OpenData</a>.</p>
        <p class="cta-links"><a class="button" href="/estacion/${stationSlug}">Ver ${lugar} en el mapa</a> <a href="/temperaturas">Todas las capitales</a></p>
      </aside>`;
}

// Enlaces entre artículos (no se puede usar TOPICS aquí: se construye llamando a estas funciones).
const TOPIC_LINKS = [
  { slug: "madrid-nueve-meses-de-invierno-tres-de-infierno", short: "Madrid: nueve meses de invierno y tres de infierno" },
  { slug: "sevilla-dias-de-40-grados", short: "Sevilla: ¿hay más días de 40 grados?" },
  { slug: "valencia-noches-tropicales", short: "Valencia: ¿no es el calor, es la humedad?" },
  { slug: "barcelona-sequia-lluvia", short: "Barcelona: ¿llueve cada vez menos?" },
  { slug: "bilbao-sirimiri-cuanto-llueve", short: "Bilbao: ¿cuánto llueve con el sirimiri?" },
  { slug: "a-coruna-llueve-mucho", short: "A Coruña: ¿llueve tanto como dicen?" },
];

function moreTopics(currentSlug) {
  const links = TOPIC_LINKS.filter((t) => t.slug !== currentSlug).map((t) => `<li><a href="/${t.slug}">${t.short}</a></li>`);
  return `<section class="more" aria-labelledby="mas-topicos"><h2 id="mas-topicos">Más tópicos del clima, con datos</h2><ul>${links.join("")}</ul></section>`;
}

const METHOD = (s, extra = "") =>
  `<p class="note">Cómo lo medimos: un año cuenta si tiene al menos 330 días con dato. Comparamos ${period(s.base)}, el periodo más antiguo común a las seis ciudades, con los últimos diez años completos (${period(s.recent)}). Llamamos noche tropical a la que no baja de 20&nbsp;°C, helada a una mínima de 0&nbsp;°C o menos y día de lluvia al que deja al menos 1&nbsp;mm. ${extra}</p>`;

// ---------- Madrid ----------

function madrid() {
  const s = cities["madrid-retiro"];
  const { base: b, recent: r } = s;
  const record = s.records.tmax;
  const recordMonths = s.months
    .filter((m) => m.recordMax.value === record.value)
    .map((m) => m.recordMax.date)
    .sort()
    .map(date);
  const d1930 = s.decades.find((d) => d.decade === 1930);
  return {
    slug: "madrid-nueve-meses-de-invierno-tres-de-infierno",
    station: "madrid-retiro",
    short: "Madrid: nueve meses de invierno y tres de infierno",
    title: "Nueve meses de invierno y tres de infierno: ¿sigue siendo así en Madrid?",
    seoTitle: "Nueve meses de invierno y tres de infierno en Madrid: los datos",
    description: `Datos del Retiro desde 1920: los días de 30 °C han pasado de ${n(b.t30)} a ${n(r.t30)} al año y las heladas, de ${n(b.frost)} a ${n(r.frost)}. Hoy Madrid tiene más infierno que invierno.`,
    published: PUBLISHED,
    modified: PUBLISHED,
    body: `
      <p class="lead">«Nueve meses de invierno y tres de infierno». Así se ha resumido siempre el clima de Madrid, y de buena parte de Castilla: inviernos largos, secos y de cielo azul, y veranos que aprietan sin piedad. El dicho exagera, como todos, pero ¿sigue retratando la ciudad? Lo comprobamos con la estación de AEMET del parque del Retiro, que tiene datos diarios desde 1920.</p>
      ${keyFacts([
        [`${n(b.t30)} → ${n(r.t30)}`, "días al año de 30&nbsp;°C o más"],
        [`${n(b.t35)} → ${n(r.t35)}`, "días al año de 35&nbsp;°C o más"],
        [`${n(b.frost)} → ${n(r.frost)}`, "heladas al año"],
        [`${n(b.cold)} → ${n(r.cold)}`, "días fríos al año (media por debajo de 8&nbsp;°C)"],
      ])}
      <p class="note">${period(b)} frente a ${period(r)}.</p>

      <h2>El infierno ya dura casi tres meses</h2>
      <p>Entre ${b.firstYear} y ${b.lastYear}, el Retiro pasaba de 30&nbsp;°C unos ${n(b.t30)} días al año: mes y medio de «infierno». En los últimos diez años han sido ${n(r.t30)}, casi tres meses. Los días de 35&nbsp;°C, que antes eran tres por verano, ahora son unos ${n(r.t35)}.</p>
      <p>El récord de la estación son ${deg(record.value)}, una marca que se ha alcanzado ${recordMonths.length > 1 ? `varias veces: el ${recordMonths.join(", el ")}` : `el ${date(record.date)}`}. Todas en los últimos años.</p>
      ${barChart({ title: "Días de 30 °C o más al año en el Retiro, media por década", items: decadeItems(s, "t30"), tone: "warm", note: "La década de 2020 solo incluye los años completos que lleva." })}

      <h2>Y el invierno, cada vez más corto</h2>
      <p>La otra mitad del dicho también se ha movido. En los años treinta helaba unos ${n(d1930.frost)} días al año en el Retiro. Entre ${b.firstYear} y ${b.lastYear}, ${n(b.frost)}. En la última década, ${n(r.frost)}. Los días fríos de verdad, con una media por debajo de 8&nbsp;°C, han bajado de ${n(b.cold)} a ${n(r.cold)}.</p>
      <p>El otro refrán madrileño, «el aire de Madrid es tan sutil que mata a un hombre y no apaga un candil», habla de ese frío seco de la meseta que se cuela sin hacer ruido. Sigue existiendo, pero es menos frecuente: la temperatura más baja de la serie, ${deg(s.records.tmin.value)}, es del ${date(s.records.tmin.date)}.</p>
      ${barChart({ title: "Heladas al año en el Retiro, media por década", items: decadeItems(s, "frost"), tone: "cold" })}

      <h2>Más infierno que invierno</h2>
      <p>Si contamos los días fríos como «invierno» y los de 30&nbsp;°C o más como «infierno», entre ${b.firstYear} y ${b.lastYear} Madrid tenía ${n(b.cold)} días de lo primero y ${n(b.t30)} de lo segundo. Hoy la proporción se ha dado la vuelta: ${n(r.cold)} frente a ${n(r.t30)}.</p>
      <p>Las noches lo notan todavía más. Las noches tropicales, las que no bajan de 20&nbsp;°C, han pasado de ${n(b.tropical)} a ${n(r.tropical)} al año. Aquí hay que tener en cuenta que el Retiro está en pleno centro: parte de ese aumento es el efecto de la ciudad, que guarda el calor del día y lo suelta de noche.</p>
      ${verdict(`nunca fueron nueve meses de invierno, y ahora menos. Pero los «tres meses de infierno» por fin se cumplen: Madrid tiene hoy más días de calor fuerte que de frío.`)}

      <h2>Temperaturas, lluvia y récords de Madrid, mes a mes</h2>
      ${monthlyTable(s, "Madrid (Retiro)")}
      ${METHOD(s)}
      ${closing("madrid-retiro", "Madrid", "Madrid Retiro")}
      ${moreTopics("madrid-nueve-meses-de-invierno-tres-de-infierno")}`,
  };
}

// ---------- Sevilla ----------

function sevilla() {
  const s = cities["sevilla-aeropuerto"];
  const { base: b, recent: r } = s;
  const top40 = maxYear(s, "t40");
  const recent21 = s.months.filter((m) => m.recordMax.date >= "2001").length;
  const seasonGain = r.last35 - r.first35 - (b.last35 - b.first35);
  const recentYears = s.years.filter((y) => Number.isFinite(y.prec) && y.year >= r.firstYear);
  const recentRain = {
    min: recentYears.reduce((a, y) => (y.prec < a.prec ? y : a)),
    max: recentYears.reduce((a, y) => (y.prec > a.prec ? y : a)),
  };
  return {
    slug: "sevilla-dias-de-40-grados",
    station: "sevilla-aeropuerto",
    short: "Sevilla: ¿hay más días de 40 grados?",
    title: "¿Hace más calor que nunca en Sevilla? Los días de 40 grados, con datos",
    seoTitle: "Días de 40 grados en Sevilla: ¿hace más calor que antes?",
    description: `Datos de AEMET desde 1951: Sevilla ha pasado de ${n(b.t40)} a ${n(r.t40)} días de 40 °C al año, y el primer día de 35 °C llega ahora a finales de mayo.`,
    published: PUBLISHED,
    modified: PUBLISHED,
    body: `
      <p class="lead">«Quien no ha visto Sevilla no ha visto maravilla». Tampoco ha pasado un agosto allí. Los sevillanos presumen de aguantar 40 grados con un abanico y una sombra, y de que la ciudad no se para por el calor, solo se esconde hasta que cae el sol. ¿Hay más días así que antes, o siempre fue igual? Lo miramos con la estación del aeropuerto de San Pablo, con datos diarios desde 1951.</p>
      ${keyFacts([
        [`${n(b.t40)} → ${n(r.t40)}`, "días al año de 40&nbsp;°C o más"],
        [`${n(b.t35)} → ${n(r.t35)}`, "días al año de 35&nbsp;°C o más"],
        [`${dayMonth(r.first35).replace(" de ", "&nbsp;")}`, `primer día de 35&nbsp;°C, de media; antes, el ${dayMonth(b.first35)}`],
        [`${n(b.tropical)} → ${n(r.tropical)}`, "noches tropicales al año"],
      ])}
      <p class="note">${period(b)} frente a ${period(r)}.</p>

      <h2>Los días de 40 grados casi se han triplicado</h2>
      <p>En Sevilla, 35&nbsp;°C es un día normal de verano: ya entre ${b.firstYear} y ${b.lastYear} había unos ${n(b.t35)} al año. Lo que ha cambiado es el extremo. Los días de 40&nbsp;°C o más eran unos ${n(b.t40)} por año y en la última década son ${n(r.t40)}. El año con más fue ${top40.year}, con ${top40.t40}.</p>
      ${barChart({ title: "Días de 40 °C o más al año en Sevilla, media por década", items: decadeItems(s, "t40"), tone: "warm", digits: 1, note: "La década de 1950 empieza en 1951 y la de 2020 solo incluye los años completos que lleva." })}
      <p>El récord de la estación sigue siendo de ${deg(s.records.tmax.value)}, del ${date(s.records.tmax.date)}. Es una marca difícil de batir: el récord de agosto, ${deg(s.months[7].recordMax.value)} en ${yearOf2(s.months[7].recordMax.date)}, se queda a ${n(s.records.tmax.value - s.months[7].recordMax.value, 1)}&nbsp;°C. En la tabla del final están los récords de cada mes: ${n(recent21)} de los doce son de este siglo.</p>

      <h2>El verano empieza antes y acaba después</h2>
      <p>Entre ${b.firstYear} y ${b.lastYear}, el primer día de 35&nbsp;°C llegaba de media el ${dayMonth(b.first35)} y el último era el ${dayMonth(b.last35)}. En los últimos diez años, el primero llega el ${dayMonth(r.first35)} y el último, el ${dayMonth(r.last35)}. La temporada de calor fuerte se ha alargado unos ${n(seasonGain)} días y va ya de finales de mayo a finales de septiembre.</p>

      <h2>Las noches, el cambio que más se nota</h2>
      <p>Lo que hace duro el verano sevillano no es solo la tarde, es que de madrugada no refresca. Las noches que no bajan de 20&nbsp;°C han pasado de ${n(b.tropical)} a ${n(r.tropical)} al año. Las heladas, en cambio, casi han desaparecido: de ${n(b.frost)} al año a ${n(r.frost)}.</p>
      <p>Con la lluvia hay que ser más prudente. La media ha bajado de ${mm(b.prec)} a ${mm(r.prec)}, pero los años sesenta fueron excepcionalmente húmedos y la variación entre años es enorme: en la última década ha habido años de ${mm(recentRain.min.prec)} (${recentRain.min.year}) y de ${mm(recentRain.max.prec)} (${recentRain.max.year}).</p>
      ${verdict(`sí, hace más calor que antes. Los 40 grados ya no son una rareza de cada verano sino unas dos semanas al año, y el calor fuerte llega antes y se va más tarde.`)}

      <h2>Temperaturas, lluvia y récords de Sevilla, mes a mes</h2>
      ${monthlyTable(s, "Sevilla (aeropuerto)")}
      ${METHOD(s, "El primer y el último día de 35&nbsp;°C son la media de los años que llegaron a esa temperatura.")}
      ${closing("sevilla-aeropuerto", "Sevilla", "Sevilla Aeropuerto")}
      ${moreTopics("sevilla-dias-de-40-grados")}`,
  };
}

// ---------- Valencia ----------

function valencia() {
  const s = cities.valencia;
  const { base: b, recent: r, normal: nm } = s;
  const d1940 = s.decades.find((d) => d.decade === 1940);
  const lastFrost = lastFrostYear(s);
  const topTropical = maxYear(s, "tropical");
  const rainy = [...s.months].map((m) => m.recordRain).sort((a, b2) => b2.value - a.value).slice(0, 3);
  const dana = s.years.find((y) => y.year === 2024);
  return {
    slug: "valencia-noches-tropicales",
    station: "valencia",
    short: "Valencia: ¿no es el calor, es la humedad?",
    title: "¿En Valencia ya no hace frío? Noches tropicales y heladas, con datos",
    seoTitle: "Noches tropicales en Valencia: ¿ya no hace frío? Los datos",
    description: `No hiela desde ${lastFrost} y las noches tropicales han pasado de ${n(b.tropical)} a ${n(r.tropical)} al año. Tres tópicos del clima de Valencia, comprobados con datos de AEMET desde 1937.`,
    published: PUBLISHED,
    modified: PUBLISHED,
    body: `
      <p class="lead">De Valencia se dicen tres cosas sobre el tiempo. Que aquí no hace frío. Que en verano «no es el calor, es la humedad». Y que cuando llueve, «plou a bots i barrals», llueve a cántaros. Comprobamos las tres con la estación de AEMET en la ciudad, con datos diarios desde 1937.</p>
      ${keyFacts([
        [String(lastFrost), "último año con una helada en la estación"],
        [`${n(b.tropical)} → ${n(r.tropical)}`, "noches tropicales al año"],
        [`${n(r.t35)}`, "días al año de 35&nbsp;°C o más: pocos, gracias al mar"],
        [`${n(nm.top3Share * 100)}&nbsp;%`, "de la lluvia de un año cae en sus tres días más lluviosos"],
      ])}

      <h2>«Aquí no hace frío»: ya ni hiela</h2>
      <p>Valencia nunca fue fría, pero helaba de vez en cuando. En los años cuarenta, unas ${n(d1940.frost)} veces al año. Entre ${b.firstYear} y ${b.lastYear}, algo más de una. La última helada en la estación fue el ${date(s.lastFrost)}. Los días fríos, con una media por debajo de 8&nbsp;°C, han pasado de ${n(b.cold)} al año a ${n(r.cold, 1)}.</p>
      <p>La temperatura más baja de la serie, ${deg(s.records.tmin.value)}, es del ${date(s.records.tmin.date)}, durante la gran ola de frío de 1956 que heló los naranjos.</p>

      <h2>«No es el calor, es la humedad»: son las noches</h2>
      <p>El refrán tiene razón en una cosa: el problema del verano valenciano no son las tardes. Gracias a la brisa del mar, Valencia pasa de 35&nbsp;°C pocos días al año, unos ${n(r.t35)}. Cuando lo hace es con viento de poniente, que trae el aire seco del interior: así se llegó al récord de ${deg(s.records.tmax.value)} el ${date(s.records.tmax.date)}. Ese mismo día, el aeropuerto de Manises marcó 46,8&nbsp;°C, la cifra que más se citó entonces: son dos estaciones distintas.</p>
      <p>Lo que no da tregua son las noches. El mar, cada vez más templado, impide que la temperatura baje de madrugada. Las noches que no bajan de 20&nbsp;°C han pasado de ${n(b.tropical)} al año entre ${b.firstYear} y ${b.lastYear} a ${n(r.tropical)} en la última década, más de tres meses. En ${topTropical.year} fueron ${topTropical.tropical}. No medimos la humedad, pero esa sensación de bochorno que no se va por la noche tiene mucho que ver con esto.</p>
      ${barChart({ title: "Noches tropicales al año en Valencia, media por década", items: decadeItems(s, "tropical"), tone: "warm", note: "Noches cuya mínima no baja de 20 °C. La década de 2020 solo incluye los años completos que lleva." })}

      <h2>«Plou a bots i barrals»: cierto, y no ha cambiado</h2>
      <p>En Valencia llueve poco, unos ${mm(nm.prec)} al año, y además de golpe: más de un tercio de la lluvia de un año suele caer en solo tres días. En Bilbao esa proporción es de un ${n(cities["bilbao-aeropuerto"].normal.top3Share * 100)}&nbsp;%. Los días más lluviosos de la serie lo dejan claro: ${rainy.map((d) => `${mm(d.value)} el ${date(d.date)}`).join(", ")}.</p>
      ${dana ? `<p>La lluvia también es muy local. La DANA del 29 de octubre de 2024, la más mortífera en décadas, dejó apenas 1,3&nbsp;mm en esta estación: el diluvio cayó aguas arriba, en las cuencas que desembocan al sur de la ciudad.</p>` : ""}
      ${verdict(`los tres tópicos aguantan. Valencia ya ni siquiera hiela, sus noches de verano son cada vez más largas y calurosas, y la lluvia sigue llegando en pocos días y a lo bestia.`)}

      <h2>Temperaturas, lluvia y récords de Valencia, mes a mes</h2>
      ${monthlyTable(s, "Valencia")}
      ${METHOD(s)}
      ${closing("valencia", "Valencia", "València")}
      ${moreTopics("valencia-noches-tropicales")}`,
  };
}

// ---------- Barcelona ----------

function barcelona() {
  const s = cities["barcelona-fabra"];
  const { base: b, recent: r, normal: nm } = s;
  const [driest1, driest2] = s.driestYears;
  const wettest = s.wettestYears[0];
  const y2024 = yearOf(s, 2024);
  const y2025 = yearOf(s, 2025);
  const rainItems = [];
  for (let year = 1980; year <= s.lastYear; year += 1) rainItems.push({ label: String(year), value: yearOf(s, year).prec ?? null });
  return {
    slug: "barcelona-sequia-lluvia",
    station: "barcelona-fabra",
    short: "Barcelona: ¿llueve cada vez menos?",
    title: "¿Llueve cada vez menos en Barcelona? La sequía, con datos",
    description: `${Math.min(driest1.year, driest2.year)} y ${Math.max(driest1.year, driest2.year)} fueron los años más secos en el observatorio Fabra desde 1920. ¿Llueve cada vez menos en Barcelona? Lluvia y calor con datos de AEMET.`,
    published: PUBLISHED,
    modified: PUBLISHED,
    body: `
      <p class="lead">«A l'abril, cada gota val per mil», dice el refrán catalán. Entre 2021 y 2024, Barcelona y buena parte de Cataluña vivieron una de las peores sequías que se recuerdan, con embalses bajo mínimos y restricciones de agua. ¿Es el nuevo normal, o fue una racha? Lo miramos con el observatorio Fabra, en la sierra de Collserola, una de las series más largas de España.</p>
      ${keyFacts([
        [mm(driest1.prec), `en ${driest1.year}, el año más seco de la serie`],
        [mm(nm.prec), `lluvia media al año (${NORMAL[0]}-${NORMAL[1]})`],
        [`${n(b.t30)} → ${n(r.t30)}`, "días al año de 30&nbsp;°C o más"],
        [`${n(b.tropical)} → ${n(r.tropical)}`, "noches tropicales al año"],
      ])}

      <h2>${Math.min(driest1.year, driest2.year)} y ${Math.max(driest1.year, driest2.year)}, los años más secos de la serie</h2>
      <p>Un año normal deja en Fabra unos ${mm(nm.prec)}. En ${driest2.year} cayeron ${mm(driest2.prec)} y en ${driest1.year}, ${mm(driest1.prec)}: los dos años más secos con datos completos desde los años veinte. 2023 tiene huecos en la serie y no entra en la comparación, pero también fue muy seco.</p>
      ${barChart({ title: "Lluvia de cada año en el observatorio Fabra (mm)", items: rainItems, tone: "rain", labelEvery: 10, mark: [String(driest1.year)], note: "Los huecos son años con menos de 330 días con dato." })}
      <p>Luego volvió a llover. ${y2024.prec ? `2024 cerró con ${mm(y2024.prec)}` : ""}${y2025.prec ? ` y 2025 con ${mm(y2025.prec)}` : ""}, cifras normales para la ciudad.</p>

      <h2>¿Hay una tendencia? No está clara</h2>
      <p>En Barcelona la lluvia varía muchísimo de un año a otro: del mínimo de ${mm(driest1.prec)} al máximo de ${mm(wettest.prec)} en ${wettest.year}. Con esa variación, la serie no muestra una caída clara de la lluvia a largo plazo. Los días de lluvia al año apenas se han movido, unos ${n(r.rain1)} en la última década.</p>
      <p>Lo que sí ha cambiado es la temperatura. Con más calor, el suelo y los embalses pierden más agua por evaporación, y la misma lluvia rinde menos. Una sequía de las de siempre hace hoy más daño.</p>

      <h2>El «buen clima» también se mueve</h2>
      <p>Barcelona presume de clima suave. Pero en Fabra, a 408 metros de altura y a las afueras, los días de 30&nbsp;°C han pasado de ${n(b.t30)} al año entre ${b.firstYear} y ${b.lastYear} a ${n(r.t30)} en la última década. Las noches tropicales, de ${n(b.tropical)} a ${n(r.tropical)}, y en el centro de la ciudad, más cerca del mar y del asfalto, son todavía más. Es la «xafogor», el bochorno pegajoso del verano barcelonés.</p>
      <p>El récord de calor de la serie es muy reciente: ${deg(s.records.tmax.value)} el ${date(s.records.tmax.date)} (dato aún provisional). Las heladas, mientras tanto, han pasado de ${n(b.frost)} al año a ${n(r.frost, 1)}.</p>
      ${verdict(`la sequía de 2021-2024 fue excepcional, pero los datos no muestran que en Barcelona llueva cada vez menos. Lo que sí es nuevo es el calor: mucho más frecuente, de día y sobre todo de noche.`)}

      <h2>Temperaturas, lluvia y récords de Barcelona, mes a mes</h2>
      ${monthlyTable(s, "Barcelona (Fabra)")}
      ${METHOD(s, `En la lluvia faltan algunos años antiguos, así que la comparación de lluvia usa la media de ${NORMAL[0]}-${NORMAL[1]}.`)}
      ${closing("barcelona-fabra", "Barcelona", "Barcelona Fabra")}
      ${moreTopics("barcelona-sequia-lluvia")}`,
  };
}

// ---------- Bilbao ----------

function rainCompareTable() {
  const rows = [
    ["bilbao-aeropuerto", "Bilbao", "/bilbao-sirimiri-cuanto-llueve"],
    ["a-coruna", "A Coruña", "/a-coruna-llueve-mucho"],
    ["barcelona-fabra", "Barcelona", "/barcelona-sequia-lluvia"],
    ["sevilla-aeropuerto", "Sevilla", "/sevilla-dias-de-40-grados"],
    ["valencia", "Valencia", "/valencia-noches-tropicales"],
    ["madrid-retiro", "Madrid", "/madrid-nueve-meses-de-invierno-tres-de-infierno"],
  ]
    .map(([slug, name, href]) => {
      const nm = cities[slug].normal;
      return `<tr><th scope="row"><a href="${href}">${name}</a></th><td class="num">${mm(nm.prec)}</td><td class="num">${n(nm.rain1)}</td><td class="num">${n(nm.rainAny)}</td></tr>`;
    })
    .join("");
  return `<div class="table-wrap">
        <table class="capitals">
          <caption>Lluvia media al año, ${NORMAL[0]}-${NORMAL[1]}</caption>
          <thead><tr><th scope="col">Ciudad</th><th scope="col" class="num">Lluvia</th><th scope="col" class="num">Días de ≥1&nbsp;mm</th><th scope="col" class="num">Días con algo de lluvia</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
}

function bilbao() {
  const s = cities["bilbao-aeropuerto"];
  const { base: b, recent: r, normal: nm } = s;
  const co = cities["a-coruna"].normal;
  const wettestMonth = s.months.reduce((a, m) => (m.prec > a.prec ? m : a));
  const driestMonth = s.months.reduce((a, m) => (m.prec < a.prec ? m : a));
  const hot = s.months
    .filter((m) => m.recordMax.value >= 42)
    .map((m) => m.recordMax)
    .sort((a, b2) => b2.value - a.value)
    .map((d) => `${deg(d.value)} el ${date(d.date)}`);
  return {
    slug: "bilbao-sirimiri-cuanto-llueve",
    station: "bilbao-aeropuerto",
    short: "Bilbao: ¿cuánto llueve con el sirimiri?",
    title: "¿Cuánto llueve en Bilbao? El sirimiri, con datos",
    seoTitle: "¿Cuánto llueve en Bilbao? Días de lluvia y sirimiri, con datos",
    description: `En Bilbao llueve algo ${n(nm.rainAny)} días al año, casi uno de cada dos, y cae más agua que en A Coruña. Sirimiri, viento sur y los 44 °C de 2023, con datos de AEMET.`,
    published: PUBLISHED,
    modified: PUBLISHED,
    body: `
      <p class="lead">En Bilbao, dicen, no llueve: cae sirimiri. Esa lluvia tan fina que parece que no moja… hasta que llegas a casa calado. La ciudad tiene fama de ser de las más lluviosas de España, y la eterna discusión con Galicia sobre quién se lleva el premio viene de lejos. Lo resolvemos con datos de la estación del aeropuerto de Loiu, desde 1947.</p>
      ${keyFacts([
        [n(nm.rainAny), "días al año con algo de lluvia: casi uno de cada dos"],
        [n(nm.rainAny - nm.rain1), "de ellos, con menos de 1&nbsp;mm: sirimiri o chubascos breves"],
        [mm(nm.prec), `de lluvia al año (${NORMAL[0]}-${NORMAL[1]})`],
        [deg(s.records.tmax.value), `récord de calor, el ${date(s.records.tmax.date)}`],
      ])}

      <h2>Casi un día de cada dos</h2>
      <p>Entre ${NORMAL[0]} y ${NORMAL[1]}, en Loiu cayó algo de lluvia ${n(nm.rainAny)} días al año: el ${n((nm.rainAny / 365) * 100)}&nbsp;% de los días. En ${n(nm.rain1)} de ellos se llegó al menos a 1&nbsp;mm. Los otros ${n(nm.rainAny - nm.rain1)} son días de sirimiri o de chubasco breve, de los que apenas llenan el pluviómetro pero obligan a llevar paraguas.</p>
      <p>La lluvia se reparte por todo el año, aunque no por igual. ${MONTHS_TITLE[wettestMonth.month - 1]} es el mes más lluvioso, con ${mm(wettestMonth.prec)} de media, y ${MONTHS[driestMonth.month - 1]} el más seco, con ${mm(driestMonth.prec)}. Ni siquiera el verano es seco del todo.</p>
      ${barChart({ title: `Lluvia media de cada mes en Bilbao, ${NORMAL[0]}-${NORMAL[1]} (mm)`, items: s.months.map((m) => ({ label: MONTHS_TITLE[m.month - 1].slice(0, 3), value: m.prec })), tone: "rain" })}

      <h2>¿Llueve más que en A Coruña? Sí, aunque los mismos días</h2>
      <p>Aquí está la sorpresa. Bilbao recoge más lluvia que A Coruña, ${mm(nm.prec)} frente a ${mm(co.prec)} al año, pero las dos ciudades tienen casi los mismos días de lluvia: ${n(nm.rain1)} en Bilbao y ${n(co.rain1)} en A Coruña. La diferencia es que en Bilbao, cuando llueve, cae algo más. Eso sí, ninguna de las dos es la más lluviosa de España: en Santiago de Compostela o en las Rías Baixas llueve bastante más.</p>
      ${rainCompareTable()}
      <p>¿Ha cambiado? Poco. Entre ${b.firstYear} y ${b.lastYear} la media fue de ${mm(b.prec)} y en la última década, de ${mm(r.prec)}. Los años más lluviosos de la serie son de todas las épocas.</p>

      <h2>Y de vez en cuando, 44 grados</h2>
      <p>La otra cara de Bilbao es el viento sur. Cuando sopla del interior y baja hacia el mar, se calienta y se seca, y la ciudad pasa en horas de un día gris a un horno. Los días más calurosos de la serie llegaron así: ${hot.join("; ")}.</p>
      <p>Esos días son cada vez menos raros. Los de 35&nbsp;°C o más han pasado de ${n(b.t35)} al año entre ${b.firstYear} y ${b.lastYear} a ${n(r.t35)} en la última década, y las heladas, de ${n(b.frost)} a ${n(r.frost)}.</p>
      ${verdict(`la fama es merecida. En Bilbao llueve casi un día de cada dos y cae más agua que en A Coruña. Lo inesperado es lo otro: con viento sur, Bilbao ha llegado a ${deg(s.records.tmax.value)}, y esos golpes de calor son cada vez más frecuentes.`)}

      <h2>Temperaturas, lluvia y récords de Bilbao, mes a mes</h2>
      ${monthlyTable(s, "Bilbao (aeropuerto)")}
      ${METHOD(s, "Días con algo de lluvia son los que registran al menos 0,1&nbsp;mm.")}
      ${closing("bilbao-aeropuerto", "Bilbao", "Bilbao Aeropuerto")}
      ${moreTopics("bilbao-sirimiri-cuanto-llueve")}`,
  };
}

// ---------- A Coruña ----------

function coruna() {
  const s = cities["a-coruna"];
  const { base: b, recent: r, normal: nm } = s;
  const bi = cities["bilbao-aeropuerto"].normal;
  const lastFrost = lastFrostYear(s);
  const rank2025 = s.wettestYears.findIndex((y) => y.year === 2025) + 1;
  const july = s.months[6];
  const rainDecades = s.decades.filter((d) => d.rainYears >= 5).map((d) => d.rain1);
  const lo = Math.floor(Math.min(...rainDecades) / 5) * 5;
  const hi = Math.ceil(Math.max(...rainDecades) / 5) * 5;
  const nov = s.months[10];
  return {
    slug: "a-coruna-llueve-mucho",
    station: "a-coruna",
    short: "A Coruña: ¿llueve tanto como dicen?",
    title: "¿Llueve tanto en A Coruña como dicen? Lo comprobamos con datos",
    seoTitle: "¿Llueve tanto en A Coruña? Días de lluvia, con datos",
    description: `En A Coruña llueve ${n(nm.rain1)} días al año, más de uno de cada tres, y no ha cambiado en noventa años. Lo que sí ha cambiado es el frío. Datos de AEMET desde 1930.`,
    published: PUBLISHED,
    modified: PUBLISHED,
    body: `
      <p class="lead">«En Coruña llueve siempre». Lo dicen los de fuera, y los de dentro lo asumen con sorna: el orballo, el viento que da la vuelta al paraguas, las cuatro estaciones en un mismo día. ¿Es para tanto? ¿Sigue siendo así, o el cambio climático también ha llegado a la lluvia gallega? Lo comprobamos con la estación de AEMET en la ciudad, que tiene datos diarios desde 1930.</p>
      ${keyFacts([
        [n(nm.rain1), "días de lluvia al año (≥1&nbsp;mm): más de uno de cada tres"],
        [mm(nm.prec), `de lluvia al año (${NORMAL[0]}-${NORMAL[1]})`],
        [n(r.t30, 0), "días al año de 30&nbsp;°C o más: el verano sigue siendo suave"],
        [String(lastFrost), "último año con una helada"],
      ])}

      <h2>Sí: llueve más de un día de cada tres</h2>
      <p>Entre ${NORMAL[0]} y ${NORMAL[1]}, A Coruña tuvo de media ${n(nm.rain1)} días al año con al menos 1&nbsp;mm de lluvia, y ${n(nm.rainAny)} con alguna gota, casi la mitad. Para comparar, Madrid tiene unos ${n(cities["madrid-retiro"].normal.rain1)} días de lluvia y Sevilla, ${n(cities["sevilla-aeropuerto"].normal.rain1)}. El tópico es verdad.</p>
      <p>Donde más se nota es en otoño e invierno: noviembre deja ${mm(nov.prec)} de media. Julio, en cambio, solo ${mm(july.prec)}. El verano coruñés es bastante más seco de lo que su fama sugiere.</p>

      <h2>Y no ha cambiado en noventa años</h2>
      <p>Si algo sorprende de la serie es lo estable que es. Década tras década, A Coruña ha tenido entre ${lo} y ${hi} días de lluvia al año. Entre ${b.firstYear} y ${b.lastYear} llovía ${n(b.rain1)} días al año y en la última década, ${n(r.rain1)}. Tampoco ha bajado la cantidad: ${rank2025 ? `2025, con ${mm(yearOf(s, 2025).prec)}, es el ${rank2025}.º año más lluvioso de la serie.` : `la media reciente es de ${mm(r.prec)}.`}</p>
      ${barChart({ title: "Días de lluvia (≥1 mm) al año en A Coruña, media por década", items: decadeItems(s, "rain1"), tone: "rain", note: "Cuentan las décadas con al menos cinco años completos de lluvia." })}

      <h2>¿Es la ciudad más lluviosa? No</h2>
      <p>Aquí el tópico patina. Bilbao recoge más agua que A Coruña, ${mm(bi.prec)} frente a ${mm(nm.prec)} al año, con prácticamente los mismos días de lluvia. Lo contamos en <a href="/bilbao-sirimiri-cuanto-llueve">el artículo sobre el sirimiri</a>.</p>

      <h2>Lo que sí ha cambiado: el frío</h2>
      <p>A Coruña siempre ha tenido un clima muy suave, de inviernos templados y veranos frescos. Sigue siendo así, pero con menos frío. La temperatura media ha subido de ${deg(b.tmed)} entre ${b.firstYear} y ${b.lastYear} a ${deg(r.tmed)} en la última década. Los días fríos, con una media por debajo de 8&nbsp;°C, han pasado de ${n(b.cold)} al año a ${n(r.cold)}. La última helada en la estación fue el ${date(s.lastFrost)}.</p>
      <p>El calor fuerte, en cambio, sigue siendo raro. Hay unos ${n(r.t30)} días al año de 30&nbsp;°C o más, y el récord de la estación, ${deg(s.records.tmax.value)}, es del ${date(s.records.tmax.date)}: lleva más de sesenta años sin batirse.</p>
      ${verdict(`en A Coruña llueve mucho, más de un día de cada tres, y igual que hace noventa años. Lo que ha cambiado es que hace menos frío. Y no, no es la ciudad más lluviosa: Bilbao le gana.`)}

      <h2>Temperaturas, lluvia y récords de A Coruña, mes a mes</h2>
      ${monthlyTable(s, "A Coruña")}
      ${METHOD(s)}
      ${closing("a-coruna", "A Coruña", "A Coruña")}
      ${moreTopics("a-coruna-llueve-mucho")}`,
  };
}

// El orden de TOPICS es el de los enlaces «Más tópicos» y la portada de /temperaturas.
const PLACES = { "madrid-retiro": "Madrid", "sevilla-aeropuerto": "Sevilla", valencia: "Valencia", "barcelona-fabra": "Barcelona", "bilbao-aeropuerto": "Bilbao", "a-coruna": "A Coruña" };
// Cada artículo usa la imagen social de su capital (public/img/og/<slug>.jpg) y lleva la ruta de migas por /temperaturas.
const TOPICS = [madrid(), sevilla(), valencia(), barcelona(), bilbao(), coruna()].map((t) => ({
  ...t,
  place: PLACES[t.station],
  image: `/img/og/${t.station}.jpg`,
  imageAlt: `Gráfico de secalienta.com para ${PLACES[t.station]}: temperaturas máximas, mínimas y lluvia, año a año.`,
  parent: { name: "Temperaturas por capital", path: "/temperaturas" },
}));
const byStation = new Map(TOPICS.map((t) => [t.station, t]));

module.exports = { CITY_ARTICLES: TOPICS, cityArticleForStation: (slug) => byStation.get(slug) || null };

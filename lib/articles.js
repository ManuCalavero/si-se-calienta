// Artículos de contenido (páginas de texto para buscadores). Se pintan con la misma plantilla que /temperaturas (lib/seo-pages.js).
// Cada cifra lleva su fuente en la lista del final: al actualizar un dato, cambia también «modified».

const ext = (href, text) => `<a href="${href}" target="_blank" rel="noopener noreferrer">${text}</a>`;

const SOURCES = {
  copernicus: "https://climate.copernicus.eu/copernicus-2025-was-third-hottest-year-record",
  forster: "https://essd.copernicus.org/articles/17/2641/2025/",
  irena: "https://www.irena.org/News/pressreleases/2025/Jul/91-Percent-of-New-Renewable-Projects-Now-Cheaper-Than-Fossil-Fuels-Alternatives",
  unep: "https://www.unep.org/en/publications/report/emissions-gap-report-2025",
  owidDisasters: "https://ourworldindata.org/the-world-has-become-more-resilient-to-disasters-but-investment-is-needed-to-save-more-lives",
  owidBangladesh: "https://ourworldindata.org/data-insights/bangladesh-has-become-much-more-resilient-to-cyclones-saving-many-lives",
  zhao: "https://doi.org/10.1016/S2542-5196(21)00081-4",
  zhu: "https://doi.org/10.1038/nclimate3004",
  myers: "https://doi.org/10.1038/nature13179",
  ree: "https://www.sistemaelectrico-ree.es/",
};

const esperanza = {
  slug: "cambio-climatico-hay-esperanza",
  title: "¿Hay esperanza con el cambio climático? Lo que dicen los datos",
  description:
    "Sí, con matices. La energía solar y la eólica ya son las más baratas, las previsiones de calentamiento han bajado y los desastres matan mucho menos que antes. Lo que ha mejorado y lo que no, con fuentes.",
  published: "2026-11-25",
  modified: "2026-11-25",
  body: `
      <p class="lead">Sí, hay razones para la esperanza. No es un «aquí no pasa nada», pero tampoco el apocalipsis inevitable que a veces se pinta. Los datos de los últimos diez años son mejores de lo que casi nadie esperaba, aunque el problema sigue siendo serio.</p>

      <ul class="key-facts" aria-label="Datos clave">
        <li><strong>41&nbsp;%</strong><span>más barata la solar que la alternativa fósil más barata (2024)</span></li>
        <li><strong>2,8&nbsp;°C</strong><span>de calentamiento previsto con las políticas actuales; hace diez años se hablaba de unos 4&nbsp;°C</span></li>
        <li><strong>×100</strong><span>menos muertes por ciclones en Bangladés que en los años 70</span></li>
        <li><strong>1,5&nbsp;°C</strong><span>por encima del nivel preindustrial, de media, entre 2023 y 2025</span></li>
      </ul>

      <h2>Dónde estamos</h2>
      <p>El calentamiento es real y lo causan sobre todo las emisiones humanas de gases de efecto invernadero. La media de 2023, 2024 y 2025 superó los 1,5&nbsp;°C por encima de la época preindustrial (1850-1900): es la primera vez que ocurre en tres años seguidos. 2024 es el año más cálido registrado, con 1,6&nbsp;°C, y 2025 quedó tercero, según ${ext(SOURCES.copernicus, "Copernicus")}. Si se descuenta la variabilidad natural de cada año, el calentamiento causado por el ser humano ronda los 1,4&nbsp;°C y crece unos 0,27&nbsp;°C por década (${ext(SOURCES.forster, "Forster y otros, 2025")}).</p>
      <p>Sus efectos son claros: olas de calor más frecuentes e intensas, subida del nivel del mar, cambios en las lluvias y presión sobre los ecosistemas. Pero la trayectoria, y la capacidad de respuesta, son bastante mejores de lo que proyectaban muchos escenarios de hace 10 o 15 años.</p>

      <h2>Lo que ha mejorado de verdad</h2>

      <h3>La energía limpia ya es la más barata</h3>
      <p>El coste de la solar y la eólica se ha desplomado. Según la ${ext(SOURCES.irena, "Agencia Internacional de Energías Renovables (IRENA)")}, en 2024 la solar fotovoltaica fue de media un 41&nbsp;% más barata que la alternativa fósil más barata, y la eólica terrestre un 53&nbsp;% más barata. El 91&nbsp;% de las nuevas centrales renovables produce electricidad a menor coste que cualquier central fósil nueva.</p>
      <p>Por eso se instalan récords de potencia año tras año, con China a la cabeza, y las renovables cubren ya casi todo el aumento de la demanda eléctrica mundial. Las baterías y los coches eléctricos siguen el mismo camino. En España, más de la mitad de la electricidad que se genera ya es renovable (${ext(SOURCES.ree, "Red Eléctrica")}).</p>

      <h3>El futuro previsto es menos malo</h3>
      <p>Hace una década, el escenario «sin hacer nada» apuntaba a unos 4&nbsp;°C de calentamiento a final de siglo. El último informe del ${ext(SOURCES.unep, "Programa de la ONU para el Medio Ambiente")} estima 2,8&nbsp;°C con las políticas actuales y entre 2,3 y 2,5&nbsp;°C si los países cumplen lo que han prometido. Sigue siendo demasiado, pero está lejos de los peores escenarios.</p>

      <h3>Los desastres matan mucho menos</h3>
      <p>Las muertes por tormentas, inundaciones y otros desastres naturales han caído de forma drástica en el último siglo, pese a que hay muchos más habitantes (${ext(SOURCES.owidDisasters, "Our World in Data")}). No es que haya menos desastres: es que las predicciones, los sistemas de alerta, las evacuaciones, las infraestructuras y el desarrollo económico salvan muchas más vidas.</p>
      <p>Bangladés es el ejemplo más claro. El ciclón de 1970 mató a más de 300.000 personas y el de 1991, a unas 138.000. El ciclón Sidr, en 2007, a unas 4.200, y los grandes ciclones de los últimos años se han cobrado decenas de vidas, no miles (${ext(SOURCES.owidBangladesh, "Our World in Data")}).</p>

      <h3>El frío mata más que el calor, pero el calor va a más</h3>
      <p>En el estudio más amplio hecho hasta ahora, publicado en ${ext(SOURCES.zhao, "The Lancet Planetary Health")} con datos de 43 países, el frío causaba unas nueve veces más muertes que el calor en el mundo. Un clima más cálido reduce las muertes por frío y aumenta las de calor, así que el balance no es automáticamente catastrófico.</p>
      <p>Eso sí, depende mucho del lugar. En un país caluroso como España el calor ya causa miles de muertes cada verano, y la adaptación (planes de alerta, sombra, refugios climáticos, aire acondicionado, atención a los mayores) es la que marca la diferencia.</p>

      <h3>Más CO₂, más verde, con letra pequeña</h3>
      <p>El CO₂ actúa como fertilizante para las plantas. Desde los años 80, entre una cuarta parte y la mitad de la superficie con vegetación del planeta se ha vuelto más verde, y ese efecto explica buena parte del cambio (${ext(SOURCES.zhu, "Zhu y otros, 2016")}). También ha ayudado a subir el rendimiento de algunos cultivos. Pero no compensa la sequía ni el calor extremo, se va agotando a medida que sube el CO₂ y reduce el contenido de proteínas, hierro y zinc de cereales como el trigo o el arroz (${ext(SOURCES.myers, "Myers y otros, 2014")}).</p>

      <h2>Lo que sigue preocupando</h2>
      <ul>
        <li><strong>Las emisiones siguen subiendo.</strong> Crecen mucho más despacio que antes del Acuerdo de París, pero en 2024 aumentaron un 2,3&nbsp;% y marcaron un nuevo récord (${ext(SOURCES.unep, "PNUMA")}).</li>
        <li><strong>Limitar el calentamiento a 1,5&nbsp;°C ya parece casi imposible.</strong> Lo previsible es superarlo durante la próxima década. Quedarse cerca de 2&nbsp;°C es realista si se mantiene el ritmo de despliegue de energía limpia.</li>
        <li><strong>Hay impactos que no se frenan rápido</strong>, como la pérdida de hielo, la subida del mar o la acidificación de los océanos, e incertidumbre sobre los puntos de no retorno.</li>
        <li><strong>Los daños no se reparten por igual.</strong> Las regiones pobres y las costeras lo pasan peor, y en España el calor extremo es el riesgo más directo para la salud.</li>
      </ul>

      <h2>Por qué la esperanza es realista</h2>
      <p>Cuando hay incentivos y tecnología, las sociedades se adaptan y resuelven problemas. El desarrollo económico reduce la vulnerabilidad: mejores viviendas, sistemas de alerta, agricultura más productiva. Y la tecnología limpia, desde la solar hasta las baterías, ha avanzado más rápido de lo que casi nadie previó.</p>
      <p>No hace falta «salvar el planeta» de forma épica. Hace falta seguir abaratando la energía limpia, desplegarla a gran escala y seguir adaptándose. Cada décima de grado que se evita importa, y también importa que la gente sea más próspera y resistente.</p>
      <p><strong>En resumen:</strong> el calentamiento es un problema serio que hay que gestionar con seriedad, con tecnología, adaptación y reducción de emisiones, sin pánico y sin negarlo. Hay motivos sólidos para el optimismo, y salen de los datos.</p>

      <aside class="cta">
        <h2>¿Y en tu ciudad?</h2>
        <p>Compara la temperatura de cualquier día del año con ese mismo día en el pasado, con datos de AEMET desde hace décadas. Por ejemplo, en <a href="/estacion/madrid-retiro">Madrid</a>, <a href="/estacion/sevilla-aeropuerto">Sevilla</a> o <a href="/estacion/barcelona-fabra">Barcelona</a>.</p>
        <p class="cta-links"><a class="button" href="/">Abrir el mapa</a> <a href="/temperaturas">Ver todas las capitales</a></p>
      </aside>

      <section class="sources" aria-labelledby="fuentes">
        <h2 id="fuentes">Fuentes</h2>
        <ol>
          <li>Copernicus Climate Change Service. ${ext(SOURCES.copernicus, "2025 fue el tercer año más cálido registrado")} (enero de 2026).</li>
          <li>Forster, P. M. y otros. ${ext(SOURCES.forster, "Indicators of Global Climate Change 2024")}. <em>Earth System Science Data</em>, 2025.</li>
          <li>IRENA. ${ext(SOURCES.irena, "Renewable Power Generation Costs in 2024")} (julio de 2025).</li>
          <li>PNUMA. ${ext(SOURCES.unep, "Emissions Gap Report 2025")} (noviembre de 2025).</li>
          <li>Our World in Data. ${ext(SOURCES.owidDisasters, "El mundo es más resistente a los desastres")} y ${ext(SOURCES.owidBangladesh, "Bangladés y los ciclones")}.</li>
          <li>Zhao, Q. y otros. ${ext(SOURCES.zhao, "Global, regional, and national burden of mortality associated with non-optimal ambient temperatures")}. <em>The Lancet Planetary Health</em>, 2021.</li>
          <li>Zhu, Z. y otros. ${ext(SOURCES.zhu, "Greening of the Earth and its drivers")}. <em>Nature Climate Change</em>, 2016.</li>
          <li>Myers, S. S. y otros. ${ext(SOURCES.myers, "Increasing CO₂ threatens human nutrition")}. <em>Nature</em>, 2014.</li>
          <li>Red Eléctrica. ${ext(SOURCES.ree, "Datos del sistema eléctrico español")}.</li>
        </ol>
      </section>`,
};

const ARTICLES = [esperanza];
const bySlug = new Map(ARTICLES.map((article) => [article.slug, article]));

module.exports = { ARTICLES, getArticle: (slug) => bySlug.get(slug) || null };

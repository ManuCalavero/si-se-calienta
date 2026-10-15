# Si Se Calienta

App web para ver cómo ha cambiado un mismo día del año (mes + día) en una estación de AEMET, desde su primer registro (como muy pronto 1920) hasta hoy.

## Qué hace

- Mapa de estaciones de AEMET a pantalla completa, con buscador (⌘K o `/`) y opción "Usar mi ubicación".
- Para la estación y el día elegidos muestra:
  - Una frase resumen ("es X °C más cálido en … que en …").
  - Indicadores: cambio entre los primeros y los últimos años, tendencia por década, temperatura media, récord de calor del día y lluvia media.
  - Franjas climáticas (una barra por año, coloreada según la anomalía).
  - Gráfica anotada de temperatura media, con máximas y mínimas opcionales, y gráfica de lluvia.
  - Ficha de la estación y calidad de los datos.
  - Modo ampliado para analistas: estadísticas de la regresión, tabla por año y descarga en CSV.
- Los valores de cada año son la media de una ventana de ±7 días alrededor de la fecha (mínimo 10 días con dato), para reducir el ruido de un único día. La tabla incluye también los valores del día exacto.
- La URL guarda la estación y el día (`?estacion=3195&dia=10-13`), así que se puede compartir.

## Requisitos

- Node.js 18+ (para `fetch` nativo)

## Puesta en marcha

1. Instalar dependencias:

```bash
npm install
```

2. Configurar variables de entorno:

```bash
cp .env.example .env
```

3. Rellenar `AEMET_API_KEY` en `.env`.

4. Ejecutar en desarrollo:

```bash
npm run dev
```

5. Abrir en el navegador: http://localhost:3000

## Endpoints

- `GET /api/stations`: inventario de estaciones.
- `GET /api/stations/cached`: estaciones ya descargadas y si su histórico está completo.
- `GET /api/evolution/jobs/enqueue?station=XXXX&month=MM&day=DD`: devuelve el resultado al instante si está en caché; si no, encola la descarga y devuelve un `jobId`.
- `GET /api/evolution/jobs/:jobId`: estado, progreso, tiempo estimado y resultado parcial del trabajo.
- `GET /api/background`: búsquedas de histórico en segundo plano en curso.
- `GET /api/evolution?station=XXXX&month=MM&day=DD`: igual que el anterior pero esperando a que termine (modo síncrono). Con `&refresh=1&refreshSecret=TU_SECRETO` fuerza la recarga desde AEMET.

## Seguridad (variables opcionales)

- `FETCH_TIMEOUT_MS`: timeout para llamadas HTTP salientes a AEMET (por defecto `20000`).
- `REFRESH_SECRET`: secreto requerido para permitir `refresh=1`.

## Descarga desde AEMET (variables opcionales)

- `AEMET_REQUEST_DELAY_MS`: pausa entre peticiones a AEMET para no agotar la cuota (por defecto `1000`).
- `EVOLUTION_JOB_RETENTION_MINUTES`: minutos que se conserva el estado de trabajos completados/fallidos.

## Rate limits (variables opcionales)

- `EVOLUTION_SYNC_LIMIT_PER_MIN`: límite por minuto para `GET /api/evolution`.
- `EVOLUTION_ENQUEUE_LIMIT_PER_MIN`: límite por minuto para `GET /api/evolution/jobs/enqueue`.
- `EVOLUTION_STATUS_LIMIT_PER_MIN`: límite por minuto para el estado de trabajos y `/api/background`.

## Caché local

- La caché se guarda en `.cache/` por defecto. Se puede cambiar con `CACHE_DIR`. **En producción debe apuntar a un disco/volumen persistente**: si el disco del servicio es efímero (Render, Railway, Heroku, Fly sin volumen…), la caché se borra en cada despliegue o reinicio y las estaciones dejan de aparecer en verde.
- AEMET solo admite rangos de 6 meses por petición, así que los datos se guardan en bloques de medio año por estación: `.cache/stations/<estacion>/<año>-H1.json` (enero-junio) y `-H2.json` (julio-diciembre).
- La primera consulta de una estación descarga desde 1976 los bloques que necesita ese día (unas 50 peticiones, 2-3 minutos), mostrando progreso, tiempo estimado y resultados parciales.
- Después, en segundo plano, se recorre la estación hacia atrás hasta encontrar su primer registro: se para tras 5 años seguidos sin datos, o en 1920. El resultado se guarda en `.cache/stations/<estacion>/meta.json` y, a partir de ahí, cualquier fecha de esa estación responde al instante con el histórico completo.
- Los bloques de más de 30 días de antigüedad son definitivos y no caducan. Los recientes se refrescan cada `RECENT_DATA_TTL_HOURS` horas (por defecto `12`).
- Si un bloque falla, la siguiente consulta descarga únicamente lo que falte.
- Una estación con datos desde 1920 ocupa unos 2,5 MB.

## Notas

- La tendencia se marca como clara cuando la pendiente es al menos el doble de su error estándar; si no, la app lo dice.
- Mapa base: Esri World Light Gray (sin clave). Datos: AEMET OpenData.

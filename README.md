# Si Se Calienta

App web para comparar la evolucion de un mismo dia (mes + dia) entre 1976 y 2026 usando AEMET OpenData.

## Que hace

- Permite seleccionar una estacion de AEMET.
- Permite elegir un dia (se usa solo mes y dia).
- Muestra la evolucion anual (1976-2026) de:
  - Temperatura maxima
  - Temperatura minima
  - Temperatura media
  - Precipitacion
- Incluye grafica y tabla por ano.

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

5. Abrir en navegador:

- http://localhost:3000

## Endpoints

- `GET /api/stations` devuelve inventario de estaciones.
- `GET /api/evolution?station=XXXX&month=MM&day=DD` devuelve la serie 1976-2026 (modo sincronico).
- `GET /api/evolution/jobs/enqueue?station=XXXX&month=MM&day=DD` encola la consulta y devuelve `jobId`.
- `GET /api/evolution/jobs/:jobId` devuelve estado/progreso del trabajo encolado.
- `GET /api/evolution?station=XXXX&month=MM&day=DD&refresh=1&refreshSecret=TU_SECRETO` fuerza recarga desde AEMET (sin usar cache).

## Seguridad (variables opcionales)

- `FETCH_TIMEOUT_MS`: timeout para llamadas HTTP salientes a AEMET (por defecto `12000`).
- `REFRESH_SECRET`: secreto requerido para permitir `refresh=1` en `/api/evolution`.

## Cola de consultas (variables opcionales)

- `EVOLUTION_QUEUE_CONCURRENCY`: numero de trabajos simultaneos de evolucion (recomendado `1`).
- `EVOLUTION_PER_YEAR_DELAY_MS`: espera entre anos para suavizar cuota de AEMET.
- `EVOLUTION_RETRY_ROUND_COOLDOWN_MS`: pausa antes de reintentar anos fallidos.
- `EVOLUTION_JOB_RETENTION_MINUTES`: minutos que se conserva el estado de trabajos completados/fallidos.

## Rate limits de evolucion (variables opcionales)

- `EVOLUTION_SYNC_LIMIT_PER_MIN`: limite por minuto para `GET /api/evolution` (consulta pesada sincronica).
- `EVOLUTION_ENQUEUE_LIMIT_PER_MIN`: limite por minuto para `GET /api/evolution/jobs/enqueue`.
- `EVOLUTION_STATUS_LIMIT_PER_MIN`: limite por minuto para `GET /api/evolution/jobs/:jobId` (polling de estado).

## Cache local

- Las respuestas de evolucion se guardan en `.cache/evolution`.
- Clave de cache: estacion + mes + dia.
- TTL por defecto: 720 horas (30 dias).
- Puedes cambiarlo con la variable de entorno `CACHE_TTL_HOURS`.
- Beneficio: la primera consulta puede tardar, pero las siguientes del mismo dia/estacion son casi instantaneas y consumen menos cuota de AEMET.

## Notas

- Puede haber anos sin datos para una estacion concreta; en ese caso se muestran valores vacios.
- La consulta usa datos diarios climatologicos de AEMET.

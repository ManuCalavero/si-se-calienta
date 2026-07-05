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
- `GET /api/evolution?station=XXXX&month=MM&day=DD` devuelve la serie 1976-2026.
- `GET /api/evolution?station=XXXX&month=MM&day=DD&refresh=1` fuerza recarga desde AEMET (sin usar cache).

## Cache local

- Las respuestas de evolucion se guardan en `.cache/evolution`.
- Clave de cache: estacion + mes + dia.
- TTL por defecto: 720 horas (30 dias).
- Puedes cambiarlo con la variable de entorno `CACHE_TTL_HOURS`.
- Beneficio: la primera consulta puede tardar, pero las siguientes del mismo dia/estacion son casi instantaneas y consumen menos cuota de AEMET.

## Notas

- Puede haber anos sin datos para una estacion concreta; en ese caso se muestran valores vacios.
- La consulta usa datos diarios climatologicos de AEMET.

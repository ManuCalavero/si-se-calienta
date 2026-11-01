const SPAIN_CENTER = [40.2, -3.7];
const ESRI_BASE = "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas";
const TILE_ATTRIBUTION =
  'Mapa &copy; <a href="https://www.esri.com">Esri</a>, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

// Mismos tonos que --station y --station-idle de styles.css en cada tema.
const STATION_COLORS = {
  light: { active: "#5a58e3", idle: "#9a9a9a" },
  dark: { active: "#8583ff", idle: "#cee1f8" },
};
const stationColors = () => STATION_COLORS[document.documentElement.dataset.theme === "dark" ? "dark" : "light"];

let map;
let renderer;
let onSelectHandler = () => {};
let selectedMarker = null;
const markers = new Map();

function reducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

function radiusForZoom(zoom) {
  if (zoom <= 5) return 2;
  if (zoom <= 6) return 2.6;
  if (zoom <= 8) return 3.6;
  return 4.6;
}

function markerStyle(isCached, zoom) {
  const colors = stationColors();
  return {
    renderer,
    radius: radiusForZoom(zoom) + (isCached ? 0.5 : 0),
    // Sin borde: el canvas tiene tolerancia de clic (tolerance) y los puntos pequeños siguen siendo fáciles de tocar.
    stroke: false,
    fillColor: isCached ? colors.active : colors.idle,
    fillOpacity: isCached ? 1 : 0.7,
  };
}

const initialZoom = () => (window.innerWidth < 760 ? 5 : 6);

export function createMap(element, { onSelect, onExplore = () => {} }) {
  onSelectHandler = onSelect;
  map = L.map(element, {
    zoomControl: false,
    minZoom: 4,
    maxZoom: 13,
    zoomSnap: 0.5,
    worldCopyJump: false,
  }).setView(SPAIN_CENTER, initialZoom());

  map.attributionControl.setPrefix(false);

  map.createPane("labels");
  map.getPane("labels").style.zIndex = 350;
  map.getPane("labels").style.pointerEvents = "none";

  L.tileLayer(`${ESRI_BASE}/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}`, {
    maxNativeZoom: 16,
    maxZoom: 19,
    attribution: TILE_ATTRIBUTION,
  }).addTo(map);

  L.tileLayer(`${ESRI_BASE}/World_Light_Gray_Reference/MapServer/tile/{z}/{y}/{x}`, {
    maxNativeZoom: 16,
    maxZoom: 19,
    pane: "labels",
  }).addTo(map);

  renderer = L.canvas({ padding: 0.5, tolerance: 6 });

  // Solo los gestos de la persona cuentan como explorar, no los vuelos que lanza la app.
  map.on("dragstart", () => onExplore());
  element.addEventListener("wheel", () => onExplore(), { passive: true });

  map.on("zoomend", () => {
    const zoom = map.getZoom();
    for (const { marker, isCached } of markers.values()) {
      marker.setRadius(markerStyle(isCached, zoom).radius);
    }
  });

  return map;
}

export function setStations(stations, cachedIds) {
  for (const { marker } of markers.values()) marker.remove();
  markers.clear();

  const zoom = map.getZoom();
  for (const station of stations) {
    if (!Number.isFinite(station.latitud) || !Number.isFinite(station.longitud)) continue;
    const isCached = cachedIds.has(station.idema);
    const marker = L.circleMarker([station.latitud, station.longitud], markerStyle(isCached, zoom))
      .bindTooltip(
        `<strong>${escapeHtml(station.nombreVisible)}</strong><span>${escapeHtml(station.provinciaVisible)} · ${escapeHtml(station.idema)}${
          Number.isFinite(station.altitud) ? ` · ${escapeHtml(station.altitud)} m` : ""
        }</span>${isCached ? '<em>Respuesta instantánea</em>' : ""}`,
        { direction: "top", offset: [0, -6], className: "station-tip", opacity: 1 }
      )
      .on("click", () => onSelectHandler(station.idema));
    marker.addTo(map);
    markers.set(station.idema, { marker, isCached });
  }
}

export function refreshMarkerTheme() {
  if (!map) return;
  const zoom = map.getZoom();
  for (const { marker, isCached } of markers.values()) marker.setStyle(markerStyle(isCached, zoom));
}

export function updateCached(cachedIds) {
  const zoom = map.getZoom();
  for (const [id, entry] of markers.entries()) {
    const isCached = cachedIds.has(id);
    if (entry.isCached === isCached) continue;
    entry.isCached = isCached;
    entry.marker.setStyle(markerStyle(isCached, zoom));
  }
}

function flyWithOffset(latlng, zoom, offset) {
  const target = map.unproject(map.project(latlng, zoom).add(offset), zoom);
  if (reducedMotion()) map.setView(target, zoom);
  else map.flyTo(target, zoom, { duration: 1.1, easeLinearity: 0.2 });
}

export function focusStation(station, offset = [0, 0]) {
  if (selectedMarker) selectedMarker.remove();
  if (!Number.isFinite(station.latitud) || !Number.isFinite(station.longitud)) return;

  const latlng = [station.latitud, station.longitud];
  selectedMarker = L.marker(latlng, {
    interactive: false,
    keyboard: false,
    icon: L.divIcon({ className: "station-selected", html: "<span></span>", iconSize: [36, 36] }),
  }).addTo(map);

  flyWithOffset(latlng, Math.max(map.getZoom(), 8), offset);
}

export function resetView() {
  if (!map) return;
  if (reducedMotion()) map.setView(SPAIN_CENTER, initialZoom());
  else map.flyTo(SPAIN_CENTER, initialZoom(), { duration: 1.1, easeLinearity: 0.2 });
}

export function clearSelection() {
  if (selectedMarker) selectedMarker.remove();
  selectedMarker = null;
}

export function invalidateSize() {
  if (map) map.invalidateSize();
}

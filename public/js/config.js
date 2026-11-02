// Ajustes editables sin tocar la lógica de la app.

// Usuario de Ko-fi: https://ko-fi.com/<usuario>
export const KOFI_USERNAME = "secalienta";

// Coste mensual estimado para mantener la web abierta con tráfico real (euros, octubre de 2026).
// Hoy funciona en planes gratuitos; estos son los planes necesarios si la web recibe visitas de prensa.
export const MONTHLY_COSTS = [
  { label: "Servidor web", euros: 19 },
  { label: "Base de datos", euros: 15 },
  { label: "Dominio", euros: 1 },
];

export const COFFEE_EUROS = 5;

// Lo que tendría que aportar de media cada visita para cubrir los costes sin poner dinero de mi bolsillo.
// Es la cifra del botón junto a «Compartir»; el módulo de donación explica por qué conviene aportar más.
export const VISIT_EUROS = 0.75;

// Estaciones con más historia para empezar con un toque. Solo se muestran las ya descargadas.
export const QUICK_PICKS = [
  { id: "3195", label: "Madrid" },
  { id: "0200E", label: "Barcelona" },
  { id: "8416", label: "València" },
  { id: "5783", label: "Sevilla" },
  { id: "1082", label: "Bilbao" },
  { id: "1387", label: "A Coruña" },
];

export const LINKS = {
  aemetOpenData: "https://opendata.aemet.es/",
  aemetClimate: "https://www.aemet.es/es/serviciosclimaticos/cambio_climat",
  copernicus: "https://climate.copernicus.eu/",
  ipcc: "https://www.ipcc.ch/languages-2/spanish/",
};

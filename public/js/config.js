// Ajustes editables sin tocar la lógica de la app.

// Usuario de Buy Me a Coffee: https://www.buymeacoffee.com/<usuario>
export const BMC_USERNAME = "sisecalienta";

// Coste mensual estimado para mantener la web abierta con tráfico real (euros, octubre de 2026).
// Hoy funciona en planes gratuitos; estos son los planes necesarios si la web recibe visitas de prensa.
export const MONTHLY_COSTS = [
  { label: "Servidor web", detail: "Vercel Pro", euros: 19 },
  { label: "Base de datos", detail: "MongoDB Atlas Flex", euros: 15 },
  { label: "Dominio", detail: ".es, prorrateado", euros: 1 },
];

export const COFFEE_EUROS = 5;

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

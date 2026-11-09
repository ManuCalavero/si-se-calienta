// Publica (o simula) el post diario de Bluesky desde tu ordenador, con las claves de .env.
// Uso:  node scripts/post-bluesky.js --dry-run              (solo muestra el texto de hoy)
//       node scripts/post-bluesky.js --force                (publica ya, aunque no sean las 8:00)
//       node scripts/post-bluesky.js --force --slug=sevilla-aeropuerto
//       node scripts/post-bluesky.js --dry-run --today --slug=madrid-retiro   (post «para hoy» con gráfico; guarda el PNG en /tmp si es dry-run)
require("dotenv").config({ quiet: true });
const { publishDaily } = require("../lib/bluesky");

const args = process.argv.slice(2);
const slugArg = args.find((arg) => arg.startsWith("--slug="));

publishDaily({
  dryRun: args.includes("--dry-run"),
  force: args.includes("--force"),
  slug: slugArg ? slugArg.slice("--slug=".length) : undefined,
  today: args.includes("--today"),
})
  .then((result) => {
    const outFile = (args.find((arg) => arg.startsWith("--png=")) || "").slice("--png=".length);
    if (result.png) {
      if (outFile) require("fs").writeFileSync(outFile, result.png);
      delete result.png;
    }
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => process.exit()); // la conexión a Atlas queda abierta; en el servidor no importa, en el script sí

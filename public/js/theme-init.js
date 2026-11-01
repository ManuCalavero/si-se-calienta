// Se carga en el <head>, antes de pintar, para que el tema guardado no parpadee. Por defecto, claro.
(function () {
  let theme = "light";
  try {
    if (localStorage.getItem("theme") === "dark") theme = "dark";
  } catch {}
  document.documentElement.dataset.theme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === "dark" ? "#0d101a" : "#c7c7c7";
})();

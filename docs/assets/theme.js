// Called in the head so the saved palette is applied before the page is painted.
function initTheme() {
  let theme = "dark";
  try {
    if (localStorage.getItem("tap-theme") === "light") theme = "light";
  } catch (_) { /* Storage can be unavailable for local files or private browsing. */ }
  document.documentElement.dataset.theme = theme;

  document.addEventListener("DOMContentLoaded", () => {
    const toggle = document.getElementById("theme-toggle");
    toggle.disabled = false;
    toggle.setAttribute("aria-pressed", String(theme === "light"));
    toggle.addEventListener("click", () => {
      theme = theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = theme;
      toggle.setAttribute("aria-pressed", String(theme === "light"));
      try { localStorage.setItem("tap-theme", theme); } catch (_) { /* Keep the in-page choice. */ }
    });
  });
}

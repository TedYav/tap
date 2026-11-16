// Called in the head so the preferred palette is applied before the page is painted.
function initTheme() {
  const preference = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : null;
  let saved;
  try { saved = localStorage.getItem("tap-theme"); } catch (_) { /* Use the system preference. */ }
  let chosen = saved === "light" || saved === "dark";
  let theme = chosen ? saved : preference?.matches ? "light" : "dark";
  const apply = () => { document.documentElement.dataset.theme = theme; };
  apply();

  document.addEventListener("DOMContentLoaded", () => {
    const toggle = document.getElementById("theme-toggle");
    const label = () => {
      const action = theme === "dark" ? "Switch to light theme" : "Switch to dark theme";
      toggle.textContent = action;
      toggle.setAttribute("aria-label", action);
    };
    toggle.disabled = false;
    label();
    toggle.addEventListener("click", () => {
      chosen = true;
      theme = theme === "dark" ? "light" : "dark";
      apply();
      label();
      try { localStorage.setItem("tap-theme", theme); } catch (_) { /* Keep the in-page choice. */ }
    });
    preference?.addEventListener("change", () => {
      if (chosen) return;
      theme = preference.matches ? "light" : "dark";
      apply();
      label();
    });
    initCopyPrompt();
  });
}

function initCopyPrompt() {
  document.querySelectorAll("[data-copy-target]").forEach(button => {
    const target = document.getElementById(button.dataset.copyTarget);
    if (!target) return;
    button.hidden = false;
    document.querySelector("[data-copy-fallback]")?.setAttribute("hidden", "");
    button.addEventListener("click", async () => {
      const text = target.textContent;
      let copied = false;
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch (_) {
        const field = document.createElement("textarea");
        field.value = text;
        field.setAttribute("readonly", "");
        field.style.position = "fixed";
        field.style.opacity = "0";
        document.body.append(field);
        field.select();
        try { copied = document.execCommand("copy"); } catch (_) { /* Offer manual selection. */ }
        field.remove();
        button.focus();
      }
      document.getElementById("copy-status").textContent = copied
        ? "Copied. Paste it into your agent."
        : "Copy unavailable. Select the install prompt below.";
      if (!copied) target.parentElement.focus();
    });
  });
}

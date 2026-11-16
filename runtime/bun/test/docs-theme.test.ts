import { expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";

const docs = resolve(import.meta.dir, "../../../docs");
const script = readFileSync(resolve(docs, "assets/theme.js"), "utf8");

function page(storage: { getItem(key: string): string | null; setItem(key: string, value: string): void }, light = false) {
  let ready = () => {};
  let click = () => {};
  let change = () => {};
  const preference = { matches: light, addEventListener: (_event: string, callback: () => void) => { change = callback; } };
  const attrs = new Map<string, string>();
  const button = {
    disabled: true,
    textContent: "",
    setAttribute: (key: string, value: string) => attrs.set(key, value),
    addEventListener: (_event: string, callback: () => void) => { click = callback; },
  };
  const document = {
    documentElement: { dataset: { theme: "dark" } },
    getElementById: () => button,
    querySelectorAll: () => [],
    addEventListener: (_event: string, callback: () => void) => { ready = callback; },
  };
  runInNewContext(`${script}\ninitTheme();`, { document, localStorage: storage, matchMedia: () => preference });
  return { document, button, attrs, ready: () => ready(), click: () => click(), system: (light: boolean) => { preference.matches = light; change(); } };
}

test("theme choice applies before DOM ready and persists across guide pages", () => {
  const saved = new Map<string, string>();
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); } };
  const first = page(storage);
  expect(first.document.documentElement.dataset.theme).toBe("dark");
  first.ready();
  expect(first.button.disabled).toBe(false);
  expect(first.attrs.get("aria-label")).toBe("Switch to light theme");
  first.click();
  expect(first.document.documentElement.dataset.theme).toBe("light");
  expect(first.button.textContent).toBe("Switch to dark theme");
  const next = page(storage);
  expect(next.document.documentElement.dataset.theme).toBe("light");
  next.ready();
  expect(next.attrs.get("aria-label")).toBe("Switch to dark theme");
  next.click();
  expect(page(storage).document.documentElement.dataset.theme).toBe("dark");
});

test("blocked storage and unknown saved values follow the system and retain a usable toggle", () => {
  for (const storage of [
    { getItem: () => { throw new Error("storage disabled"); }, setItem: () => { throw new Error("storage disabled"); } },
    { getItem: () => "unknown", setItem: () => {} },
  ]) {
    const current = page(storage, true);
    expect(current.document.documentElement.dataset.theme).toBe("light");
    current.ready();
    current.click();
    expect(current.document.documentElement.dataset.theme).toBe("dark");
    current.click();
    expect(current.document.documentElement.dataset.theme).toBe("light");
  }
});

test("system changes apply until the reader chooses, and a saved dark choice beats a light system", () => {
  const storage = { getItem: () => null, setItem: () => {} };
  const current = page(storage, true);
  expect(current.document.documentElement.dataset.theme).toBe("light");
  current.ready();
  current.system(false);
  expect(current.document.documentElement.dataset.theme).toBe("dark");
  expect(current.button.textContent).toBe("Switch to light theme");
  current.click();
  current.system(false);
  expect(current.document.documentElement.dataset.theme).toBe("light");
  expect(page({ ...storage, getItem: () => "dark" }, true).document.documentElement.dataset.theme).toBe("dark");
});

test("all twelve guide pages load the shared theme before content and expose a native toggle", () => {
  const guides = readdirSync(docs).filter(name => name === "index.html" || /^cheatsheet.*\.html$/.test(name));
  expect(guides).toHaveLength(12);
  for (const name of guides) {
    const html = readFileSync(resolve(docs, name), "utf8");
    const head = html.split("</head>")[0]!;
    expect(html, name).toContain('<html lang="en" data-theme="dark">');
    expect(head, name).toContain('<script src="assets/theme.js"></script>\n<script>initTheme();</script>');
    expect(head, name).toContain('<link rel="stylesheet" href="assets/theme.css">');
    expect(html, name).toMatch(/<button[^>]+id="theme-toggle"[^>]+type="button"[^>]+aria-label="Light theme"[^>]+disabled>/);
  }
});

test("both palettes keep text, links and code readable on their content backgrounds", () => {
  const css = readFileSync(resolve(docs, "assets/theme.css"), "utf8");
  const luminance = (hex: string) => {
    const channels = hex.match(/\w\w/g)!.map(value => parseInt(value, 16) / 255)
      .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  };
  for (const theme of ["dark", "light"]) {
    const block = css.match(new RegExp(`:root\\[data-theme="${theme}"\\] \\{([^}]+)\\}`))![1]!;
    const colors = Object.fromEntries([...block.matchAll(/--([a-z]+):\s*#([0-9a-f]{6})/g)].map(match => [match[1]!, luminance(match[2]!)]));
    for (const foreground of ["ink", "muted", "teal", "orange"]) {
      for (const background of ["paper", "card", "bus"]) {
        const a = colors[foreground]!, b = colors[background]!;
        const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
        expect(contrast, `${theme}: ${foreground} on ${background}`).toBeGreaterThanOrEqual(4.5);
      }
    }
  }
});

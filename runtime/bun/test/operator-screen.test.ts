import { expect, test } from "bun:test";
import { operatorKeyRefusal, operatorSurface } from "../src/recovery/operator-screen";

// Constructed modal projections, not unmodified captures or proof of harness key semantics.
function menu(label = "Close", footer = "↑/↓ to navigate · Enter to select · Esc to cancel · q to quit", title = "Settings") {
  return `╭────────────────────────────────────────────────────╮\n│ ${title}\n│ ❯ ${label}\n│   Other option\n│ ${footer}\n╰────────────────────────────────────────────────────╯\n`;
}

test("close keys act only within a bounded current navigation surface", () => {
  for (const harness of ["claude", "codex", "opencode"]) {
    const frame = menu();
    expect(operatorSurface(harness, frame).kind, harness).toBe("menu");
    for (const key of ["Escape", "q", "Enter"]) expect(operatorKeyRefusal(harness, frame, key), `${harness}/${key}`).toBe("");
  }
});
test("generic arrows cannot preview a setting even when the menu advertises navigation", () => {
  for (const title of ["Settings", "Themes", "Unknown menu"]) {
    for (const key of ["Up", "Down"]) expect(operatorKeyRefusal("opencode", menu("Close", undefined, title), key)).not.toBe("");
    expect(operatorKeyRefusal("opencode", menu("Close", undefined, title), "Escape")).toBe("");
  }
});
test("Codex's unboxed picker footer permits Escape without borrowing a selected row as Enter authority", () => {
  // Cropped 48x6 render from OpenAI Codex selection_picker_tests.rs, commit 5d5e5c507def46c4e53b30441cf8198c8663c9d2.
  const frame = "  Keymap\n   All   Common   Customized (3)             ›\n  Type to search shortcuts\n› Action 00  Ctrl+0\n  left/right group · enter edit · esc close\n";
  expect(operatorKeyRefusal("codex", frame, "Escape")).toBe("");
  expect(operatorKeyRefusal("codex", frame, "Enter")).not.toBe("");
  const settings = "Settings\n\nTheme: dark\nEsc to cancel\n";
  expect(operatorKeyRefusal("claude", settings, "Escape")).toBe("");
  expect(operatorKeyRefusal("claude", settings + "❯ human text\n", "Escape")).not.toBe("");
});
test("Enter has a runtime-owned closed selection vocabulary; a worker reason cannot widen it", () => {
  for (const label of ["Close", "Cancel", "Back", "Back (Enter)"]) {
    expect(operatorKeyRefusal("claude", menu(label), "Enter")).toBe("");
  }
  for (const label of ["Yes, allow", "Update now", "gpt-6-astra", "Save", "Apply", "Done", "Exit", "Close and delete", "Back up files", "Cancel subscription"]) {
    expect(operatorKeyRefusal("claude", menu(label), "Enter"), label).not.toBe("");
  }
  expect(operatorKeyRefusal("claude", menu().replace("❯ Close", "  Close"), "Enter")).not.toBe("");
  expect(operatorKeyRefusal("claude", menu().replace("  Other", "❯ Other"), "Enter")).not.toBe("");
});
test("a reverse-video selected close row has the same narrow meaning", () => {
  expect(operatorKeyRefusal("opencode", menu().replace("❯ Close", "\x1b[7mClose\x1b[0m"), "Enter")).toBe("");
  expect(operatorKeyRefusal("opencode", menu().replace("❯ Close", "\x1b[7mApply\x1b[0m"), "Enter")).not.toBe("");
});
test("permission, trust, login, install and update prompts stop every key, including Escape", () => {
  for (const title of ["Permission required", "Do you want to proceed?", "Trust this folder?", "Sign in", "Install update", "Update available"]) {
    for (const key of ["Escape", "Up", "q", "Enter"]) expect(operatorKeyRefusal("claude", menu("Cancel", undefined, title), key), `${title}/${key}`).not.toBe("");
  }
});
test("q and arrows need their own visible navigation hints, not an unrelated transcript hint", () => {
  expect(operatorKeyRefusal("claude", menu("Close", "Esc to cancel"), "q")).not.toBe("");
  expect(operatorKeyRefusal("claude", menu("Close", "Esc to cancel"), "Down")).not.toBe("");
  expect(operatorKeyRefusal("claude", "q to quit\n" + menu("Close", "Esc to cancel"), "q")).not.toBe("");
});
test("a restored composer or draft ends navigation even if a menu is still visible in history", () => {
  const composer = "────────────────────────────────────\n❯ \n────────────────────────────────────\n  ? for shortcuts\n";
  for (const frame of [composer, menu() + composer, menu() + composer.replace("❯ ", "❯ keep this draft")]) {
    for (const key of ["Escape", "Enter", "q"]) expect(operatorKeyRefusal("claude", frame, key)).not.toBe("");
  }
});
test("unbounded or truncated screens, free text and value-changing keys refuse", () => {
  for (const frame of ["Some unknown screen", "❯ Close\nEsc to cancel\n", menu().split("\n").slice(1).join("\n"), menu() + "new output\n"]) {
    expect(operatorKeyRefusal("claude", frame, "Enter")).not.toBe("");
  }
  for (const key of ["Left", "Right", "Tab", "C-c", "C-d", "C-u", "BSpace", "1", "hello", "Escape Enter"]) {
    expect(operatorKeyRefusal("claude", menu(), key), key).not.toBe("");
  }
});
test("a visible search/filter field permits only its cancel key, never printable q or Enter", () => {
  for (const field of ["Search themes: dark", "Filter: models", "Type to search"]) {
    const frame = menu().replace("│   Other option", `│ ${field}`);
    expect(operatorKeyRefusal("opencode", frame, "Escape")).toBe("");
    for (const key of ["q", "Enter"]) expect(operatorKeyRefusal("opencode", frame, key), `${field}/${key}`).not.toBe("");
  }
});

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR } from "./config.ts";
import { DEFAULT_SETTINGS, type Settings, THEMES, type Theme } from "./types.ts";

// settings.json in the config folder. View state (sort, folds, panel width) stays in the browser.
const SETTINGS_FILE = join(CONFIG_DIR, "settings.json");

// Read every time, so a hand edit takes effect on the next load. Missing is just the defaults.
function readFile(): Partial<Settings> {
  let text: string;
  try {
    text = readFileSync(SETTINGS_FILE, "utf8");
  } catch {
    return {};
  }
  return JSON.parse(text) as Partial<Settings>;
}

export function getSettings(): Settings {
  try {
    return { ...DEFAULT_SETTINGS, ...readFile() };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Saves the known settings in `patch`: the on/off ones, and a theme we have. Throws if the file is broken, rather than overwrite it. */
export function saveSettings(patch: Record<string, unknown>): Settings {
  const next: Record<string, unknown> = { ...readFile() };
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    if (typeof fallback === "boolean" && typeof patch[key] === "boolean") next[key] = patch[key];
  }
  if (THEMES.includes(patch.theme as Theme)) next.theme = patch.theme;
  mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, SETTINGS_FILE);
  return { ...DEFAULT_SETTINGS, ...next };
}

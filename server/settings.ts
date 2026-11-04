import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SETTINGS, type Settings } from "./types.ts";

// What should outlive a reboot: settings.json here, points.jsonl next to it. View state (sort,
// folds, panel width) stays in the browser.
export const CONFIG_DIR = process.env.OPERATOR_CONFIG_DIR ?? join(homedir(), ".config", "session-operator");
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

/** Saves the known on/off settings in `patch`. Throws if the file is broken, rather than overwrite it. */
export function saveSettings(patch: Record<string, unknown>): Settings {
  const next: Record<string, unknown> = { ...readFile() };
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    if (typeof patch[key] === "boolean") next[key] = patch[key];
  }
  mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = `${SETTINGS_FILE}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(tmp, SETTINGS_FILE);
  return { ...DEFAULT_SETTINGS, ...next };
}

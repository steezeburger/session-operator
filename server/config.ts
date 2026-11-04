import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// What should outlive a reboot. The system's temp folder doesn't qualify: macOS purges files
// there that haven't been touched for a few days.
export const CONFIG_DIR = process.env.OPERATOR_CONFIG_DIR ?? join(homedir(), ".config", "session-operator");

/** A file in the config folder. The first time, moves it over from temp, where it used to live. */
export function stateFile(name: string): string {
  const path = join(CONFIG_DIR, name);
  mkdirSync(CONFIG_DIR, { recursive: true });
  const old = join(tmpdir(), `session-operator-${name}`);
  if (!existsSync(path) && existsSync(old)) {
    copyFileSync(old, path);
    rmSync(old);
  }
  return path;
}

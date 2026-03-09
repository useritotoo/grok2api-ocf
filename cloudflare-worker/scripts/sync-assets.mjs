import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(currentDir, "..");
const sourceDir = resolve(workerRoot, "..", "_public", "static");
const targetDir = resolve(workerRoot, ".assets");

if (!existsSync(sourceDir)) {
  throw new Error(`Static asset source not found: ${sourceDir}`);
}

mkdirSync(targetDir, { recursive: true });
cpSync(sourceDir, targetDir, { recursive: true, force: true });

console.log(`Synced assets: ${sourceDir} -> ${targetDir}`);

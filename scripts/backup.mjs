import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const dataDir = path.join(root, "data");
const backupsDir = path.join(root, "backups");
const KEEP = 10;

if (!fs.existsSync(path.join(dataDir, "app.db"))) {
  console.error("data/app.db not found, nothing to backup");
  process.exit(1);
}

fs.mkdirSync(backupsDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const dir = path.join(backupsDir, stamp);
fs.mkdirSync(dir, { recursive: true });

// VACUUM INTO creates a consistent SQLite snapshot while WAL mode is active.
const db = new DatabaseSync(path.join(dataDir, "app.db"));
const dest = path.join(dir, "app.db");
db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
db.close();

const copiedDirectories = [];
for (const sub of ["videos", "thumbs", "assets", "task-runs", "ops-reference-videos", "voice-templates", "personal-voices"]) {
  const src = path.join(dataDir, sub);
  if (fs.existsSync(src)) {
    fs.cpSync(src, path.join(dir, sub), { recursive: true });
    copiedDirectories.push(sub);
  }
}

fs.writeFileSync(
  path.join(dir, "manifest.json"),
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      app: "director-workbench",
      database: "app.db",
      copiedDirectories,
    },
    null,
    2,
  ),
);

// Retain only the newest KEEP backup directories.
const names = fs
  .readdirSync(backupsDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .reverse();
for (const name of process.argv.includes("--keep-existing") ? [] : names.slice(KEEP)) {
  fs.rmSync(path.join(backupsDir, name), { recursive: true, force: true });
}

console.log("backup created:", dir);

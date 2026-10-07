import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { db } from "./db";
import { DATA_DIR } from "./paths";

export interface PersonalVoiceRow {
  id: string;
  created_by: string;
  name: string;
  source_ids_json: string;
  status: "new" | "ready";
  archived: number;
  created_at: string;
}

export function ownedVoice(id: string, owner: string, includeArchived = false): PersonalVoiceRow | undefined {
  return db.prepare(`SELECT * FROM personal_voices WHERE id=? AND created_by=? ${includeArchived ? "" : "AND archived=0"}`)
    .get(id, owner) as unknown as PersonalVoiceRow | undefined;
}

export function voiceReferenceDirectory(id: string): string {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("音色编号无效");
  return path.join(DATA_DIR, "personal-voices", id, "reference");
}

export function verifiedPersonalReference(id: string, owner: string, includeArchived = false): string {
  const voice = ownedVoice(id, owner, includeArchived);
  if (!voice || voice.status !== "ready") throw new Error("个人音色尚未准备好，请先在声音克隆里生成一次试听");
  const directory = voiceReferenceDirectory(id);
  const file = path.join(directory, "reference.wav");
  const report = JSON.parse(fs.readFileSync(path.join(directory, "reference-report.json"), "utf8"));
  if (createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== report.referenceSha256) {
    throw new Error("个人音色文件校验不一致，请联系管理员恢复音色备份");
  }
  return directory;
}

export function personalVoiceOut(row: PersonalVoiceRow) {
  return { id: row.id, name: row.name, status: row.status, sourceIds: JSON.parse(row.source_ids_json) as string[], createdAt: row.created_at };
}

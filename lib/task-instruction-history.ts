import "server-only";

import { db } from "./db";

export type TaskInstructionKind = "create" | "revision";

export interface TaskInstructionHistoryOut {
  id: number;
  taskId: number;
  kind: TaskInstructionKind;
  instruction: string;
  createdAt: string;
  taskStatus: string | null;
}

interface TaskInstructionHistoryRow {
  id: number;
  task_id: number;
  kind: TaskInstructionKind;
  instruction: string;
  created_at: string;
  task_status: string | null;
}

export function recordTaskInstruction(options: {
  taskId: number;
  createdBy: string;
  kind: TaskInstructionKind;
  instruction: string;
  createdAt?: string;
}): void {
  const instruction = options.instruction.trim();
  if (!instruction) return;
  const sql =
    options.kind === "create"
      ? `INSERT OR IGNORE INTO task_instruction_history
           (task_id, created_by, kind, instruction, created_at)
         VALUES (?, ?, 'create', ?, ?)`
      : `INSERT INTO task_instruction_history
           (task_id, created_by, kind, instruction, created_at)
         VALUES (?, ?, 'revision', ?, ?)`;
  db.prepare(sql).run(
    options.taskId,
    options.createdBy,
    instruction,
    options.createdAt ?? new Date().toISOString(),
  );
}

export function listTaskInstructionHistory(
  createdBy: string,
  limit = 24,
): TaskInstructionHistoryOut[] {
  const safeLimit = Math.max(1, Math.min(50, Math.trunc(limit) || 24));
  const rows = db
    .prepare(
      `SELECT h.id, h.task_id, h.kind, h.instruction, h.created_at,
              t.status AS task_status
       FROM task_instruction_history h
       LEFT JOIN tasks t ON t.id = h.task_id
       WHERE h.created_by = ?
       ORDER BY h.id DESC
       LIMIT ?`,
    )
    .all(createdBy, safeLimit) as unknown as TaskInstructionHistoryRow[];
  return rows.map((row) => ({
    id: row.id,
    taskId: row.task_id,
    kind: row.kind,
    instruction: row.instruction,
    createdAt: row.created_at,
    taskStatus: row.task_status,
  }));
}

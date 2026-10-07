import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const baseUrl = process.env.DW_E2E_BASE_URL || "http://127.0.0.1";
const adminUsername = process.env.DW_E2E_ADMIN_USERNAME || "admin";
const adminPassword = process.env.DW_E2E_ADMIN_PASSWORD;
const sourcePath = process.argv[2];
const employeeCount = Number(process.env.DW_E2E_EMPLOYEES || "4");
const tasksPerEmployee = Number(process.env.DW_E2E_TASKS_PER_EMPLOYEE || "1");
if (!adminPassword) throw new Error("DW_E2E_ADMIN_PASSWORD is required");
if (!sourcePath) throw new Error("Pass a real authorized MP4 path");
if (!Number.isSafeInteger(employeeCount) || employeeCount < 1 || employeeCount > 4) {
  throw new Error("DW_E2E_EMPLOYEES must be 1-4");
}
if (!Number.isSafeInteger(tasksPerEmployee) || tasksPerEmployee < 1 || tasksPerEmployee > 2) {
  throw new Error("DW_E2E_TASKS_PER_EMPLOYEE must be 1-2");
}

function cookieFrom(response) {
  const value = response.headers.getSetCookie?.()[0] || response.headers.get("set-cookie") || "";
  const cookie = value.split(";", 1)[0];
  if (!cookie.includes("=")) throw new Error("Login response did not set a cookie");
  return cookie;
}

async function request(url, options = {}) {
  const response = await fetch(`${baseUrl}${url}`, options);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`${options.method || "GET"} ${url}: ${data.error || response.status}`);
  }
  return { response, data };
}

async function login(username, password) {
  const { response } = await request("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  return cookieFrom(response);
}

function ephemeralCodexProcesses() {
  const powershell = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = [
    "$items = Get-CimInstance Win32_Process -Filter \"Name = 'codex.exe'\" |",
    "Where-Object { $_.CommandLine -match '--ephemeral' -and $_.CommandLine -match 'director-codex-staging' };",
    "@($items).Count",
  ].join(" ");
  const result = execFileSync(powershell, ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 10_000,
  }).trim();
  return Number(result || "0");
}

const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const temporaryPassword = `Temp${Math.random().toString(36).slice(2, 10)}9`;
const createdUsers = [];
const createdVideos = [];
const createdTasks = [];
let adminCookie = "";
let maximumCodexProcesses = 0;
let simultaneousRunningTasks = 0;

try {
  adminCookie = await login(adminUsername, adminPassword);
  const employees = [];
  for (let index = 0; index < employeeCount; index += 1) {
    const username = `e2e_${suffix}_${index + 1}`;
    const { data } = await request("/api/users", {
      method: "POST",
      headers: { cookie: adminCookie, "content-type": "application/json" },
      body: JSON.stringify({
        username,
        displayName: `并发验收 ${index + 1}`,
        password: temporaryPassword,
        isAdmin: false,
      }),
    });
    createdUsers.push(data.user.id);
    employees.push({ username, cookie: await login(username, temporaryPassword) });
  }

  const sourceBytes = readFileSync(sourcePath);
  for (const [index, employee] of employees.entries()) {
    const form = new FormData();
    form.append(
      "file",
      new File([sourceBytes], `concurrency-${index + 1}.mp4`, { type: "video/mp4" }),
    );
    const { data: videoData } = await request("/api/videos", {
      method: "POST",
      headers: { cookie: employee.cookie },
      body: form,
    });
    createdVideos.push(videoData.video.id);
    for (let taskIndex = 0; taskIndex < tasksPerEmployee; taskIndex += 1) {
      const { data: taskData } = await request("/api/tasks", {
        method: "POST",
        headers: { cookie: employee.cookie, "content-type": "application/json" },
        body: JSON.stringify({
          videoId: videoData.video.id,
          featureId: "video_replication",
          params: {
            brief: `并发验收 ${index + 1}-${taskIndex + 1}：保留动作和镜头，只替换为原创虚构角色。`,
            duration: 15,
            continuity: "single",
            referenceDelivery: "text_only",
            sound: "mute",
          },
        }),
      });
      createdTasks.push({ id: taskData.task.id, cookie: employee.cookie });
    }
  }

  const deadline = Date.now() + 8 * 60 * 1000;
  let terminal = [];
  while (Date.now() < deadline) {
    const states = await Promise.all(
      createdTasks.map(async ({ id, cookie }) => {
        const { data } = await request(`/api/tasks/${id}`, { headers: { cookie } });
        return { id, status: data.task.status, progress: data.task.progress };
      }),
    );
    simultaneousRunningTasks = Math.max(
      simultaneousRunningTasks,
      states.filter((item) => item.status === "running").length,
    );
    maximumCodexProcesses = Math.max(maximumCodexProcesses, ephemeralCodexProcesses());
    terminal = states.filter((item) =>
      ["awaiting_confirmation", "failed", "canceled"].includes(item.status),
    );
    if (terminal.length === createdTasks.length) break;
    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  const finalStates = await Promise.all(
    createdTasks.map(async ({ id, cookie }) => {
      const { data } = await request(`/api/tasks/${id}`, { headers: { cookie } });
      return {
        id,
        status: data.task.status,
        progress: data.task.progress,
        error: data.task.error || null,
      };
    }),
  );
  console.log(
    JSON.stringify(
      { employeeCount, tasksPerEmployee, simultaneousRunningTasks, maximumCodexProcesses, finalStates },
      null,
      2,
    ),
  );
  if (maximumCodexProcesses !== employeeCount) {
    throw new Error(`Observed ${maximumCodexProcesses} simultaneous Codex processes for ${employeeCount} employees`);
  }
  if (finalStates.some((item) => item.status !== "awaiting_confirmation")) {
    throw new Error("At least one real understanding task did not reach confirmation");
  }
} finally {
  for (const { id, cookie } of createdTasks) {
    try {
      await request(`/api/tasks/${id}/cancel`, { method: "POST", headers: { cookie } });
    } catch {
      // Terminal tasks return a conflict, which is safe to ignore during cleanup.
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  for (const id of createdVideos) {
    try {
      await request(`/api/videos/${id}`, { method: "DELETE", headers: { cookie: adminCookie } });
    } catch (error) {
      console.error(`Cleanup video ${id} failed:`, error instanceof Error ? error.message : error);
    }
  }
  for (const id of createdUsers) {
    try {
      await request(`/api/users/${id}`, { method: "DELETE", headers: { cookie: adminCookie } });
    } catch (error) {
      console.error(`Cleanup user ${id} failed:`, error instanceof Error ? error.message : error);
    }
  }
}

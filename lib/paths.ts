import path from "node:path";

/** 项目根目录（运行 npm 时的目录） */
export const PROJECT_ROOT = process.cwd();
/** 所有运行时数据（数据库、上传视频、密钥） */
const testDataDirectory = process.env.DW_TEST_DATA_DIR?.trim();
if (testDataDirectory && !path.isAbsolute(testDataDirectory)) {
  throw new Error("DW_TEST_DATA_DIR must be an absolute path");
}
// `next build` evaluates server modules while collecting route data. Those
// workers are not the production service and must never open or mutate the live
// task database merely because a route imports lib/db.ts.
const isNextProductionBuild =
  process.env.NEXT_PHASE === "phase-production-build" ||
  process.env.NEXT_PRIVATE_BUILD_WORKER === "1";
export const DATA_DIR = testDataDirectory
  ? path.resolve(testDataDirectory)
  : isNextProductionBuild
    ? path.join(process.cwd(), ".next-build-runtime")
    : path.join(process.cwd(), "data");
export const UPLOAD_DIR = path.join(DATA_DIR, "videos");
export const THUMB_DIR = path.join(DATA_DIR, "thumbs");
export const ASSET_DIR = path.join(DATA_DIR, "assets");
export const VIDEO_UPLOAD_SESSION_DIR = path.join(DATA_DIR, "video-upload-sessions");
export const OPS_REFERENCE_VIDEO_DIR = path.join(DATA_DIR, "ops-reference-videos");
export const DB_PATH = path.join(DATA_DIR, "app.db");
export const SECRET_FILE = path.join(DATA_DIR, ".jwt-secret");

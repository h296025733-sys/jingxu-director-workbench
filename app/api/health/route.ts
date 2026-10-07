import { NextResponse } from "next/server";
import { db } from "@/lib/db";

/** 无需登录的健康检查，供部署/监控探测使用 */
export async function GET() {
  try {
    db.prepare("SELECT 1").get();
    return NextResponse.json({
      ok: true,
      app: "镜序",
      version: "0.2.0",
      time: new Date().toISOString(),
    });
  } catch {
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

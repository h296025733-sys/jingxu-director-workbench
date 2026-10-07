import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getSessionUser, type AuthUser } from "./auth";

export function ok(data: unknown): NextResponse {
  return NextResponse.json(data);
}

export function fail(message: string, status = 400, code?: string): NextResponse {
  return NextResponse.json({ error: message, ...(code ? { code } : {}) }, { status });
}

/** 无动态参数路由的上下文类型（兼容 Next 15+ 的异步 params） */
export type NoParams = { params: Promise<unknown> };

export class RequestBodyTooLargeError extends Error {}

type Handler<T> = (
  req: NextRequest,
  ctx: T,
  user: AuthUser,
) => Promise<Response>;

/** 统一包装：先校验登录态，再执行业务逻辑，并把异常转成 500 响应 */
export function withAuth<T>(handler: Handler<T>) {
  return async (req: NextRequest, ctx: T): Promise<Response> => {
    const user = await getSessionUser();
    if (!user) return fail("未登录或登录已过期", 401);
    try {
      const resolvedCtx = await ctx;
      return await handler(req, resolvedCtx, user);
    } catch (err) {
      console.error("[导演工作台] 接口异常：", err);
      if (err instanceof RequestBodyTooLargeError) {
        return fail("请求内容过大", 413);
      }
      return fail("服务器内部错误，请联系管理员", 500);
    }
  };
}

export async function readJson(
  req: NextRequest,
  maxBytes = 2 * 1024 * 1024,
): Promise<Record<string, unknown>> {
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isSafeInteger(contentLength) && contentLength > maxBytes) {
    throw new RequestBodyTooLargeError("Request body exceeds the configured limit");
  }
  if (!req.body) return {};

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request body too large");
        throw new RequestBodyTooLargeError(
          "Request body exceeds the configured limit",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    return body && typeof body === "object" ? body : {};
  } catch {
    return {};
  }
}

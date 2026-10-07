import crypto from "node:crypto";
import fs from "node:fs";
import { SignJWT, jwtVerify } from "jose";
import { DATA_DIR, SECRET_FILE } from "./paths";

export const COOKIE_NAME = "dw_token";

let cachedSecret: Uint8Array | null = null;

export function getJwtSecret(): Uint8Array {
  if (cachedSecret) return cachedSecret;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  let raw = "";
  if (fs.existsSync(SECRET_FILE)) {
    raw = fs.readFileSync(SECRET_FILE, "utf8").trim();
  }
  if (!raw) {
    raw = crypto.randomBytes(32).toString("hex");
    fs.writeFileSync(SECRET_FILE, raw, { mode: 0o600 });
  }
  cachedSecret = new TextEncoder().encode(raw);
  return cachedSecret;
}

export interface TokenPayload {
  sub: string;
  username: string;
  displayName: string;
}

export async function signToken(
  payload: TokenPayload,
  expiresDays = 7,
): Promise<string> {
  return new SignJWT({
    username: payload.username,
    displayName: payload.displayName,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(payload.sub)
    .setIssuedAt()
    .setExpirationTime(`${expiresDays}d`)
    .sign(getJwtSecret());
}

export async function verifyToken(
  token: string,
): Promise<TokenPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getJwtSecret());
    return {
      sub: String(payload.sub ?? ""),
      username: String(payload.username ?? ""),
      displayName: String(payload.displayName ?? ""),
    };
  } catch {
    return null;
  }
}

/**
 * Staging auth surface. HMAC sessions match FastAPI auth_version=2.
 *
 * Workers Free (~10 ms CPU) cannot verify legacy scrypt(n=16384) hashes.
 * Staging accounts use PBKDF2-SHA256. Production cutover either:
 *   1) keeps login on the Render backend until passwords are reclaimed, or
 *   2) forces a one-time password reset into PBKDF2 during migration.
 */
import { Env, Fault, json, now, Principal, readBody, digest } from "../shared/core";

const PBKDF2_ITERS = 100000;

function b64url(bytes: Uint8Array) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSign(secret: string, raw: string) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw))));
}

async function pbkdf2Hash(password: string, saltHex?: string) {
  if (password.length < 8 || password.length > 128) throw new Fault(422, "Password must be 8–128 characters");
  const salt = saltHex ? Uint8Array.from(saltHex.match(/.{2}/g)!.map((h) => parseInt(h, 16))) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERS }, key, 256);
  const digestHex = [...new Uint8Array(bits)].map((b) => b.toString(16).padStart(2, "0")).join("");
  const saltOut = [...salt].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `pbkdf2$${PBKDF2_ITERS}$${saltOut}$${digestHex}`;
}

async function verifyPassword(password: string, encoded: string) {
  if (!encoded) return false;
  const parts = encoded.split("$");
  if (parts[0] === "pbkdf2" && parts.length === 4) {
    const [, , salt, expected] = parts;
    const next = await pbkdf2Hash(password, salt);
    return next.split("$")[3] === expected;
  }
  if (parts[0] === "scrypt") {
    throw new Fault(503, "Legacy scrypt passwords require password reset before Cloudflare login");
  }
  return false;
}

async function mintToken(env: Env, account: { id: string; password_hash: string; role: string; display_name: string; s_number: number; credential_revision: string }) {
  const exp = Math.floor(now() / 1000) + 14 * 24 * 3600;
  const body = {
    sub: account.id,
    admin: account.id === "Admin" && account.role === "admin",
    auth_version: 2,
    credential_revision: account.credential_revision,
    exp,
  };
  const raw = b64url(new TextEncoder().encode(JSON.stringify(body)));
  const signature = await hmacSign(env.SESSION_SECRET, raw);
  return `${raw}.${signature}`;
}

export async function accountStatus(request: Request, env: Env) {
  const body = await readBody(request, 2048);
  const id = String(body.scout_id || "").trim();
  if (!id) throw new Fault(422, "scout_id required");
  const account = await env.DB.prepare("SELECT id,password_hash,role,active FROM accounts WHERE id=?").bind(id).first<any>();
  if (!account || !account.active) throw new Fault(404, "Unknown account");
  return json({ needs_setup: account.id !== "Admin" && !account.password_hash });
}

export async function setup(request: Request, env: Env) {
  const body = await readBody(request, 4096);
  const id = String(body.scout_id || "").trim();
  const password = String(body.password || "");
  const account = await env.DB.prepare("SELECT * FROM accounts WHERE id=? AND active=1").bind(id).first<any>();
  if (!account) throw new Fault(404, "Unknown account");
  if (account.id === "Admin" || account.password_hash) throw new Fault(409, "Account already set up");
  const password_hash = await pbkdf2Hash(password);
  const credential_revision = await digest(password_hash);
  await env.DB.prepare("UPDATE accounts SET password_hash=?,credential_revision=? WHERE id=? AND password_hash=''")
    .bind(password_hash, credential_revision, id).run();
  const updated = await env.DB.prepare("SELECT * FROM accounts WHERE id=?").bind(id).first<any>();
  const token = await mintToken(env, updated);
  return json({ token, scout_id: updated.id, display_name: updated.display_name, role: updated.role, is_admin: updated.id === "Admin" && updated.role === "admin" });
}

export async function login(request: Request, env: Env) {
  const body = await readBody(request, 4096);
  const id = String(body.scout_id || "").trim();
  const password = String(body.password || "");
  const account = await env.DB.prepare("SELECT * FROM accounts WHERE id=? AND active=1").bind(id).first<any>();
  if (!account) throw new Fault(401, "Invalid credentials");
  if (account.id === "Admin" && !account.password_hash && env.TEAM_PASSWORD) {
    if (password !== env.TEAM_PASSWORD) throw new Fault(401, "Invalid credentials");
  } else if (!(await verifyPassword(password, account.password_hash || ""))) {
    throw new Fault(401, "Invalid credentials");
  }
  if (!account.credential_revision) {
    account.credential_revision = await digest(account.password_hash || account.id);
    await env.DB.prepare("UPDATE accounts SET credential_revision=? WHERE id=?").bind(account.credential_revision, account.id).run();
  }
  const token = await mintToken(env, account);
  return json({
    token,
    scout_id: account.id,
    display_name: account.display_name,
    role: account.role,
    is_admin: account.id === "Admin" && account.role === "admin",
    picklist_only: account.role === "picklist",
    s_number: account.s_number,
  });
}

export function me(user: Principal, token: string | undefined) {
  return json({
    token,
    scout_id: user.id,
    display_name: user.display_name,
    role: user.role,
    is_admin: user.id === "Admin" && user.role === "admin",
    picklist_only: user.role === "picklist",
    s_number: user.s_number,
    bucks: 0,
  });
}

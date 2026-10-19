import { db } from "./db";
import type { Session } from "./types";

const encoder = new TextEncoder();
const VERSION = 1;
const ITERATIONS = 600_000;
const DEVICE = "device-v1";
const SESSION = "hazehub.offline-session";
const normalize = (id: string) => id.trim().toLowerCase();
const recordId = (id: string) => `account:${normalize(id)}`;
type Grant = { version: number; scout_id: string; s_number: number; display_name: string; issued_at: number; expires_at: number };

async function locked<T>(work: () => Promise<T>): Promise<T> {
  if (!crypto.subtle || !navigator.locks) throw new Error("Offline sign-in requires HTTPS and a supported browser.");
  return navigator.locks.request("hazehub-offline-credentials", work);
}
async function passwordKey(password: string, salt: Uint8Array): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey({ name: "PBKDF2", hash: "SHA-256", salt, iterations: ITERATIONS }, material,
    { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function seal(key: CryptoKey, bytes: BufferSource, aad: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(aad) }, key, bytes);
  return { iv, ciphertext };
}
async function open(key: CryptoKey, envelope: any, aad: string) {
  return crypto.subtle.decrypt({ name: "AES-GCM", iv: envelope.iv, additionalData: encoder.encode(aad) }, key, envelope.ciphertext);
}
async function cleanup() {
  const table = db().offlineCredentials;
  const rows = await table.toArray();
  await table.bulkDelete(rows.filter(r => r.id !== DEVICE && (r.version !== VERSION || r.expires_at <= Date.now())).map(r => r.id));
}

/** Called only after the server verifies this account's password for provisioning. */
export async function provisionOffline(grant: Grant, password: string): Promise<void> {
  await locked(async () => {
    if (grant.version !== VERSION || grant.expires_at <= Date.now() || grant.expires_at > Date.now() + 86_400_000) throw new Error("Invalid offline authorization.");
    await cleanup();
    const table = db().offlineCredentials;
    let device = await table.get(DEVICE);
    if (!device) {
      device = { id: DEVICE, key: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]) };
      await table.put(device);
    }
    const id = recordId(grant.scout_id);
    const aad = `${VERSION}:${id}:${grant.expires_at}`;
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const passwordEnvelope = await seal(await passwordKey(password, salt), encoder.encode(JSON.stringify(grant)), aad);
    // Outer device encryption prevents a copied roster file becoming a portable verifier.
    const inner = JSON.stringify({ iv: Array.from(passwordEnvelope.iv), ciphertext: Array.from(new Uint8Array(passwordEnvelope.ciphertext)) });
    const envelope = await seal(device.key, encoder.encode(inner), aad);
    // Retain exactly ONE account's verifier on a browser profile. Accumulating
    // every teammate's encrypted verifier would recreate the roster exposure.
    await db().transaction("rw", table, async () => {
      const obsolete = (await table.toCollection().primaryKeys()).filter(key => key !== DEVICE);
      await table.bulkDelete(obsolete);
      await table.put({ id, version: VERSION, expires_at: grant.expires_at, salt, envelope, failures: 0, next_attempt: 0, last_seen: Date.now() });
    });
    notifyRevoked(null);
  });
}

export async function hasOfflineAccount(id: string): Promise<boolean> {
  await cleanup();
  return !!(await db().offlineCredentials.get(recordId(id)));
}
function notifyRevoked(id: string | null) {
  window.dispatchEvent(new CustomEvent("offline-revoked", { detail: id }));
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("hazehub-offline-revoked");
    channel.postMessage(id); channel.close();
  }
}
export async function revokeOffline(id: string) {
  await db().offlineCredentials.delete(recordId(id));
  notifyRevoked(normalize(id));
}
export async function resetOfflineDevice() {
  await locked(() => db().offlineCredentials.clear());
  notifyRevoked(null);
  // Queued submissions and drafts deliberately survive a device credential reset.
}

export async function endOfflineSession() {
  const id = sessionStorage.getItem(SESSION);
  sessionStorage.removeItem(SESSION);
  if (id) await db().offlineCredentials.delete(id);
}

export async function restoreOfflineSession(): Promise<Session | null> {
  const id = sessionStorage.getItem(SESSION);
  if (!id) return null;
  try {
    return await locked(async () => {
      await cleanup();
      const table = db().offlineCredentials;
      const row = await table.get(id);
      const device = await table.get(DEVICE);
      if (!row || !device || row.expires_at <= Date.now()) throw new Error();
      const session: Session = JSON.parse(new TextDecoder().decode(await open(device.key, row.envelope, `${VERSION}:${id}:${row.expires_at}`)));
      const account = await table.get(recordId(session.scout_id));
      if (!account || account.expires_at < row.expires_at || Date.now() + 60_000 < account.last_seen || session.offline_until !== row.expires_at || session.token || session.role !== "scouter" || session.is_admin || session.picklist_only) throw new Error();
      return session;
    });
  } catch { await endOfflineSession().catch(() => {}); return null; }
}

export async function unlockOffline(id: string, password: string): Promise<Session> {
  return locked(async () => {
    await cleanup();
    const table = db().offlineCredentials;
    const row = await table.get(recordId(id));
    const device = await table.get(DEVICE);
    if (!row || !device) throw new Error("This account is not prepared for offline sign-in. Sign in online on this device first.");
    const now = Date.now();
    if (now + 60_000 < row.last_seen || row.failures >= 5) {
      await table.delete(row.id);
      throw new Error("Offline access is locked. Sign in online to prepare this account again.");
    }
    if (now < row.next_attempt) throw new Error("Please wait before trying your password again.");
    // Persist BEFORE expensive crypto, and serialize attempts across browser tabs.
    await table.update(row.id, { failures: row.failures + 1, next_attempt: now + 1000 * 2 ** row.failures, last_seen: now });
    let grant: Grant;
    try {
      const aad = `${VERSION}:${row.id}:${row.expires_at}`;
      const inner = JSON.parse(new TextDecoder().decode(await open(device.key, row.envelope, aad)));
      const plain = await open(await passwordKey(password, row.salt), { iv: new Uint8Array(inner.iv), ciphertext: new Uint8Array(inner.ciphertext) }, aad);
      grant = JSON.parse(new TextDecoder().decode(plain));
      if (grant.version !== VERSION || recordId(grant.scout_id) !== row.id || grant.expires_at !== row.expires_at || grant.expires_at <= Date.now()) throw new Error();
    } catch {
      if (row.failures + 1 >= 5) await table.delete(row.id);
      throw new Error("Incorrect password or damaged offline access. After five failed attempts, online sign-in is required.");
    }
    await table.update(row.id, { failures: 0, next_attempt: 0, last_seen: Date.now() });
    const session: Session = { token: "", scout_id: grant.scout_id, s_number: grant.s_number, display_name: grant.display_name,
      role: "scouter", is_admin: false, picklist_only: false, bucks: 0,
      offline_until: Math.min(grant.expires_at, Date.now() + 4 * 3600_000) };
    await endOfflineSession();
    const sessionId = `session:${crypto.randomUUID()}`;
    const envelope = await seal(device.key, encoder.encode(JSON.stringify(session)), `${VERSION}:${sessionId}:${session.offline_until}`);
    await table.put({ id: sessionId, version: VERSION, expires_at: session.offline_until, envelope });
    // This is a tab-local locator, not a server token or password verifier.
    sessionStorage.setItem(SESSION, sessionId);
    return session;
  });
}

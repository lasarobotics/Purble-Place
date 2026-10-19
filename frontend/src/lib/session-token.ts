// Online bearer tokens live only in memory. Reload restores through an HttpOnly cookie.
let token = "";
let migrated = false;
export function sessionToken(): string {
  if (typeof window === "undefined") return "";
  if (!migrated) {
    migrated = true;
    token = localStorage.getItem("hazehub.token") || "";
    localStorage.removeItem("hazehub.token");
    localStorage.removeItem("hazehub.session");
  }
  return token;
}
export function saveSessionToken(value: string) { sessionToken(); token = value; }

// Local partition key only; the server still verifies every authenticated request.
export function localOwner(): string {
  if (typeof window === "undefined") return "";
  try {
    const raw = (localStorage.getItem("hazehub.token") || "").split(".")[0];
    return JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))).sub || "";
  } catch { return ""; }
}

export function localAdmin(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = (localStorage.getItem("hazehub.token") || "").split(".")[0];
    return JSON.parse(atob(raw.replace(/-/g, "+").replace(/_/g, "/"))).admin === true;
  } catch { return false; }
}

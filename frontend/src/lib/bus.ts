// Tiny pub/sub so live server events can nudge any page to refetch.
type Handler = (event: string, payload: any) => void;
const handlers = new Set<Handler>();

export function onBus(h: Handler): () => void {
  handlers.add(h);
  return () => handlers.delete(h);
}
export function emitBus(event: string, payload: any) {
  handlers.forEach((h) => {
    try { h(event, payload); } catch {}
  });
}

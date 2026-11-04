import type { Session } from "./session.js";

interface Entry {
  session: Session;
  clients: number;
  expiry?: NodeJS.Timeout;
}

/** Allow SSE reconnects, then release sessions whose browser has gone away. */
export class SessionRegistry {
  private entries = new Map<string, Entry>();

  constructor(private reconnectMs = 30_000) {}

  add(session: Session) {
    const entry = { session, clients: 0 };
    this.entries.set(session.id, entry);
    this.expire(entry);
  }

  get(id: string) { return this.entries.get(id)?.session; }

  subscribe(id: string) {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("session not found");
    clearTimeout(entry.expiry);
    entry.clients++;
    let released = false;
    return () => {
      if (released || this.entries.get(id) !== entry) return;
      released = true;
      if (--entry.clients === 0) this.expire(entry);
    };
  }

  delete(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    clearTimeout(entry.expiry);
    this.entries.delete(id);
    entry.session.close();
  }

  close() {
    for (const id of this.entries.keys()) this.delete(id);
  }

  private expire(entry: Entry) {
    entry.expiry = setTimeout(() => this.delete(entry.session.id), this.reconnectMs);
    entry.expiry.unref();
  }
}

import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { getDiff, getRepoInfo, resolveRepoRoot, type DiffSource } from "./git.js";
import { Session } from "./session.js";
import { SessionRegistry } from "./sessions.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "2mb" }));

const defaultRepo = path.resolve(process.env.XPL_REPO || process.argv[2] || process.cwd());
const sessions = new SessionRegistry();

// Only accept requests from localhost origins (basic CSRF protection for a local tool).
app.use("/api", (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.status(403).json({ error: "forbidden origin" });
    return;
  }
  next();
});

app.get("/api/config", (_req, res) => {
  res.json({ defaultRepo });
});

app.get("/api/repo", async (req, res) => {
  try {
    res.json(await getRepoInfo(String(req.query.path || defaultRepo)));
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

app.post("/api/sessions", async (req, res) => {
  try {
    const { repoPath, source, language, model } = req.body as {
      repoPath: string;
      source: DiffSource;
      language?: string;
      model?: string;
    };
    const root = await resolveRepoRoot(repoPath || defaultRepo);
    const diff = await getDiff(root, source);
    const s = new Session({ repoRoot: root, diff, language: language || "日本語", model });
    try {
      await s.start();
    } catch (error) {
      s.close();
      throw error;
    }
    sessions.add(s);
    res.json({ id: s.id, files: diff.files.length });
  } catch (e: any) {
    res.status(400).json({ error: e.message });
  }
});

function getSession(id: string, res: express.Response) {
  const s = sessions.get(id);
  if (!s) res.status(404).json({ error: "session not found" });
  return s;
}

app.get("/api/sessions/:id/events", (req, res) => {
  const s = getSession(req.params.id, res);
  if (!s) return;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const send = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
  const release = sessions.subscribe(s.id);
  for (const e of s.events) send(e);
  s.on("event", send);
  const ping = setInterval(() => res.write(": ping\n\n"), 15000);
  req.on("close", () => {
    clearInterval(ping);
    s.off("event", send);
    release();
  });
});

app.post("/api/sessions/:id/next", (req, res) => {
  const s = getSession(req.params.id, res);
  if (!s) return;
  if (s.isClosed) { res.status(410).json({ error: "セッションは中断されています。差分を選び直してください。" }); return; }
  s.next();
  res.json({ ok: true });
});

app.get("/api/sessions/:id/files/:fileId", async (req, res) => {
  const s = getSession(req.params.id, res);
  if (!s) return;
  const rows = s.getFileRows(req.params.fileId);
  if (!rows) { res.status(404).json({ error: "file not found" }); return; }
  try {
    res.json({ rows: await rows });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

app.post("/api/sessions/:id/questions", (req, res) => {
  const s = getSession(req.params.id, res);
  if (!s) return;
  const { text, mode, afterStep } = req.body as { text: string; mode: "now" | "later"; afterStep?: number };
  if (!text?.trim()) {
    res.status(400).json({ error: "empty question" });
    return;
  }
  try {
    if (!s.ask(text.trim(), mode === "later" ? "later" : "now", afterStep)) {
      res.status(410).json({ error: "セッションは中断されています。差分を選び直してください。" });
      return;
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    res.status(400).json({ error: error.message });
    return;
  }
  res.json({ ok: true });
});

app.delete("/api/sessions/:id", (req, res) => {
  const s = getSession(req.params.id, res);
  if (!s) return;
  sessions.delete(s.id);
  res.json({ ok: true });
});

const dist = path.resolve(__dirname, "../dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const port = Number(process.env.PORT || 4777);
const server = app.listen(port, "127.0.0.1", () => {
  const address = server.address();
  const boundPort = address && typeof address !== "string" ? address.port : port;
  console.log(`xpl running at http://localhost:${boundPort}  (repo: ${defaultRepo})`);
});

const shutdown = () => {
  sessions.close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

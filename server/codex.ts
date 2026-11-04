import type { ChildProcessWithoutNullStreams } from "node:child_process";
import spawn from "cross-spawn";
import { createInterface } from "node:readline";
import { z } from "zod";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

/** The connection is usable again after a completed, unsuccessful turn. */
export class CodexTurnError extends Error {}

/** A private stdio app-server connection; authentication stays with the Codex CLI. */
export class CodexAgent {
  private process?: ChildProcessWithoutNullStreams;
  private pending = new Map<number, Pending>();
  private sequence = 0;
  private threadId?: string;
  private active?: { resolve: () => void; reject: (error: Error) => void };
  private stopped = false;
  private stderr = "";

  constructor(private options: {
    cwd: string;
    model?: string;
    instructions: string;
    tools: SdkMcpToolDefinition<any>[];
    onActivity: (text: string) => void;
    onError: (error: Error) => void;
  }) {}

  async start() {
    const env = { ...process.env };
    if (!process.env.XPL_USE_API_KEY) {
      delete env.OPENAI_API_KEY;
      delete env.CODEX_API_KEY;
    }
    const child = this.process = spawn(process.env.XPL_CODEX_PATH || "codex", ["app-server"], {
      cwd: this.options.cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    }) as ChildProcessWithoutNullStreams;
    child.stderr.on("data", (data) => { this.stderr = (this.stderr + data).slice(-4000); });
    child.on("error", (error) => this.fail(new Error(`Codex を起動できません。Codex CLI をインストールして codex login を実行してください。\n${error.message}`)));
    child.stdin.on("error", (error) => this.fail(error));
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      if (!line.trim()) return;
      try {
        const message = JSON.parse(line);
        void this.receive(message).catch((error) => this.fail(error));
      } catch {
        this.fail(new Error("Codex から不正な JSON メッセージを受信しました。"));
      }
    });
    // 'close' runs after stdout is drained, so final protocol errors are kept.
    child.on("close", (code, signal) => {
      lines.close();
      if (!this.stopped) this.fail(new Error(`Codex が終了しました (${signal ?? code})。${this.stderr}`));
    });

    try {
      await this.request("initialize", {
        clientInfo: { name: "xpl", title: "xpl", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      this.send({ method: "initialized", params: {} });

      // External MCP tools are outside the filesystem sandbox. Disable inherited
      // integrations for this thread so this viewer cannot perform remote writes.
      const { config } = await this.request("config/read", { cwd: this.options.cwd });
      const overrides: Record<string, unknown> = { web_search: "disabled", "features.multi_agent": false };
      for (const name of Object.keys(config.mcp_servers ?? {})) overrides[`mcp_servers.${name}.enabled`] = false;
      for (const name of Object.keys(config.plugins ?? {})) overrides[`plugins.${name}.enabled`] = false;
      overrides["features.apps"] = false;

      const result = await this.request("thread/start", {
        cwd: this.options.cwd,
        model: this.options.model,
        approvalPolicy: "never",
        sandbox: "read-only",
        ephemeral: true,
        config: overrides,
        developerInstructions: this.options.instructions,
        dynamicTools: this.options.tools.map((tool) => ({
          type: "function",
          name: tool.name,
          description: tool.description,
          inputSchema: z.toJSONSchema(z.object(tool.inputSchema)),
        })),
      });
      this.threadId = result.thread.id;
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async run(text: string) {
    if (this.stopped || !this.threadId) throw new Error("Codex セッションは終了しています。");
    if (this.active) throw new Error("Codex は前のターンを処理中です。");
    // Register completion before sending: very short turns may finish before
    // the turn/start response is delivered.
    await new Promise<void>((resolve, reject) => {
      const active = this.active = { resolve, reject };
      this.request("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text }],
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly" },
      }).catch((error) => {
        if (this.active === active) this.active = undefined;
        active.reject(error);
      });
    });
  }

  private send(message: unknown) {
    if (this.stopped || !this.process) throw new Error("Codex connection is closed.");
    this.process.stdin.write(JSON.stringify(message) + "\n");
  }

  private request(method: string, params: unknown): Promise<any> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex ${method} がタイムアウトしました。`));
      }, 60_000);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  private async receive(message: any) {
    if (this.stopped) return;
    if (message.method && message.id != null) {
      if (message.method !== "item/tool/call") {
        this.send({ id: message.id, error: { code: -32601, message: "xpl supports only its read-only viewer tools; interactive requests are unavailable." } });
        return;
      }
      const { tool: name, arguments: args, threadId } = message.params;
      let success = false;
      let text: string;
      try {
        if (threadId !== this.threadId) throw new Error("Unexpected Codex thread.");
        const tool = this.options.tools.find((t) => t.name === name);
        if (!tool) throw new Error(`Unknown xpl tool: ${name}`);
        const input = z.object(tool.inputSchema).parse(args);
        const result = await tool.handler(input, {});
        success = !result.isError;
        text = result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
      } catch (error) {
        text = String(error instanceof Error ? error.message : error);
      }
      if (!this.stopped) this.send({ id: message.id, result: { success, contentItems: [{ type: "inputText", text }] } });
    } else if (message.id != null) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    } else if (message.method === "turn/completed" && message.params.threadId === this.threadId) {
      const active = this.active;
      this.active = undefined;
      const turn = message.params.turn;
      if (turn.status === "completed") active?.resolve();
      else active?.reject(new CodexTurnError(turn.error?.message || `Codex turn ${turn.status}`));
    } else if (message.method === "item/started") {
      const item = message.params.item;
      if (item.type === "commandExecution") this.options.onActivity(item.command);
      else if (item.type === "dynamicToolCall" && item.tool === "get_diff") this.options.onActivity("diff を取得中");
    }
  }

  private fail(error: Error) {
    if (this.stopped) return;
    const running = !!this.active;
    this.stop(error);
    if (!running) this.options.onError(error);
  }

  private stop(error: Error) {
    this.stopped = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.active?.reject(error);
    this.active = undefined;
    this.process?.stdin.end();
    this.process?.kill();
  }

  close() {
    if (!this.stopped) this.stop(new Error("Codex セッションを終了しました。"));
  }
}

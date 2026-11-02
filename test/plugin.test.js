import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 集成烟测：用假的 cordis ctx + 假的 Session 驱动真实插件模块，
 * 覆盖「恢复种子回填 → 实时事件折叠 → /usage 命令 → 落盘」全链路。
 */
test("插件端到端：回填、折叠、/usage 命令、落盘", async () => {
	const home = fs.mkdtempSync(path.join(os.tmpdir(), "llm-usage-stats-home-"));
	const previousHome = process.env.DSH_HOME;
	process.env.DSH_HOME = home;
	try {
		const plugin = await import("../lib/index.js");
		assert.equal(plugin.name, "llm-usage-stats");
		assert.deepEqual(plugin.inject, ["sessions"]);
		assert.equal(typeof plugin.apply, "function");

		// ---- 假 ctx ----
		const listeners = new Map();
		const disposers = [];
		let command = null;
		const commandCtx = {
			commands: {
				register(definition) {
					command = definition;
					return () => {};
				}
			},
			effect(execute) {
				const disposer = execute();
				disposers.push(disposer);
				return disposer;
			}
		};
		const ctx = {
			sessions: { list: () => [] },
			on(event, handler) {
				const list = listeners.get(event) ?? [];
				list.push(handler);
				listeners.set(event, list);
				return () => {};
			},
			effect(execute) {
				const disposer = execute();
				disposers.push(disposer);
				return disposer;
			},
			inject(_deps, callback) {
				callback(commandCtx);
				return {};
			}
		};

		// ---- 假会话：种子含恢复的历史（不会发 session/event）----
		const seed = [
			{
				type: "request/header",
				seq: 0,
				time: Date.now(),
				data: { header: { config: { provider: "deepseek", model: "deepseek-chat" } }, reason: "resume" }
			},
			{
				type: "assistant/message",
				seq: 1,
				time: Date.now(),
				data: { usage: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 1000 } }
			}
		];
		const session = {
			id: "sess-1",
			isOwnSeq: () => true,
			requestHeader: () => ({ config: { provider: "deepseek", model: "deepseek-chat" } }),
			snapshotEvents: (from = 0) => seed.concat(live).filter((event) => event.seq >= from)
		};
		const live = [];
		const emit = (event) => {
			live.push(event);
			for (const handler of listeners.get("session/event") ?? []) handler(session, event);
		};

		plugin.apply(ctx);
		for (const handler of listeners.get("session/created") ?? []) handler(session);

		// 实时新事件（seq 2）
		emit({
			type: "assistant/message",
			seq: 2,
			time: Date.now(),
			data: { usage: { inputTokens: 3, outputTokens: 4 } }
		});

		// ---- /usage 命令 ----
		assert.ok(command != null, "/usage 已注册");
		assert.equal(command.name, "usage");
		const invocation = {
			commandId: "usage",
			rawInput: "session",
			agent: { session },
			attachments: [],
			signal: new AbortController().signal
		};
		const result = command.handler(invocation);
		assert.equal(result.kind, "success");
		assert.match(result.text, /deepseek\/deepseek-chat/);
		assert.match(result.text, /合计/);
		// 500+3 输入、50+4 输出、1000 缓存读 → 计费输入 1503、总计 1557
		assert.match(result.text, /1,503/);
		assert.match(result.text, /1,557/);

		const bad = command.handler({ ...invocation, rawInput: "???" });
		assert.equal(bad.kind, "error");
		assert.match(bad.text, /用法/);

		// ---- 落盘 ----
		for (const dispose of disposers) dispose();
		const usageFile = path.join(home, "model-usage", "usage.json");
		assert.ok(fs.existsSync(usageFile), "账本文件已写入");
		const data = JSON.parse(fs.readFileSync(usageFile, "utf8"));
		const counter = data.models["deepseek/deepseek-chat"];
		assert.equal(counter.calls, 2);
		assert.equal(counter.inputTokens, 503);
		assert.equal(counter.outputTokens, 54);
		assert.equal(counter.cacheReadTokens, 1000);

		// ---- 水位持久化：重放不重复计数 ----
		const { UsageStore } = await import("../lib/store.js");
		const reloaded = UsageStore.load(usageFile);
		for (const event of seed.concat(live)) {
			reloaded.observe("sess-1", event, { own: true });
		}
		assert.equal(reloaded.totalsByModel({})["deepseek/deepseek-chat"].calls, 2);
	} finally {
		if (previousHome === undefined) delete process.env.DSH_HOME;
		else process.env.DSH_HOME = previousHome;
		fs.rmSync(home, { recursive: true, force: true });
	}
});

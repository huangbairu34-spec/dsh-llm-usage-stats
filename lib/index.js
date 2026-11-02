/**
 * dsh-llm-usage-stats：按大模型（provider/model）统计 token 用量的 DSH 插件。
 *
 * 数据来源：会话事件流。
 *  - `request/header` → 归因到 call config 的 provider/model（`request/context` 兜底）；
 *  - `assistant/message` 的 `usage`（TokenUsage）→ 计入该模型；
 *  - 每会话事件水位去重：恢复/回放/fork 继承前缀都不重复计数。
 *
 * 持久化：`<DSH home>/model-usage/usage.json`（原子写 + 防抖）。
 * 展示：`/usage` 命令（`/usage session`、`/usage <天数>`）。
 */
import os from "node:os";
import path from "node:path";
import { UsageStore, modelKeyOfConfig } from "./store.js";
import { buildReport, parseUsageArgs } from "./report.js";

const name = "llm-usage-stats";
const inject = ["sessions"];

function expandHome(target) {
	return target.startsWith("~") ? path.join(os.homedir(), target.slice(1)) : target;
}

/** 账本文件位置：`$DSH_HOME`（展开 ~）否则 `~/.dsh` 下的 `model-usage/usage.json`。 */
export function resolveUsageFilePath(env = process.env) {
	const home = typeof env.DSH_HOME === "string" && env.DSH_HOME.trim() !== ""
		? expandHome(env.DSH_HOME.trim())
		: path.join(os.homedir(), ".dsh");
	return path.join(home, "model-usage", "usage.json");
}

function apply(ctx) {
	const logger = typeof ctx.logger === "function" ? ctx.logger("llm-usage-stats") : null;
	const warn = (message, error) => {
		const text = `llm-usage-stats: ${message}: ${String(error?.message ?? error)}`;
		if (logger != null && typeof logger.warn === "function") logger.warn(text);
		else if (typeof console !== "undefined") console.warn(text);
	};

	const store = UsageStore.load(resolveUsageFilePath());

	/** 会话级归因种子：最新 request/header 折叠出的 provider/model。 */
	const seedAttribution = (session) => {
		try {
			return modelKeyOfConfig(session?.requestHeader?.()?.config) ?? undefined;
		} catch {
			return undefined;
		}
	};

	/** 回填会话水位之后的全部事件（恢复的种子日志不会发 session/event，靠这里补）。 */
	const backfill = (session) => {
		try {
			const state = store.sessionState(session.id);
			if (state.attribution == null) {
				const seed = seedAttribution(session);
				if (typeof seed === "string") {
					state.attribution = seed;
					store.markDirty();
				}
			}
			const events = session.snapshotEvents(state.lastSeq + 1);
			for (const event of events) {
				const own = typeof session.isOwnSeq === "function" ? session.isOwnSeq(event.seq) : true;
				store.observe(session.id, event, { own, fallbackAttribution: seedAttribution(session) });
			}
		} catch (error) {
			warn(`回填会话 ${session?.id} 失败`, error);
		}
	};

	/** 折叠单个实时事件；发现水位缺口（热重载/插件停用期间）时先回填补齐。 */
	const fold = (session, event) => {
		try {
			const state = store.sessionState(session.id);
			if (typeof event?.seq === "number" && event.seq > state.lastSeq + 1) backfill(session);
			const own = typeof session.isOwnSeq === "function" ? session.isOwnSeq(event.seq) : true;
			store.observe(session.id, event, { own, fallbackAttribution: seedAttribution(session) });
		} catch (error) {
			warn(`折叠会话 ${session?.id} 事件失败`, error);
		}
	};

	// 启动/热重载：把已在线会话（含恢复的种子日志）补进账本。
	for (const session of ctx.sessions.list()) backfill(session);
	ctx.on("session/created", (session) => backfill(session));
	ctx.on("session/flush", (session) => backfill(session));
	ctx.on("session/event", (session, event) => fold(session, event));

	// 纤维卸载（含 HMR 热重载）前落盘。
	ctx.effect(() => () => {
		if (!store.flush()) warn("写入用量账本失败", new Error(String(store.filePath)));
	}, "llm-usage-stats: flush usage store");

	// /usage 命令：commands 服务到位后注册（stats 统计不依赖它）。
	ctx.inject(["commands"], (commandCtx) => {
		commandCtx.effect(() => commandCtx.commands.register({
			name: "usage",
			description: "按大模型统计 token 用量（provider/model 分类，跨会话累计）",
			input: { hint: "[session | <天数>]" },
			recordInput: false,
			handler: (invocation) => {
				try {
					const request = parseUsageArgs(invocation.rawInput);
					if ("error" in request) return { kind: "error", text: request.error };
					const session = invocation.agent?.session ?? null;
					const report = buildReport(store, request, {
						sessionId: request.mode === "session" ? session?.id ?? null : null,
						sessionLabel: session != null ? String(session.id) : null
					});
					return { kind: "success", text: report };
				} catch (error) {
					return { kind: "error", text: `生成用量报表失败：${String(error?.message ?? error)}` };
				}
			}
		}), "llm-usage-stats: register /usage");
	});
}

export { apply, inject, name };

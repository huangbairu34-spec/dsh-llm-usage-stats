/**
 * 模型用量账本（纯数据折叠，不依赖 DSH 运行时，可独立测试）。
 *
 * 统计口径与 @deepseek-ai/dsh-llm 的 TokenUsage 约定一致：
 * 各计数互斥，inputTokens 只算未缓存输入；计费输入 = inputTokens + cacheReadTokens + cacheWriteTokens；
 * 总 tokens = 计费输入 + outputTokens。调用数 = 携带 usage 的 assistant/message 事件数
 * （即适配器真正报告了计量的模型调用；assistant/attempt 不报告 usage，不计）。
 *
 * 去重模型：每个会话维护一个事件水位 lastSeq，只累计 seq > lastSeq 的自有事件
 * （fork 继承前缀通过 own=false 跳过并推进水位），因此进程重启、会话 resume、
 * 热重载后的事件回放都不会重复计数。
 */
import fs from "node:fs";
import path from "node:path";

export const STORE_VERSION = 1;
export const UNKNOWN_MODEL_KEY = "unknown/unknown";

/** 新建一组空计数。 */
export function emptyCounter() {
	return {
		calls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
		reasoningTokens: 0
	};
}

function addCount(value) {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** 把一次 TokenUsage 记入计数器（只加不减）。 */
export function addUsage(counter, usage) {
	counter.calls += 1;
	counter.inputTokens += addCount(usage?.inputTokens);
	counter.outputTokens += addCount(usage?.outputTokens);
	counter.cacheReadTokens += addCount(usage?.cacheReadTokens);
	counter.cacheWriteTokens += addCount(usage?.cacheWriteTokens);
	counter.reasoningTokens += addCount(usage?.reasoningTokens);
}

/** 把一组计数并入另一组。 */
export function mergeCounter(target, source) {
	target.calls += source.calls ?? 0;
	target.inputTokens += source.inputTokens ?? 0;
	target.outputTokens += source.outputTokens ?? 0;
	target.cacheReadTokens += source.cacheReadTokens ?? 0;
	target.cacheWriteTokens += source.cacheWriteTokens ?? 0;
	target.reasoningTokens += source.reasoningTokens ?? 0;
	return target;
}

/** 派生量：计费输入与总 tokens。 */
export function counterTotals(counter) {
	const billedInput = (counter.inputTokens ?? 0) + (counter.cacheReadTokens ?? 0) + (counter.cacheWriteTokens ?? 0);
	return {
		...counter,
		billedInput,
		totalTokens: billedInput + (counter.outputTokens ?? 0)
	};
}

/**
 * 从 call config（provider/model）或 RequestContext（provider/model）提取归因键。
 * @returns `"provider/model"`，字段缺失或类型不对时返回 null。
 */
export function modelKeyOfConfig(config) {
	if (config == null || typeof config !== "object") return null;
	const provider = typeof config.provider === "string" ? config.provider.trim() : "";
	const model = typeof config.model === "string" ? config.model.trim() : "";
	if (provider.length === 0 || model.length === 0) return null;
	return `${provider}/${model}`;
}

/** 事件时间（Unix epoch 毫秒）→ 本地日期键 `YYYY-MM-DD`。 */
export function dayKey(time) {
	const date = new Date(typeof time === "number" && Number.isFinite(time) ? time : Date.now());
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

function ensureSession(data, sessionId) {
	const key = String(sessionId);
	let state = data.sessions[key];
	if (state == null) state = data.sessions[key] = { lastSeq: -1, attribution: null, models: {} };
	if (typeof state.lastSeq !== "number" || !Number.isFinite(state.lastSeq)) state.lastSeq = -1;
	if (state.models == null || typeof state.models !== "object") state.models = {};
	return state;
}

function ensureCounter(root, key) {
	let counter = root[key];
	if (counter == null) counter = root[key] = emptyCounter();
	return counter;
}

function normalizeCounters(root) {
	if (root == null || typeof root !== "object") return {};
	const out = {};
	for (const [key, value] of Object.entries(root)) {
		const counter = emptyCounter();
		mergeCounter(counter, value ?? {});
		out[key] = counter;
	}
	return out;
}

function cloneCounters(root) {
	const out = {};
	for (const [key, counter] of Object.entries(root)) out[key] = mergeCounter(emptyCounter(), counter);
	return out;
}

/** 跨模型总计。 */
export function sumCounters(countersByKey) {
	const total = emptyCounter();
	for (const counter of Object.values(countersByKey)) mergeCounter(total, counter);
	return total;
}

/**
 * 按 provider/model 累计 token 用量的账本。
 * `filePath` 为 null 时是纯内存账本（用于测试）。
 */
export class UsageStore {
	constructor(filePath, data) {
		this.filePath = filePath;
		this.data = data;
		this.dirty = false;
		this.timer = null;
	}

	static emptyData() {
		return { version: STORE_VERSION, updatedAt: 0, sessions: {}, models: {}, days: {} };
	}

	/** 从磁盘载入；文件缺失或损坏时返回空账本（不抛出）。 */
	static load(filePath) {
		let data = null;
		try {
			const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
			if (parsed != null && typeof parsed === "object" && parsed.version === STORE_VERSION) {
				data = UsageStore.emptyData();
				data.updatedAt = typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0;
				data.models = normalizeCounters(parsed.models);
				for (const [day, models] of Object.entries(parsed.days ?? {})) data.days[day] = normalizeCounters(models);
				for (const [id, state] of Object.entries(parsed.sessions ?? {})) {
					const normalized = ensureSession(data, id);
					normalized.lastSeq = typeof state?.lastSeq === "number" ? state.lastSeq : -1;
					normalized.attribution = typeof state?.attribution === "string" ? state.attribution : null;
					normalized.models = normalizeCounters(state?.models);
				}
			}
		} catch {
			// 缺失或损坏：重新开始累计。
		}
		return new UsageStore(filePath, data ?? UsageStore.emptyData());
	}

	/** 取（必要时创建）一个会话的折叠状态。 */
	sessionState(sessionId) {
		return ensureSession(this.data, sessionId);
	}

	/**
	 * 折叠一个会话事件。
	 * @param sessionId - 会话 id。
	 * @param event - `{ type, seq, time, data }`（SessionEvent 结构）。
	 * @param options.own - 该事件是否属于本会话自有历史（fork 继承前缀为 false）。
	 * @param options.fallbackAttribution - 会话尚无归因时的初始 `"provider/model"`。
	 * @returns 是否产生了新的用量计数（即是否需要持久化）。
	 */
	observe(sessionId, event, options = {}) {
		const state = ensureSession(this.data, sessionId);
		const seq = typeof event?.seq === "number" ? event.seq : Number.NaN;
		if (!Number.isFinite(seq)) return false;
		if (state.attribution == null && typeof options.fallbackAttribution === "string") {
			state.attribution = options.fallbackAttribution;
			this.markDirty();
		}
		if (options.own === false) {
			// fork 继承的历史已计入父会话，跳过但推进水位。
			if (seq > state.lastSeq) {
				state.lastSeq = seq;
				this.markDirty();
			}
			return false;
		}
		if (seq <= state.lastSeq) return false; // 已计数（重启/resume/热重载后的回放不重复计）
		state.lastSeq = seq;
		this.markDirty();
		switch (event.type) {
			case "request/header": {
				// 归因权威来源：会话 call config（provider/model）。
				const key = modelKeyOfConfig(event.data?.header?.config);
				if (key != null && key !== state.attribution) {
					state.attribution = key;
					this.markDirty();
				}
				break;
			}
			case "request/context": {
				// 路由元数据：仅在尚无 header 归因时兜底。
				if (state.attribution == null) {
					const key = modelKeyOfConfig(event.data);
					if (key != null) {
						state.attribution = key;
						this.markDirty();
					}
				}
				break;
			}
			case "assistant/message": {
				const usage = event.data?.usage;
				if (usage == null || typeof usage !== "object") break;
				const key = state.attribution ?? UNKNOWN_MODEL_KEY;
				addUsage(ensureCounter(this.data.models, key), usage);
				addUsage(ensureCounter(state.models, key), usage);
				const day = this.data.days[dayKey(event.time)] ??= {};
				addUsage(ensureCounter(day, key), usage);
				return true;
			}
			default:
				break;
		}
		return false;
	}

	/**
	 * 按模型汇总。
	 * @param options.sessionId - 只看某个会话。
	 * @param options.since / options.until - 日期键闭区间（`YYYY-MM-DD`），只看该区间内的日桶。
	 * @returns `{ "provider/model": counter }` 的副本。
	 */
	totalsByModel({ sessionId = null, since = null, until = null } = {}) {
		if (sessionId != null) {
			const state = this.data.sessions[String(sessionId)];
			return state == null ? {} : cloneCounters(state.models);
		}
		if (since == null && until == null) return cloneCounters(this.data.models);
		const out = {};
		for (const [day, models] of Object.entries(this.data.days)) {
			if (since != null && day < since) continue;
			if (until != null && day > until) continue;
			for (const [key, counter] of Object.entries(models)) {
				mergeCounter(ensureCounter(out, key), counter);
			}
		}
		return out;
	}

	/**
	 * 按日汇总（区间内每日跨模型合计），按日期升序。
	 * @returns `[{ day, counter }]`。
	 */
	dailyTotals({ since = null, until = null } = {}) {
		const rows = [];
		for (const day of Object.keys(this.data.days).sort()) {
			if (since != null && day < since) continue;
			if (until != null && day > until) continue;
			rows.push({ day, counter: sumCounters(this.data.days[day]) });
		}
		return rows;
	}

	/** 已累计的会话数。 */
	sessionCount() {
		return Object.keys(this.data.sessions).length;
	}

	/** 标记脏数据并安排一次防抖写盘（500ms）。 */
	markDirty() {
		this.dirty = true;
		if (this.timer == null && this.filePath != null) {
			this.timer = setTimeout(() => {
				this.timer = null;
				this.flush();
			}, 500);
			this.timer.unref?.();
		}
	}

	/**
	 * 立即写盘（原子：临时文件 + rename）。
	 * @returns 是否成功（无改动、或纯内存账本也算成功）。
	 */
	flush() {
		if (!this.dirty || this.filePath == null) return true;
		try {
			fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
			this.data.updatedAt = Date.now();
			const tmp = `${this.filePath}.tmp-${process.pid}`;
			fs.writeFileSync(tmp, `${JSON.stringify(this.data, null, "\t")}\n`, "utf8");
			fs.renameSync(tmp, this.filePath);
			this.dirty = false;
			return true;
		} catch {
			this.dirty = true;
			return false;
		}
	}
}

/**
 * 用量报表：把 UsageStore 的计数渲染成等宽中文表格文本。
 * 纯函数，不依赖 DSH 运行时。
 */
import { counterTotals, dayKey, emptyCounter, mergeCounter, sumCounters } from "./store.js";

/** 千分位分组。 */
export function group(n) {
	const value = Math.round(Number.isFinite(n) ? n : 0);
	return String(Math.abs(value)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const WIDE = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe6f\uff00-\uff60\ufe00-\ufe6f]/gu;

/** 终端显示宽度（CJK 宽字符按 2 计）。 */
export function displayWidth(text) {
	let width = 0;
	for (const char of String(text)) {
		WIDE.lastIndex = 0;
		width += WIDE.test(char) ? 2 : 1;
	}
	return width;
}

function pad(text, width, align) {
	const fill = " ".repeat(Math.max(0, width - displayWidth(text)));
	return align === "right" ? `${fill}${text}` : `${text}${fill}`;
}

/**
 * 渲染等宽表格。
 * @param columns - `[{ title, align? }]`。
 * @param rows - 每行是与 columns 对齐的字符串数组。
 */
export function renderTable(columns, rows) {
	const widths = columns.map((column, i) =>
		Math.max(displayWidth(column.title), ...rows.map((row) => displayWidth(row[i] ?? "")))
	);
	const line = (cells) => `| ${cells.map((cell, i) => pad(cell, widths[i], columns[i].align)).join(" | ")} |`;
	const separator = `|${widths.map((width) => "-".repeat(width + 2)).join("|")}|`;
	return [
		line(columns.map((column) => column.title)),
		separator,
		...rows.map((row) => line(row.map((cell) => String(cell ?? ""))))
	].join("\n");
}

const MODEL_COLUMNS = [
	{ title: "模型 (provider/model)" },
	{ title: "调用", align: "right" },
	{ title: "输入", align: "right" },
	{ title: "缓存读", align: "right" },
	{ title: "缓存写", align: "right" },
	{ title: "输出", align: "right" },
	{ title: "推理", align: "right" },
	{ title: "计费输入", align: "right" },
	{ title: "总计", align: "right" }
];

const DAY_COLUMNS = [
	{ title: "日期" },
	{ title: "调用", align: "right" },
	{ title: "输入", align: "right" },
	{ title: "缓存读", align: "right" },
	{ title: "缓存写", align: "right" },
	{ title: "输出", align: "right" },
	{ title: "总计", align: "right" }
];

function modelRow(key, counter) {
	const totals = counterTotals(counter);
	return [
		key,
		group(totals.calls),
		group(totals.inputTokens),
		group(totals.cacheReadTokens),
		group(totals.cacheWriteTokens),
		group(totals.outputTokens),
		group(totals.reasoningTokens),
		group(totals.billedInput),
		group(totals.totalTokens)
	];
}

function totalsRow(counter) {
	const row = modelRow("合计", counter);
	return row;
}

/** 按总计降序的按模型表格（含合计行）。 */
export function modelTable(countersByKey) {
	const entries = Object.entries(countersByKey)
		.map(([key, counter]) => ({ key, counter, total: counterTotals(counter).totalTokens }))
		.sort((a, b) => b.total - a.total || a.key.localeCompare(b.key));
	const rows = entries.map(({ key, counter }) => modelRow(key, counter));
	rows.push(totalsRow(sumCounters(countersByKey)));
	return renderTable(MODEL_COLUMNS, rows);
}

function dayRow(day, counter) {
	const totals = counterTotals(counter);
	return [
		day,
		group(totals.calls),
		group(totals.inputTokens),
		group(totals.cacheReadTokens),
		group(totals.cacheWriteTokens),
		group(totals.outputTokens),
		group(totals.totalTokens)
	];
}

/** 按日表格（升序，含合计行）。 */
export function dayTable(dailyRows) {
	const rows = dailyRows.map(({ day, counter }) => dayRow(day, counter));
	const total = emptyCounter();
	for (const { counter } of dailyRows) mergeCounter(total, counter);
	rows.push([`合计（${dailyRows.length} 天）`, group(total.calls), group(total.inputTokens), group(total.cacheReadTokens), group(total.cacheWriteTokens), group(total.outputTokens), group(counterTotals(total).totalTokens)]);
	return renderTable(DAY_COLUMNS, rows);
}

/**
 * 解析 /usage 的参数。
 * @returns `{ mode: 'global' } | { mode: 'session' } | { mode: 'days', days: number } | { error: string }`
 */
export function parseUsageArgs(rawInput) {
	const text = String(rawInput ?? "").trim();
	if (text === "") return { mode: "global" };
	if (/^(session|s|当前|当前会话)$/i.test(text)) return { mode: "session" };
	const match = /^(?:days?|last|天)?\s*(\d{1,4})$/i.exec(text);
	if (match != null) {
		const days = Number.parseInt(match[1], 10);
		if (days >= 1) return { mode: "days", days };
	}
	return { error: `无法解析参数「${text}」。用法：/usage（全部）｜ /usage session（当前会话）｜ /usage <天数>（最近 N 天）` };
}

function dateWindow(days, now) {
	const until = dayKey(now);
	const since = dayKey(now - (days - 1) * 86_400_000);
	return { since, until };
}

/**
 * 构建报表文本。
 * @param store - UsageStore。
 * @param request - parseUsageArgs 的结果。
 * @param options.sessionId / options.sessionLabel - session 模式的目标会话。
 * @param options.now - 测试用时间锚点（epoch ms）。
 */
export function buildReport(store, request, { sessionId = null, sessionLabel = null, now = Date.now() } = {}) {
	if ("error" in request) return request.error;
	const lines = [];
	if (request.mode === "session") {
		if (sessionId == null) return "无法确定当前会话。";
		const counters = store.totalsByModel({ sessionId });
		lines.push(`══ 模型用量 · 会话 ${sessionLabel ?? sessionId} ══`);
		if (Object.keys(counters).length === 0) {
			lines.push("（该会话尚无已计量的模型调用；usage 未被适配器报告的调用不计入）");
		} else {
			lines.push(modelTable(counters));
		}
		return lines.join("\n");
	}
	if (request.mode === "days") {
		const { since, until } = dateWindow(request.days, now);
		lines.push(`══ 模型用量 · 最近 ${request.days} 天（${since} ~ ${until}）══`);
		const counters = store.totalsByModel({ since, until });
		if (Object.keys(counters).length === 0) {
			lines.push("（该区间内没有已计量的模型调用）");
		} else {
			lines.push(modelTable(counters));
			lines.push("");
			lines.push(dayTable(store.dailyTotals({ since, until })));
		}
		return lines.join("\n");
	}
	// global
	const counters = store.totalsByModel({});
	lines.push("══ 模型用量 · 全部时间 ══");
	if (Object.keys(counters).length === 0) {
		lines.push("（尚无已计量的模型调用；本插件自安装起开始累计）");
	} else {
		lines.push(modelTable(counters));
	}
	lines.push("");
	const week = dateWindow(7, now);
	lines.push(`── 最近 7 天（${week.since} ~ ${week.until}）──`);
	const daily = store.dailyTotals(week);
	lines.push(daily.length === 0 ? "（该区间内没有已计量的模型调用）" : dayTable(daily));
	lines.push("");
	lines.push(`已累计会话数：${group(store.sessionCount())}`);
	return lines.join("\n");
}

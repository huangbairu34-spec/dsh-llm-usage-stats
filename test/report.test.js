import assert from "node:assert/strict";
import { test } from "node:test";
import { UsageStore, dayKey } from "../lib/store.js";
import { buildReport, displayWidth, group, modelTable, parseUsageArgs, renderTable } from "../lib/report.js";

const T0 = Date.UTC(2026, 0, 5, 4, 0, 0);
const T1 = T0 + 86_400_000;

function seededStore() {
	const store = UsageStore.load(null);
	store.observe("s1", {
		type: "request/header",
		seq: 0,
		time: T0,
		data: { header: { config: { provider: "deepseek", model: "deepseek-chat" } }, reason: "initial" }
	}, {});
	store.observe("s1", {
		type: "assistant/message",
		seq: 1,
		time: T0,
		data: { usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 40000, cacheWriteTokens: 1500 } }
	}, {});
	store.observe("s1", {
		type: "assistant/message",
		seq: 2,
		time: T1,
		data: { usage: { inputTokens: 800, outputTokens: 200 } }
	}, {});
	return store;
}

test("parseUsageArgs 语法", () => {
	assert.deepEqual(parseUsageArgs(""), { mode: "global" });
	assert.deepEqual(parseUsageArgs("   "), { mode: "global" });
	assert.deepEqual(parseUsageArgs("session"), { mode: "session" });
	assert.deepEqual(parseUsageArgs("S"), { mode: "session" });
	assert.deepEqual(parseUsageArgs("当前会话"), { mode: "session" });
	assert.deepEqual(parseUsageArgs("7"), { mode: "days", days: 7 });
	assert.deepEqual(parseUsageArgs("days 3"), { mode: "days", days: 3 });
	assert.deepEqual(parseUsageArgs("天 30"), { mode: "days", days: 30 });
	assert.equal("error" in parseUsageArgs("abc"), true);
	assert.equal("error" in parseUsageArgs("0"), true);
	assert.equal("error" in parseUsageArgs("-3"), true);
});

test("group 千分位与 displayWidth CJK 双宽", () => {
	assert.equal(group(1234567), "1,234,567");
	assert.equal(group(999), "999");
	assert.equal(displayWidth("模型"), 4);
	assert.equal(displayWidth("ab"), 2);
	assert.equal(displayWidth("模型 a"), 6);
});

test("renderTable 行宽一致", () => {
	const table = renderTable([{ title: "模型" }, { title: "调用", align: "right" }], [
		["deepseek/deepseek-chat", "12"],
		["x/y", "1"]
	]);
	const widths = table.split("\n").map((line) => displayWidth(line));
	assert.equal(new Set(widths).size, 1);
	assert.match(table, /deepseek\/deepseek-chat/);
});

test("modelTable 含合计行并按总计降序", () => {
	const counters = {
		"small/model": { calls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 },
		"big/model": { calls: 2, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cacheWriteTokens: 5, reasoningTokens: 7 }
	};
	const table = modelTable(counters);
	const lines = table.split("\n");
	assert.ok(lines[2].startsWith("| big/model"));
	assert.ok(lines[3].startsWith("| small/model"));
	assert.ok(lines[4].startsWith("| 合计"));
	assert.match(table, /165/); // big/model 总计 100+50+10+5
	assert.match(table, /2/);
});

test("buildReport 全部时间：按模型表 + 近 7 天表 + 会话数", () => {
	const store = seededStore();
	const report = buildReport(store, parseUsageArgs(""), { now: T1 });
	assert.match(report, /全部时间/);
	assert.match(report, /deepseek\/deepseek-chat/);
	assert.match(report, /最近 7 天/);
	assert.match(report, /已累计会话数：1/);
});

test("buildReport 区间模式只统计区间内", () => {
	const store = seededStore();
	const report = buildReport(store, { mode: "days", days: 1 }, { now: T1 });
	assert.match(report, new RegExp(dayKey(T1)));
	assert.match(report, /最近 1 天/);
	const lines = report.split("\n");
	// 只应出现 T1 当天的用量行（800/200），不应含 40000 缓存读
	assert.ok(!report.includes("40,000"));
	assert.ok(lines.length > 3);
});

test("buildReport 会话模式", () => {
	const store = seededStore();
	const report = buildReport(store, { mode: "session" }, { sessionId: "s1", sessionLabel: "s1", now: T1 });
	assert.match(report, /会话 s1/);
	assert.match(report, /deepseek\/deepseek-chat/);
	const empty = buildReport(UsageStore.load(null), { mode: "session" }, { sessionId: "none" });
	assert.match(empty, /尚无已计量/);
	const noSession = buildReport(store, { mode: "session" }, {});
	assert.equal(noSession, "无法确定当前会话。");
});

test("buildReport 空账本给出提示", () => {
	const report = buildReport(UsageStore.load(null), parseUsageArgs(""), { now: T0 });
	assert.match(report, /尚无已计量的模型调用/);
});

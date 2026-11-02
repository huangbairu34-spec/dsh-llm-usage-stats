import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
	UsageStore,
	UNKNOWN_MODEL_KEY,
	addUsage,
	counterTotals,
	dayKey,
	emptyCounter,
	modelKeyOfConfig,
	sumCounters
} from "../lib/store.js";

const T0 = Date.UTC(2026, 0, 5, 4, 0, 0); // 固定锚点
const T1 = T0 + 3 * 86_400_000;

function headerEvent(seq, provider, model, time) {
	return {
		type: "request/header",
		seq,
		time,
		data: { header: { config: { provider, model } }, reason: "initial" }
	};
}

function usageEvent(seq, usage, time) {
	return {
		type: "assistant/message",
		seq,
		time,
		data: { turn: 1, step: 1, message: { role: "assistant" }, stream: [], usage }
	};
}

test("按 header 归因并累计 usage", () => {
	const store = UsageStore.load(null);
	assert.equal(store.observe("s1", headerEvent(0, "deepseek", "deepseek-chat", T0), {}), false);
	const changed = store.observe(
		"s1",
		usageEvent(1, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 300, cacheWriteTokens: 5 }, T0),
		{}
	);
	assert.equal(changed, true);
	const counters = store.totalsByModel({});
	assert.deepEqual(Object.keys(counters), ["deepseek/deepseek-chat"]);
	const totals = counterTotals(counters["deepseek/deepseek-chat"]);
	assert.equal(totals.calls, 1);
	assert.equal(totals.inputTokens, 100);
	assert.equal(totals.outputTokens, 20);
	assert.equal(totals.cacheReadTokens, 300);
	assert.equal(totals.cacheWriteTokens, 5);
	assert.equal(totals.billedInput, 405);
	assert.equal(totals.totalTokens, 425);
});

test("水位去重：同一事件重复折叠不重复计数（重启/回放场景）", () => {
	const store = UsageStore.load(null);
	store.observe("s1", headerEvent(0, "openai", "gpt-5", T0), {});
	const event = usageEvent(1, { inputTokens: 10, outputTokens: 2 }, T0);
	assert.equal(store.observe("s1", event, {}), true);
	assert.equal(store.observe("s1", event, {}), false);
	assert.equal(store.observe("s1", usageEvent(1, { inputTokens: 999, outputTokens: 999 }, T0), {}), false);
	const totals = counterTotals(store.totalsByModel({})["openai/gpt-5"]);
	assert.equal(totals.calls, 1);
	assert.equal(totals.inputTokens, 10);
});

test("切换模型：后续 header 改变归因", () => {
	const store = UsageStore.load(null);
	store.observe("s1", headerEvent(0, "deepseek", "deepseek-chat", T0), {});
	store.observe("s1", usageEvent(1, { inputTokens: 10, outputTokens: 1 }, T0), {});
	store.observe("s1", headerEvent(2, "anthropic", "claude-sonnet-4-5", T0), {});
	store.observe("s1", usageEvent(3, { inputTokens: 7, outputTokens: 3 }, T0), {});
	const counters = store.totalsByModel({});
	assert.equal(counterTotals(counters["deepseek/deepseek-chat"]).calls, 1);
	assert.equal(counterTotals(counters["anthropic/claude-sonnet-4-5"]).calls, 1);
});

test("无 header 时用 fallback 归因；完全没有归因时归入 unknown", () => {
	const store = UsageStore.load(null);
	store.observe("s1", usageEvent(0, { inputTokens: 1, outputTokens: 1 }, T0), { fallbackAttribution: "mistral/large" });
	store.observe("s2", usageEvent(0, { inputTokens: 1, outputTokens: 1 }, T0), {});
	const counters = store.totalsByModel({});
	assert.equal(counterTotals(counters["mistral/large"]).calls, 1);
	assert.equal(counterTotals(counters[UNKNOWN_MODEL_KEY]).calls, 1);
});

test("fork 继承前缀（own=false）不计数但推进水位", () => {
	const store = UsageStore.load(null);
	assert.equal(
		store.observe("child", usageEvent(0, { inputTokens: 50, outputTokens: 5 }, T0), { own: false }),
		false
	);
	assert.equal(store.observe("child", usageEvent(1, { inputTokens: 1, outputTokens: 1 }, T0), { own: false }), false);
	// 自有事件照常计数，且 seq 0/1 不会再被计入
	assert.equal(store.observe("child", usageEvent(2, { inputTokens: 3, outputTokens: 1 }, T0), {}), true);
	const counters = store.totalsByModel({});
	assert.equal(counterTotals(counters[UNKNOWN_MODEL_KEY]).calls, 1);
	assert.equal(counterTotals(counters[UNKNOWN_MODEL_KEY]).inputTokens, 3);
	assert.equal(store.totalsByModel({ sessionId: "child" })[UNKNOWN_MODEL_KEY].inputTokens, 3);
});

test("无 usage 的 assistant/message 不计数但推进水位", () => {
	const store = UsageStore.load(null);
	assert.equal(store.observe("s1", usageEvent(0, undefined, T0), {}), false);
	assert.equal(store.observe("s1", usageEvent(0, { inputTokens: 9, outputTokens: 9 }, T0), {}), false);
	assert.deepEqual(store.totalsByModel({}), {});
});

test("按日分桶与日期区间过滤", () => {
	const store = UsageStore.load(null);
	store.observe("s1", headerEvent(0, "deepseek", "deepseek-chat", T0), {});
	store.observe("s1", usageEvent(1, { inputTokens: 10, outputTokens: 2 }, T0), {});
	store.observe("s1", usageEvent(2, { inputTokens: 4, outputTokens: 8 }, T1), {});
	const daily = store.dailyTotals({});
	assert.equal(daily.length, 2);
	assert.equal(daily[0].day, dayKey(T0));
	assert.equal(counterTotals(daily[0].counter).calls, 1);
	assert.equal(daily[1].day, dayKey(T1));
	const sinceT1 = store.totalsByModel({ since: dayKey(T1) });
	assert.equal(counterTotals(sinceT1["deepseek/deepseek-chat"]).outputTokens, 8);
	const untilT0 = store.totalsByModel({ until: dayKey(T0) });
	assert.equal(counterTotals(untilT0["deepseek/deepseek-chat"]).outputTokens, 2);
});

test("持久化往返：落盘后载入不重复计数", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-usage-stats-"));
	const filePath = path.join(dir, "usage.json");
	try {
		const store = UsageStore.load(filePath);
		store.observe("s1", headerEvent(0, "deepseek", "deepseek-chat", T0), {});
		store.observe("s1", usageEvent(1, { inputTokens: 100, outputTokens: 20 }, T0), {});
		assert.equal(store.flush(), true);
		assert.ok(fs.existsSync(filePath));

		const reloaded = UsageStore.load(filePath);
		const counters = reloaded.totalsByModel({});
		assert.equal(counterTotals(counters["deepseek/deepseek-chat"]).totalTokens, 120);
		assert.equal(reloaded.sessionCount(), 1);
		// 恢复后的回放（同 seq）被水位挡掉
		assert.equal(reloaded.observe("s1", usageEvent(1, { inputTokens: 100, outputTokens: 20 }, T0), {}), false);
		// 新事件继续累计
		assert.equal(reloaded.observe("s1", usageEvent(2, { inputTokens: 1, outputTokens: 1 }, T0), {}), true);
		assert.equal(counterTotals(reloaded.totalsByModel({})["deepseek/deepseek-chat"]).calls, 2);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("损坏的账本文件安全地重新开始", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-usage-stats-"));
	const filePath = path.join(dir, "usage.json");
	try {
		fs.writeFileSync(filePath, "{ not json", "utf8");
		const store = UsageStore.load(filePath);
		assert.deepEqual(store.totalsByModel({}), {});
		assert.equal(store.observe("s1", usageEvent(0, { inputTokens: 1, outputTokens: 1 }, T0), {}), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("modelKeyOfConfig 严格校验", () => {
	assert.equal(modelKeyOfConfig({ provider: "a", model: "b" }), "a/b");
	assert.equal(modelKeyOfConfig({ provider: " a ", model: " b " }), "a/b");
	assert.equal(modelKeyOfConfig({ provider: "a" }), null);
	assert.equal(modelKeyOfConfig({ model: "b" }), null);
	assert.equal(modelKeyOfConfig({ provider: 1, model: "b" }), null);
	assert.equal(modelKeyOfConfig(null), null);
});

test("addUsage/sumCounters 只接受正数计数", () => {
	const counter = emptyCounter();
	addUsage(counter, { inputTokens: -5, outputTokens: 2.7, cacheReadTokens: Number.NaN });
	assert.equal(counter.inputTokens, 0);
	assert.equal(counter.outputTokens, 2);
	assert.equal(counter.cacheReadTokens, 0);
	assert.equal(counter.calls, 1);
	const total = sumCounters({ a: counter, b: counter });
	assert.equal(total.outputTokens, 4);
});

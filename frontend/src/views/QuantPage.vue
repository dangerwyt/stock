<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useSnapshot } from "@/composables/useSnapshot";
import { http, fetchSnapshot } from "@/api/client";
import { useAppStore } from "@/stores/snapshot";
import StatusBadge from "@/components/StatusBadge.vue";
import BacktestBoard from "@/components/BacktestBoard.vue";
import ConceptBoard from "@/components/ConceptBoard.vue";
import FinancialBoard from "@/components/FinancialBoard.vue";
import TeacherStrategyBoard from "@/components/TeacherStrategyBoard.vue";
import WatchlistBoard from "@/components/WatchlistBoard.vue";
import MarketBoard from "@/components/MarketBoard.vue";
import { hydrateStock } from "@/utils/format";
import {
  IconActivity,
  IconFileAnalytics,
  IconChartCandle,
  IconBell,
  IconStar,
  IconTargetArrow,
  IconShieldCheck,
  IconBriefcase2,
  IconX,
  IconCircleCheck,
  IconBrain,
  IconAlertTriangle,
} from "@tabler/icons-vue";

const route = useRoute();
const router = useRouter();
const { data: accuracy } = useSnapshot("/api/accuracy", { refreshMs: 60000 });
const { data: top50Snapshot, state: top50State, reload: reloadTop50 } = useSnapshot("/api/top50", {
  refreshMs: 300000,
});
// 全局自选股（localStorage 持久化，与侧边栏/自选组合/单股决策弹窗同源）。
const store = useAppStore();

// 票数分母 = 用户自己创建的老师总数（引擎 meta.teacherCount）。原来写死 12，
// 但内置 12 位是原版 mock 人设，已从产品里去掉；没有自建老师时兜 1，避免除零。
const teacherCount = computed(
  () => Number(top50Snapshot.value?.meta?.teacherCount) || 1,
);
const quantToolTabs = [
  { id: "market", label: "市场看板", icon: IconActivity },
  { id: "analysis", label: "分析", icon: IconFileAnalytics },
  { id: "strategy", label: "策略", icon: IconBrain },
  { id: "backtest", label: "回测", icon: IconChartCandle },
  { id: "financial", label: "财务分析", icon: IconFileAnalytics },
  { id: "screener", label: "自选", icon: IconStar },
  { id: "simulation", label: "模拟", icon: IconBriefcase2 },
];

// tab 初始值来自 ?tool=（决策弹窗「模拟交易」直达模拟 tab）；非法值回落行情。
const validTools = quantToolTabs.map((t) => t.id);
const tool = ref(
  validTools.includes(route.query.tool) ? route.query.tool : "market",
);
const cycle = ref("波段");
const stockCode = ref("");
// 结果按 tab 分别缓存：切换 tab 时不清空，切回来还能看到上次的真实结果。
// （原实现每次 switchTool 都把 toolResult 置 null，导致来回切就重跑、丢数据。）
const resultsByTool = ref({});
const toolResult = computed({
  get: () => resultsByTool.value[tool.value] ?? null,
  set: (val) => {
    resultsByTool.value = { ...resultsByTool.value, [tool.value]: val };
  },
});
// 反馈文案同样按 tab 存，切回来时显示它自己的那条。
const feedbacksByTool = ref({});
const currentFeedback = computed(
  () => feedbacksByTool.value[tool.value] || "",
);
function setFeedback(text, target = tool.value) {
  feedbacksByTool.value = { ...feedbacksByTool.value, [target]: text };
}
const quantity = ref(100);
// 手动成交价（可选）：留空 / 0 时按当前行情价成交，填了就按该价成交。
// 纯输入态，不影响既有按现价成交的逻辑，也不参与持久化。
const fillPrice = ref(null);
const emotion = ref("逻辑驱动");
const accountTab = ref("持仓");
// 模拟账户：单账户（与后端 simulation.json 的 account 分桶对齐，便于以后扩展多账户）。
const accountId = ref("default");
// 初始本金 = 累计盈亏的基准（总资产 - 本金 = 累计盈亏）。
const INITIAL_CAPITAL = 1000000;
// 余额 / 多持仓 / 交易流水 —— 这些原本只在组件内存里，刷新即丢。
const cash = ref(1000000);
// 多持仓：{ [code]: { code, name, quantity, cost } }
const positions = ref({});
// 已实现盈亏：每笔卖出按（卖出价 - 卖出前均价）× 股数 累加。
const realizedPnl = ref(0);
const trades = ref([]);
// 持仓标的的实时报价（code -> quote）：不在 TOP50/自选里时也能拿到真实现价，
// 否则现价会回落成成本价、浮动盈亏恒为 0。
const heldQuotes = ref({});
// 自选股解析：在 TOP50 榜单里的直接复用榜单信息；不在榜单里的异步拉
// /api/stocks/search 补名字，选中后按需拉 /api/stocks/{code}/quote 补实时价
// （与单股决策弹窗同源 —— 榜单外标的没有因子分，只有基础信息+实时行情）。
const watchlistDetails = ref({});
async function resolveWatchlistNames() {
  for (const code of store.watchlist) {
    if (watchlistDetails.value[code]?.name) continue;
    try {
      const d = await fetchSnapshot(
        `/api/stocks/search?q=${encodeURIComponent(code)}`,
      );
      const hit = (d?.items || []).find((i) => i.code === code);
      if (hit) {
        watchlistDetails.value = {
          ...watchlistDetails.value,
          [code]: { ...(watchlistDetails.value[code] || { code }), ...hit },
        };
      }
    } catch {
      // Tushare 不可用时名字先留空，下拉用代码兜底，不阻塞模拟交易。
    }
  }
}
// 选中「榜单外自选股」时补实时价，让模拟买入/卖出按真实快照价成交。
watch(
  stockCode,
  async (code) => {
    if (!code) return;
    const rankedCodes = new Set(
      (top50Snapshot.value?.cycles?.[cycle.value]?.ranking || []).map(
        (s) => s.code,
      ),
    );
    if (rankedCodes.has(code)) return;
    if (watchlistDetails.value[code]?.price != null) return;
    try {
      const q = await fetchSnapshot(
        `/api/stocks/${encodeURIComponent(code)}/quote`,
      );
      if (q?.quote) {
        watchlistDetails.value = {
          ...watchlistDetails.value,
          [code]: {
            ...(watchlistDetails.value[code] || { code }),
            ...q.quote,
          },
        };
      }
    } catch {
      // 行情不可用则价格回落 0，模拟仅作本机记录，不编造价格。
    }
  },
  { immediate: true },
);
watch(() => store.watchlist.slice(), resolveWatchlistNames, { immediate: true });

// 进入页面时从后端读回持久化的模拟账户状态，再给持仓标的拉真实报价；
// 之后每 30s 刷新一次报价，让浮动盈亏跟着行情走。
let quoteTimer = null;
onMounted(async () => {
  await loadSimulation();
  await resolveHeldQuotes();
  quoteTimer = setInterval(() => resolveHeldQuotes(true), 30000);
});
onUnmounted(() => {
  if (quoteTimer) clearInterval(quoteTimer);
});
// 持仓标的集合变化（新买入/清仓）时，补拉新增标的的报价。
watch(
  () => Object.keys(positions.value).join(","),
  () => resolveHeldQuotes(),
);

// 模拟 tab 的标的池 = 当前周期 TOP50 + 自选股（按代码去重）。
// 其它 tab（分析/回测/信号/预判/评估）只能跑 TOP50，见 rankedStockChoices。
const watchlistExtras = computed(() => {
  const rankedCodes = new Set(
    (top50Snapshot.value?.cycles?.[cycle.value]?.ranking || []).map(
      (s) => s.code,
    ),
  );
  const out = [];
  for (const code of store.watchlist) {
    if (rankedCodes.has(code)) continue;
    const d = watchlistDetails.value[code];
    out.push(
      hydrateStock({
        code,
        name: d?.name || code,
        industry: d?.industry || "自选跟踪",
        close: d?.close ?? d?.price,
        pct: d?.pct ?? d?.pct_chg,
        isWatchlist: true,
        rank: null,
        score: null,
        status: null,
      }),
    );
  }
  return out;
});
// stockOptions 是「当前可解析标的」全集：模拟 tab 的持仓/交易显示、trade 取价都从它查。
const stockOptions = computed(() => [
  ...(top50Snapshot.value?.cycles?.[cycle.value]?.ranking || []).map(
    hydrateStock,
  ),
  ...watchlistExtras.value,
]);
// el-select 要显式的 label/value 对（原生 <option> 的插值写法在 EP 里不成立）。
// 周期选项固定 4 个；标的选项跟着冻结榜单走，所以是 computed。
const cycleOptions = ["超短", "短线", "波段", "中长线"];
// 模拟 tab 下拉：TOP50 + 自选股全量。
const stockChoices = computed(() =>
  stockOptions.value.map((item) => ({
    label: `${item.name} ${item.code}`,
    value: item.code,
  })),
);
// 其它 tab（分析/回测/信号/预判/评估）只能跑 TOP50 标的，单独一份，
// 避免把榜单外自选股送进量化引擎（引擎按冻结快照查标的，榜单外会 503）。
const rankedStockChoices = computed(() =>
  (top50Snapshot.value?.cycles?.[cycle.value]?.ranking || []).map((item) => ({
    label: `${item.name} ${item.code}`,
    value: item.code,
  })),
);
watch(
  stockOptions,
  (list) => {
    if (!stockCode.value && list[0]) stockCode.value = list[0].code;
  },
  { immediate: true },
);
const stock = computed(
  () =>
    stockOptions.value.find((i) => i.code === stockCode.value) ||
    stockOptions.value[0] ||
    hydrateStock({}),
);
// 某标的当前价优先级：实时报价 > 榜单/自选快照价 > 成本价（行情不可用时不编造跳变）。
function currentPrice(code) {
  const q = heldQuotes.value[code];
  const qp = q?.price ?? q?.close;
  if (Number.isFinite(qp)) return qp;
  const s = stockOptions.value.find((o) => o.code === code);
  if (s && Number.isFinite(s.price)) return s.price;
  const p = positions.value[code];
  return p && p.quantity ? p.cost / p.quantity : 0;
}
// 持仓列表（按市值降序）：每行带现价、市值、均价、浮动盈亏。
const positionList = computed(() =>
  Object.values(positions.value)
    .filter((p) => p && p.quantity > 0)
    .map((p) => {
      const price = currentPrice(p.code);
      const marketValue = Math.round(p.quantity * price);
      const cost = Number(p.cost) || 0;
      const pnl = marketValue - cost;
      return {
        ...p,
        price,
        marketValue,
        cost,
        avgCost: p.quantity ? cost / p.quantity : 0,
        pnl,
        pnlPct: cost > 0 ? (pnl / cost) * 100 : 0,
      };
    })
    .sort((a, b) => b.marketValue - a.marketValue),
);
const totalPositionValue = computed(() =>
  positionList.value.reduce((s, p) => s + p.marketValue, 0),
);
const totalPositionCost = computed(() =>
  positionList.value.reduce((s, p) => s + p.cost, 0),
);
const unrealizedPnl = computed(
  () => totalPositionValue.value - totalPositionCost.value,
);
const unrealizedPct = computed(() =>
  totalPositionCost.value > 0
    ? (unrealizedPnl.value / totalPositionCost.value) * 100
    : 0,
);
const totalAssets = computed(() => cash.value + totalPositionValue.value);
// 累计盈亏 = 总资产 - 初始本金（恒等于「已实现 + 浮动」）。
const totalPnl = computed(() => totalAssets.value - INITIAL_CAPITAL);
const totalPnlPct = computed(() => (totalPnl.value / INITIAL_CAPITAL) * 100);

async function run(message, requestedTool = tool.value, extra = {}) {
  setFeedback("正在读取冻结因子榜与真实数据源…", requestedTool);
  // 只清「本次要跑的那个 tab」的旧结果，其它 tab 的缓存不受影响。
  resultsByTool.value = { ...resultsByTool.value, [requestedTool]: null };
  try {
    const { data } = await http.post(`/api/quant/${requestedTool}`, {
      stockCode: stock.value.code,
      cycle: cycle.value,
      quantity: quantity.value,
      action: message,
      ...extra,
    });
    resultsByTool.value = {
      ...resultsByTool.value,
      [requestedTool]: data?.result ?? data,
    };
    setFeedback(
      `${message} · 因子画像计算已完成 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`,
      requestedTool,
    );
  } catch (error) {
    setFeedback(
      `量化计算未运行：${error?.response?.data?.reason || error.message}。系统不会用静态结果冒充运行结果。`,
      requestedTool,
    );
  }
}
function localFeedback(message) {
  setFeedback(`${message} · 已持久保存（本机模拟账户）`);
}
// 买入：按选中标的的当前价成交，累加/合并到该标的的持仓。
function buy() {
  const code = stock.value.code;
  const qty = quantity.value;
  // 手动成交价优先；留空/0 → 回落到该标的当前行情价（原有行为）。
  const manual = Number(fillPrice.value);
  const price =
    Number.isFinite(manual) && manual > 0 ? manual : stock.value.price;
  if (!Number.isFinite(price) || price <= 0) {
    localFeedback("该标的暂无有效行情，无法模拟买入");
    return;
  }
  const amount = Math.round(qty * price);
  if (!(amount <= cash.value)) {
    localFeedback("可用资金不足");
    return;
  }
  const prev = positions.value[code];
  const nextQty = (prev?.quantity || 0) + qty;
  const nextCost = (Number(prev?.cost) || 0) + amount;
  positions.value = {
    ...positions.value,
    [code]: { code, name: stock.value.name, quantity: nextQty, cost: nextCost },
  };
  cash.value -= amount;
  trades.value = [
    {
      side: "买入",
      quantity: qty,
      price,
      stock: stock.value.name,
      createdAt: new Date().toISOString(),
      emotion: emotion.value,
    },
    ...trades.value,
  ];
  localFeedback(`模拟买入 ${qty} 股成功`);
  saveSimulation();
}
// 卖出：卖出某标的 qty 股（默认取表单选中标的 + 表单股数）。
function sell(code = stockCode.value, qty = quantity.value, useManual = true) {
  const pos = positions.value[code];
  if (!pos || pos.quantity <= 0) {
    localFeedback("该标的不存在可卖持仓");
    return;
  }
  const sellQty = Math.min(qty, pos.quantity);
  const avg = pos.cost / pos.quantity;
  // 表单卖出可带手动成交价；持仓行「清仓」按现价成交（useManual=false）。
  const manual = useManual ? Number(fillPrice.value) : 0;
  const price =
    Number.isFinite(manual) && manual > 0
      ? manual
      : currentPrice(code) || avg;
  const pnl = Math.round((price - avg) * sellQty);
  cash.value += Math.round(sellQty * price);
  realizedPnl.value += pnl;
  const next = { ...positions.value };
  const remainQty = pos.quantity - sellQty;
  if (remainQty <= 0) {
    delete next[code];
  } else {
    next[code] = { ...pos, quantity: remainQty, cost: pos.cost - avg * sellQty };
  }
  positions.value = next;
  trades.value = [
    {
      side: "卖出",
      quantity: sellQty,
      price,
      stock: pos.name,
      pnl,
      createdAt: new Date().toISOString(),
      emotion: emotion.value,
    },
    ...trades.value,
  ];
  const pnlText = `${pnl >= 0 ? "+" : ""}¥${pnl.toLocaleString()}`;
  localFeedback(`模拟卖出 ${sellQty} 股成功 · 本笔盈亏 ${pnlText}`);
  saveSimulation();
}
// 持仓行「清仓」：把该标的剩余股数一次卖完。
function sellAll(code) {
  const pos = positions.value[code];
  // 清仓按当前行情价成交，忽略「手动成交价」输入。
  if (pos) sell(code, pos.quantity, false);
}
// 模拟账户持久化：每笔交易后把内存态写回后端 simulation.json；
// 挂载时从后端读回，刷新页面 / 重启容器都不丢。
async function saveSimulation() {
  try {
    await http.post("/api/simulation", {
      account: accountId.value,
      initialCapital: INITIAL_CAPITAL,
      cash: cash.value,
      realizedPnl: realizedPnl.value,
      positions: positions.value,
      trades: trades.value,
    });
  } catch (e) {
    // 持久化失败不影响本机模拟交易（降级为内存态），只在控制台提示。
    console.warn("模拟账户持久化失败，仅保留本机会话态：", e?.message || e);
  }
}
async function loadSimulation() {
  try {
    // axios 的响应体在 .data 里（后端返回 {account, state}），不是直接返回 payload。
    const resp = await http.get("/api/simulation", {
      params: { account: accountId.value },
    });
    const s = resp?.data?.state ?? resp?.data;
    if (!s) return;
    cash.value = Number(s.cash ?? 1000000);
    realizedPnl.value = Number(s.realizedPnl ?? 0);
    trades.value = Array.isArray(s.trades) ? s.trades : [];
    // ⚠️ 后端 DEFAULT_STATE 总会补一个空的 positions: {}，所以「非空」才算已有
    // 多持仓结构；否则要回落到旧单持仓字段迁移，否则老数据会被空对象覆盖丢失。
    const hasPositions =
      s.positions &&
      typeof s.positions === "object" &&
      Object.keys(s.positions).length > 0;
    let migrated = false;
    if (hasPositions) {
      positions.value = s.positions;
    } else if (s.heldStock && Number(s.positionQuantity) > 0) {
      // 旧「单持仓」存档迁移：转成 positions 表，保证老数据不丢。
      const code = s.heldStock.code;
      const qty = Number(s.positionQuantity);
      const cost =
        Number(s.positionCost) || qty * (Number(s.heldStock.price) || 0);
      positions.value = {
        [code]: { code, name: s.heldStock.name, quantity: qty, cost },
      };
      migrated = true;
    } else {
      positions.value = {};
    }
    if (s.stockCode) stockCode.value = s.stockCode;
    // 迁移完成后立刻回写，把存档规范成新结构（下次加载不再走迁移分支）。
    if (migrated) saveSimulation();
  } catch {
    // 没有存档（首次运行）或后端不可用：保持默认内存态，不阻塞模拟交易。
  }
}
// 给所有持仓标的拉真实报价：即使标的不在当前 TOP50/自选里，现价也是真实行情，
// 浮动盈亏才有意义（否则现价会回落成成本价 → 盈亏恒为 0）。
async function resolveHeldQuotes(force = false) {
  for (const code of Object.keys(positions.value)) {
    if (!force && heldQuotes.value[code]?.price != null) continue;
    try {
      const q = await fetchSnapshot(
        `/api/stocks/${encodeURIComponent(code)}/quote`,
      );
      if (q?.quote) {
        heldQuotes.value = { ...heldQuotes.value, [code]: q.quote };
      }
    } catch {
      // 行情不可用：现价回落成本价，不阻塞模拟。
    }
  }
}

function switchTool(id) {
  tool.value = id;
  // 离开模拟 tab 时，如果当前选中的是榜单外自选股（其它 tab 的引擎只认 TOP50），
  // 回落到第一只 TOP50，避免把榜单外标的送进量化引擎导致 503。
  if (id !== "simulation") {
    const ranked = rankedStockChoices.value;
    if (!ranked.some((o) => o.value === stockCode.value) && ranked[0]) {
      stockCode.value = ranked[0].value;
    }
  }
  // 🔴 不再清 toolResult / feedback —— 结果与反馈都存在 resultsByTool / feedbacksByTool
  //   里按 tab 取用，来回切换 tab 不丢结果、不重复请求（keep-alive 语义）。
  // URL 与 tab 保持同步：否则「先手点别的 tab、再从弹窗跳同一 tab」时 query 未变化、
  // 路由不去重导航，下面的 watch 不会再触发，tab 会切不过去。
  router.replace({ query: { ...route.query, tool: id } });
}

// 决策弹窗是全局实例（App.vue 挂载），在 /tools 页本身也能打开 —— 所以 ?tool= 变化
// 不能只靠 setup 时读一次，这里同步监听（弹窗「模拟交易」跳转的正式入口）。
watch(
  () => route.query.tool,
  (v) => {
    const next = validTools.includes(v) ? v : "market";
    if (next !== tool.value) switchTool(next);
  },
);

// ?code= 预选标的：弹窗带过来的股票要等冻结榜单（stockChoices）就绪后才能命中，
// 命不中（不在所选周期榜单里）就保持默认第一只，不硬塞进 el-select。
const pendingCode = ref(route.query.code ? String(route.query.code) : "");
watch(
  [stockChoices, () => route.query.code],
  ([choices, c]) => {
    if (c) pendingCode.value = String(c);
    if (
      pendingCode.value &&
      choices.some((o) => o.value === pendingCode.value)
    ) {
      stockCode.value = pendingCode.value;
      pendingCode.value = "";
    }
  },
  { immediate: true },
);
function pctText(v) {
  return `${v >= 0 ? "+" : ""}${v}%`;
}
function fmtMoney(v) {
  return `¥${Number(v || 0).toLocaleString()}`;
}
// A 股习惯：盈利红、亏损绿（样式类 price-up 为红、price-down 为绿）。
function pnlClass(v) {
  return v > 0 ? "price-up" : v < 0 ? "price-down" : "";
}
function fmtSignedMoney(v) {
  const n = Number(v || 0);
  const sign = n > 0 ? "+" : n < 0 ? "-" : "";
  return `${sign}¥${Math.abs(n).toLocaleString()}`;
}
function fmtSignedPct(v) {
  const n = Number(v || 0);
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

</script>

<template>
  <div class="simple-page quant-tool-page">
    <div class="quant-tool-tabs" role="tablist" aria-label="量化工具">
      <button
        v-for="t in quantToolTabs"
        :key="t.id"
        role="tab"
        :aria-selected="tool === t.id"
        :class="{ active: tool === t.id }"
        @click="switchTool(t.id)"
      >
        <component :is="t.icon" :size="16" /><span>{{ t.label }}</span>
      </button>
    </div>

    <div v-if="currentFeedback" class="tool-feedback">
      <IconCircleCheck :size="15" /><span>{{ currentFeedback }}</span>
      <button
        aria-label="关闭操作反馈"
        @click="setFeedback('', tool)"
      >
        <IconX :size="14" />
      </button>
    </div>

    <KeepAlive><MarketBoard v-if="tool === 'market'" /></KeepAlive>

    <!-- 分析 -->
    <KeepAlive><ConceptBoard v-if="tool === 'analysis'" /></KeepAlive>
    <KeepAlive><FinancialBoard v-if="tool === 'financial'" /></KeepAlive>
    <KeepAlive><TeacherStrategyBoard v-if="tool === 'strategy'" :snapshot="top50Snapshot" :snapshot-state="top50State" :reload-snapshot="reloadTop50" /></KeepAlive>

    <!-- 回测独立保存参数与结果，切换 tab 不重新拉取历史数据。 -->
    <KeepAlive><BacktestBoard v-if="tool === 'backtest'" :stocks="rankedStockChoices" :cycle="cycle" /></KeepAlive>

    <!-- 信号 -->
    <div v-if="tool === 'signals'" class="tool-workspace">
      <div class="tool-form-row">
        <el-select
          v-model="stockCode"
          class="ep-form-control ep-form-control--stock"
          filterable
          placeholder="选择标的"
          aria-label="选择标的"
          ><el-option
            v-for="s in rankedStockChoices"
            :key="s.value"
            :label="s.label"
            :value="s.value"
        /></el-select>
        <button
          class="primary-button"
          @click="run('风险信号已计算', 'signals')"
        >
          计算真实因子信号
        </button>
      </div>
      <div v-if="!toolResult" class="account-empty">
        <IconBell :size="22" /><strong>运行后显示真实结果</strong>
        <p>读取冻结因子快照后计算分歧。</p>
      </div>
      <section v-else class="panel evaluation-result">
        <div class="evaluation-score">
          <span>因子分歧</span
          ><strong>{{ toolResult.dispersion ?? "--" }}</strong
          ><StatusBadge :status="stock.status" />
        </div>
        <div class="evaluation-dimensions">
          <div
            v-for="[label, score] in Object.entries(
              toolResult.dimensions || {},
            )"
            :key="label"
          >
            <span>{{ label }}</span>
            <div><i :style="{ width: `${score}%` }" /></div>
            <b>{{ Math.round(score) }}</b>
          </div>
        </div>
        <div class="evaluation-actions">
          <div>
            <span>允许动作</span><strong>{{ toolResult.allowedAction }}</strong>
          </div>
          <div>
            <span>禁止动作</span
            ><strong class="negative">{{ toolResult.prohibitedAction }}</strong>
          </div>
        </div>
      </section>
    </div>

    <KeepAlive><WatchlistBoard v-if="tool === 'screener'" :snapshot="top50Snapshot" /></KeepAlive>

    <!-- 预判 -->
    <div v-if="tool === 'predict'" class="tool-workspace predict-workspace">
      <div class="tool-form-row">
        <el-select
          v-model="stockCode"
          class="ep-form-control ep-form-control--stock"
          filterable
          placeholder="选择标的"
          aria-label="选择标的"
          ><el-option
            v-for="s in rankedStockChoices"
            :key="s.value"
            :label="s.label"
            :value="s.value"
        /></el-select>
        <el-select
          v-model="cycle"
          class="ep-form-control ep-form-control--cycle"
          aria-label="持有周期"
          ><el-option v-for="c in cycleOptions" :key="c" :label="c" :value="c"
        /></el-select>
        <button
          class="primary-button"
          @click="run('预判已从冻结TOP50读取', 'predict')"
        >
          生成预判
        </button>
      </div>
      <section class="panel predict-result-card">
        <div class="predict-result-head">
          <div>
            <span>{{ teacherCount }}套因子画像 + AI 风险复核</span>
            <h2>{{ stock.name }} · 短线预判</h2>
          </div>
          <StatusBadge :status="stock.status" />
        </div>
        <div class="predict-probability">
          <div>
            <span>看多因子</span
            ><strong>{{
              Number.isFinite(toolResult?.probabilityUp)
                ? `${Math.round(toolResult.probabilityUp * 100)}/100`
                : "--"
            }}</strong>
          </div>
          <div class="probability-track">
            <i
              :style="{
                width: Number.isFinite(toolResult?.probabilityUp)
                  ? `${toolResult.probabilityUp * 100}%`
                  : '0%',
              }"
            />
            <b
              :style="{
                width: Number.isFinite(toolResult?.probabilityUp)
                  ? `${(1 - toolResult.probabilityUp) * 100}%`
                  : '0%',
              }"
            />
          </div>
          <div>
            <span>反向因子</span
            ><strong>{{
              Number.isFinite(toolResult?.probabilityUp)
                ? `${Math.round((1 - toolResult.probabilityUp) * 100)}/100`
                : "--"
            }}</strong>
          </div>
        </div>
        <div class="predict-levels">
          <div>
            <span>参考入场</span
            ><strong>{{ toolResult?.referencePrice ?? "--" }}</strong>
          </div>
          <div>
            <span>目标区间</span
            ><strong class="price-up">{{
              toolResult?.targetRange || "--"
            }}</strong>
          </div>
          <div>
            <span>失效位置</span
            ><strong class="price-down">{{
              toolResult?.invalidPrice ?? "--"
            }}</strong>
          </div>
          <div>
            <span>真实历史命中率</span
            ><strong
              >{{
                Number.isFinite(accuracy?.overall?.hitRate)
                  ? `${accuracy.overall.hitRate}%`
                  : "--"
              }}
              <small>{{ accuracy?.overall?.sampleCount || 0 }}次</small></strong
            >
          </div>
        </div>
        <p>
          <IconAlertTriangle :size="14" />
          方向因子是规则评分，未经概率校准；只有预先冻结、到达目标交易日且行情完整的预测才计入准确率。
        </p>
      </section>
    </div>

    <!-- 评估 -->
    <div v-if="tool === 'evaluate'" class="tool-workspace evaluate-workspace">
      <div class="tool-form-row">
        <el-select
          v-model="stockCode"
          class="ep-form-control ep-form-control--stock"
          filterable
          placeholder="选择标的"
          aria-label="选择标的"
          ><el-option
            v-for="s in rankedStockChoices"
            :key="s.value"
            :label="s.label"
            :value="s.value"
        /></el-select>
        <button
          class="primary-button"
          @click="run('风险评估已更新', 'evaluate')"
        >
          运行评估
        </button>
      </div>
      <section class="panel evaluation-result">
        <div v-if="!toolResult" class="account-empty">
          <IconShieldCheck :size="22" /><strong>运行后显示真实结果</strong>
          <p>读取冻结评分后输出风险边界。</p>
        </div>
        <template v-else>
          <div class="evaluation-score">
            <span>冻结综合评分</span
            ><strong>{{ toolResult.stock?.score ?? "--" }}</strong
            ><StatusBadge :status="stock.status" />
            <p>
              因子分歧 {{ toolResult.dispersion ?? "--" }}，结果来自当日{{
                teacherCount
              }}套因子画像快照。
            </p>
          </div>
          <div class="evaluation-dimensions">
            <div
              v-for="[label, score] in Object.entries(
                toolResult.dimensions || {},
              )"
              :key="label"
            >
              <span>{{ label }}</span>
              <div><i :style="{ width: `${score}%` }" /></div>
              <b>{{ Math.round(score) }}</b>
            </div>
          </div>
          <div class="evaluation-actions">
            <div>
              <span>允许动作</span
              ><strong>{{ toolResult.allowedAction }}</strong>
            </div>
            <div>
              <span>禁止动作</span
              ><strong class="negative">{{
                toolResult.prohibitedAction
              }}</strong>
            </div>
          </div>
        </template>
      </section>
    </div>

    <!-- 模拟 -->
    <div
      v-if="tool === 'simulation'"
      class="simulation-workspace"
    >
      <header class="sim-heading">
        <div><h1><IconBriefcase2 :size="23" />模拟交易</h1><p>跟踪模拟账户资产、持仓和交易记录</p></div>
        <span class="sim-badge">本机模拟账户</span>
      </header>
      <div class="simulation-summary">
        <div>
          <span>模拟总资产</span><strong>{{ fmtMoney(totalAssets) }}</strong>
        </div>
        <div>
          <span>累计盈亏</span>
          <strong :class="pnlClass(totalPnl)">{{
            fmtSignedMoney(totalPnl)
          }}</strong>
          <small :class="pnlClass(totalPnl)">{{
            fmtSignedPct(totalPnlPct)
          }}</small>
        </div>
        <div>
          <span>浮动盈亏</span>
          <strong :class="pnlClass(unrealizedPnl)">{{
            fmtSignedMoney(unrealizedPnl)
          }}</strong>
          <small :class="pnlClass(unrealizedPnl)">{{
            fmtSignedPct(unrealizedPct)
          }}</small>
        </div>
        <div>
          <span>已实现盈亏</span>
          <strong :class="pnlClass(realizedPnl)">{{
            fmtSignedMoney(realizedPnl)
          }}</strong>
        </div>
        <div>
          <span>模拟可用余额</span><strong>{{ fmtMoney(cash) }}</strong>
        </div>
        <div>
          <span>模拟持仓市值</span
          ><strong>{{ fmtMoney(totalPositionValue) }}</strong>
        </div>
      </div>
      <section class="sim-order-panel">
      <header class="sim-panel-heading"><h2>模拟下单</h2><span>标的来自当前 TOP50 与自选</span></header>
      <div class="simulation-order">
        <label class="sim-field"><span>交易标的</span>
        <el-select
          v-model="stockCode"
          class="ep-form-control ep-form-control--stock"
          filterable
          placeholder="选择标的"
          aria-label="选择标的"
          ><el-option
            v-for="s in stockChoices"
            :key="s.value"
            :label="s.label"
            :value="s.value"
        /></el-select>
        </label>
        <label class="sim-field"><span>交易数量（股）</span>
        <el-input-number
          v-model="quantity"
          :min="100"
          :step="100"
          :precision="0"
          class="ep-form-control ep-form-control--number"
          aria-label="模拟交易股数"
        />
        </label>
        <label class="sim-field"><span>成交价格（元）</span>
        <el-input-number
          v-model="fillPrice"
          :min="0"
          :step="0.01"
          :precision="2"
          :controls="false"
          class="ep-form-control ep-form-control--price"
          placeholder="留空按行情价"
          aria-label="手动成交价"
          title="留空则按当前行情价成交；填入则按该价格成交"
        />
        </label>
        <div class="sim-order-actions">
        <button class="primary-button" @click="buy()">模拟买入</button>
        <button class="danger-button" @click="sell()">模拟卖出</button>
        </div>
      </div>
      <div class="emotion-selector">
        <span>下单心态</span>
        <button
          v-for="item in [
            'FOMO追涨',
            '逆向抄底',
            '跟风操作',
            '逻辑驱动',
            '恐慌割肉',
            '贪心加仓',
          ]"
          :key="item"
          :class="{ active: emotion === item }"
          :aria-pressed="emotion === item"
          @click="emotion = item"
        >
          {{ item }}
        </button>
      </div>
      </section>
      <section class="sim-account-panel">
      <div class="account-tabs" role="tablist" aria-label="模拟账户记录">
        <button
          v-for="item in ['持仓', '历史', '预委托', '情绪分析']"
          :key="item"
          :class="{ active: accountTab === item }"
          role="tab"
          :aria-selected="accountTab === item"
          @click="accountTab = item"
        >
          {{ item }}
        </button>
      </div>
      <div class="account-content">
        <div v-if="accountTab === '持仓'">
          <div
            v-for="item in positionList"
            :key="item.code"
            class="holding-row"
          >
            <span
              ><strong>{{ item.name }}</strong
              ><small>{{ item.code }}</small></span
            >
            <span
              >{{ item.quantity }}股<small
                >成本价 {{ fmtMoney(item.avgCost.toFixed(2)) }}</small
              ></span
            >
            <span
              >现价 {{ fmtMoney(item.price.toFixed(2)) }}<small
                >市值 {{ fmtMoney(item.marketValue) }}</small
              ></span
            >
            <strong :class="pnlClass(item.pnl)"
              >{{ fmtSignedMoney(item.pnl) }}<small :class="pnlClass(item.pnl)"
                >{{ fmtSignedPct(item.pnlPct) }}</small
              ></strong
            ><button @click="sellAll(item.code)">清仓</button>
          </div>
          <div v-if="!positionList.length" class="account-empty">
            <IconBriefcase2 :size="22" /><strong>当前没有模拟持仓</strong>
          </div>
        </div>
        <div v-if="accountTab === '历史'">
          <div v-for="item in trades" :key="item.createdAt" class="holding-row">
            <span
              ><strong>{{ item.stock }}</strong
              ><small>{{
                new Date(item.createdAt).toLocaleTimeString("zh-CN")
              }}</small></span
            >
            <span>{{ item.side }}</span
            ><span>{{ item.quantity }}股</span>
            <span
              >{{ fmtMoney(item.price.toFixed(2)) }}<small
                v-if="item.pnl != null"
                :class="pnlClass(item.pnl)"
                >盈亏 {{ fmtSignedMoney(item.pnl) }}</small
              ></span
            >
            <span>{{ item.emotion }}</span>
          </div>
          <div v-if="!trades.length" class="account-empty">
            <IconBriefcase2 :size="22" /><strong>暂无模拟交易历史</strong>
          </div>
        </div>
        <div v-if="accountTab === '预委托'" class="account-empty">
          <IconBriefcase2 :size="22" /><strong>暂无模拟条件单</strong>
        </div>
        <div v-if="accountTab === '情绪分析'" class="account-empty">
          <IconBrain :size="22" />
          <strong>{{
            trades.length
              ? `已记录${trades.length}笔下单心态`
              : "暂无可分析记录"
          }}</strong>
          <p>情绪分析仅基于本机模拟交易记录，不推断真实账户行为。</p>
        </div>
      </div>
      </section>
      <p class="simulation-source-note">数据来源：本机模拟账户与现有行情快照。交易仅用于模拟记录，不连接真实证券账户。</p>
    </div>
  </div>
</template>

<style scoped>
:global(.app-shell.active-tools .app-content) { grid-template-columns: minmax(0, 1fr); }
.simulation-workspace { color: #234a7b; font-size: 14px; min-width: 0; }
.sim-heading { display: flex; align-items: center; justify-content: space-between; gap: 16px; flex-wrap: wrap; margin: 20px 0; }
.sim-heading h1 { display: flex; align-items: center; gap: 9px; margin: 0; font-size: 23px; }
.sim-heading h1 svg { color: #287cf0; }
.sim-heading p { margin: 7px 0 0; color: #738bad; font-size: 13px; }
.sim-badge { padding: 5px 10px; border: 1px solid #bde5dd; border-radius: 5px; background: #eef9f6; color: #168575; font-size: 12px; }
.simulation-summary { grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px; margin: 0 0 18px; }
.simulation-summary > div { align-items: flex-start; min-height: 108px; padding: 16px 18px; border: 1px solid #dce7f6; border-radius: 9px; background: #f8fbff; text-align: left; }
.simulation-summary span { font-size: 13px; color: #6e87aa; }
.simulation-summary strong { margin-top: 10px; font-size: 24px; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.simulation-summary > div:first-child strong { color: #2176ed; }
.simulation-summary small { margin-top: 5px; font-size: 13px; }
.sim-order-panel,.sim-account-panel { border: 1px solid #dce7f6; border-radius: 10px; background: #fff; margin-bottom: 18px; overflow: hidden; }
.sim-panel-heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 16px 18px; border-bottom: 1px solid #e4edf8; }
.sim-panel-heading h2 { margin: 0; font-size: 16px; }
.sim-panel-heading > span { color: #738bad; font-size: 12px; }
.simulation-order { display: grid; grid-template-columns: minmax(200px, 1.4fr) repeat(2, minmax(140px, 1fr)); align-items: end; gap: 16px; margin: 0; padding: 18px; }
.sim-field { display: flex; flex-direction: column; gap: 9px; min-width: 0; color: #5879a4; font-size: 13px; }
.simulation-order .ep-form-control { width: 100%; min-width: 0; }
.simulation-order :deep(.el-select__wrapper),.simulation-order :deep(.el-input__wrapper) { min-height: 40px; border-radius: 7px; background: #fff; }
.simulation-order :deep(.el-select__placeholder),.simulation-order :deep(.el-input__inner) { font-size: 14px; }
.simulation-order :deep(.el-input-number__decrease),.simulation-order :deep(.el-input-number__increase) { background: #f5f9ff; color: #5879a4; }
.sim-order-actions { grid-column: 1 / -1; display: flex; gap: 12px; }
.sim-order-actions button { width: auto; min-width: 120px; height: 40px; margin: 0; padding: 0 20px; border-radius: 7px; font-size: 14px; cursor: pointer; }
.sim-order-actions .primary-button { background: #287cf0; border: 1px solid #287cf0; color: #fff; }
.sim-order-actions .primary-button:hover { background: #1768d5; }
.sim-order-actions .danger-button { background: #fff2f3; border: 1px solid #f5cbd1; color: #dd5267; }
.sim-order-actions .danger-button:hover { background: #ffe5e9; }
.simulation-workspace .emotion-selector { gap: 8px; margin: 0; padding: 14px 18px; min-height: 0; border: 0; border-top: 1px solid #e4edf8; border-radius: 0; background: #fbfdff; }
.emotion-selector > span { font-size: 13px; color: #738bad; }
.emotion-selector button { height: 34px; padding: 0 12px; border: 1px solid #dce7f6; border-radius: 6px; background: #fff; color: #5879a4; font-size: 13px; }
.emotion-selector button.active { background: #edf5ff; color: #2176ed; border-color: #bdd7ff; }
.emotion-selector button:hover { border-color: #aacaff; }
.account-tabs { gap: 8px; margin: 0; padding: 12px; border-bottom: 1px solid #e4edf8; overflow-x: auto; }
.account-tabs button { flex-shrink: 0; height: 38px; padding: 0 16px; border: 1px solid transparent; border-radius: 7px; background: #fff; color: #5879a4; font-size: 14px; }
.account-tabs button.active { background: #edf5ff; border-color: #c7deff; color: #2176ed; }
.account-tabs button:hover { background: #f5f9ff; }
.account-content { min-height: 210px; overflow-x: auto; }
.account-empty { min-height: 210px; padding: 24px 18px; color: #7893b9; }
.account-empty > svg { width: 38px; height: 38px; color: #aac9ef; }
.account-empty strong { margin-top: 14px; color: #426b9d; font-size: 16px; }
.account-empty p { margin-top: 10px; font-size: 13px; line-height: 1.7; }
.holding-row { min-width: 650px; grid-template-columns: minmax(130px, 1.2fr) repeat(3, 1fr) 80px; padding: 16px 18px; border-bottom: 1px solid #e6eef8; font-size: 14px; }
.holding-row:last-child { border-bottom: 0; }
.holding-row:nth-child(even) { background: #f8fbff; }
.holding-row > span { font-size: 14px; }
.holding-row small { display: block; margin-top: 5px; font-size: 12px; }
.holding-row span small { font-size: 12px; color: #738bad; }
.holding-row > button { height: 34px; font-size: 13px; border-radius: 6px; background: #fff2f3; border-color: #f5cbd1; color: #dd5267; }
.simulation-source-note { margin: 0 0 16px; color: #7a91b0; font-size: 12px; line-height: 1.8; }
@media (max-width: 760px) {
  .simulation-summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .simulation-summary > div { padding: 14px; }
  .simulation-summary strong { font-size: 21px; }
  .simulation-order { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .sim-field:first-child { grid-column: 1 / -1; }
}
@media (max-width: 420px) {
  .simulation-order { grid-template-columns: minmax(0, 1fr); }
  .sim-order-actions button { min-width: 0; flex: 1; padding: 0 12px; }
}
</style>

<script setup>
import { ref, computed, watch } from "vue";
import { useRouter, useRoute } from "vue-router";
import { useSnapshot } from "@/composables/useSnapshot";
import { http } from "@/api/client";
import StatusBadge from "@/components/StatusBadge.vue";
import EChart from "@/components/EChart.vue";
import { hydrateStock } from "@/utils/format";
import {
  IconActivity,
  IconFileAnalytics,
  IconChartCandle,
  IconBell,
  IconSearch,
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
const { data: platformStatus } = useSnapshot("/api/status", {
  refreshMs: 60000,
});
const { data: accuracy } = useSnapshot("/api/accuracy", { refreshMs: 60000 });
const { data: top50Snapshot } = useSnapshot("/api/top50", {
  refreshMs: 300000,
});

// 票数分母 = 用户自己创建的老师总数（引擎 meta.teacherCount）。原来写死 12，
// 但内置 12 位是原版 mock 人设，已从产品里去掉；没有自建老师时兜 1，避免除零。
const teacherCount = computed(
  () => Number(top50Snapshot.value?.meta?.teacherCount) || 1,
);
// 模板里不做字符串拼接（约定：模板属性内禁止内联运算），按钮文案在这里算好。
const analysisRunLabel = computed(
  () => `${teacherCount.value}套因子画像分析已更新`,
);

const quantToolTabs = [
  { id: "market", label: "行情", icon: IconActivity },
  { id: "analysis", label: "分析", icon: IconFileAnalytics },
  { id: "backtest", label: "回测", icon: IconChartCandle },
  { id: "signals", label: "信号", icon: IconBell },
  { id: "screener", label: "选股", icon: IconSearch },
  { id: "predict", label: "预判", icon: IconTargetArrow },
  { id: "evaluate", label: "评估", icon: IconShieldCheck },
  { id: "simulation", label: "模拟", icon: IconBriefcase2 },
];

// tab 初始值来自 ?tool=（决策弹窗「模拟交易」直达模拟 tab）；非法值回落行情。
const validTools = quantToolTabs.map((t) => t.id);
const tool = ref(
  validTools.includes(route.query.tool) ? route.query.tool : "market",
);
const cycle = ref("波段");
const stockCode = ref("");
const feedback = ref("");
const toolResult = ref(null);
const quantity = ref(100);
const emotion = ref("逻辑驱动");
const accountTab = ref("持仓");
const cash = ref(1000000);
const positionQuantity = ref(0);
const trades = ref([]);
const backtestStart = ref("2025-01-01");
const backtestEnd = ref(
  new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(
    new Date(),
  ),
);

const stockOptions = computed(() =>
  (top50Snapshot.value?.cycles?.[cycle.value]?.ranking || []).map(hydrateStock),
);
// el-select 要显式的 label/value 对（原生 <option> 的插值写法在 EP 里不成立）。
// 周期选项固定 4 个；标的选项跟着冻结榜单走，所以是 computed。
const cycleOptions = ["超短", "短线", "波段", "中长线"];
const stockChoices = computed(() =>
  stockOptions.value.map((item) => ({
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
const positionValue = computed(() =>
  Math.round(positionQuantity.value * stock.value.price),
);
const totalAssets = computed(() => cash.value + positionValue.value);
const marketSourceStatusLabel = computed(
  () =>
    ({
      live: "实时",
      partial: "部分更新",
      snapshot: "缓存快照",
      stale: "缓存快照",
      unavailable: "不可用",
    })[toolResult.value?.marketSource?.status] ||
    toolResult.value?.marketSource?.status ||
    "不可用",
);

async function run(message, requestedTool = tool.value, extra = {}) {
  feedback.value = "正在读取冻结因子榜与真实数据源…";
  toolResult.value = null;
  try {
    const { data } = await http.post(`/api/quant/${requestedTool}`, {
      stockCode: stock.value.code,
      cycle: cycle.value,
      quantity: quantity.value,
      action: message,
      ...extra,
    });
    toolResult.value = data?.result ?? data;
    feedback.value = `${message} · 因子画像计算已完成 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`;
  } catch (error) {
    feedback.value = `量化计算未运行：${error?.response?.data?.reason || error.message}。系统不会用静态结果冒充运行结果。`;
  }
}
function localFeedback(message) {
  feedback.value = `${message} · 仅保存在本机模拟账户`;
}
function trade(side) {
  const amount = Math.round(quantity.value * stock.value.price);
  if (side === "买入" && amount <= cash.value) {
    cash.value -= amount;
    positionQuantity.value += quantity.value;
    trades.value = [
      {
        side,
        quantity: quantity.value,
        price: stock.value.price,
        stock: stock.value.name,
        createdAt: new Date().toISOString(),
        emotion: emotion.value,
      },
      ...trades.value,
    ];
    localFeedback(`模拟买入 ${quantity.value} 股成功`);
  } else if (side === "卖出" && positionQuantity.value >= quantity.value) {
    cash.value += amount;
    positionQuantity.value -= quantity.value;
    trades.value = [
      {
        side,
        quantity: quantity.value,
        price: stock.value.price,
        stock: stock.value.name,
        createdAt: new Date().toISOString(),
        emotion: emotion.value,
      },
      ...trades.value,
    ];
    localFeedback(`模拟卖出 ${quantity.value} 股成功`);
  } else {
    localFeedback(side === "买入" ? "可用资金不足" : "可卖持仓不足");
  }
}
function switchTool(id) {
  tool.value = id;
  feedback.value = "";
  toolResult.value = null;
  // URL 与 tab 保持同步：否则「先手点别的 tab、再从弹窗跳同一 tab」时 query 未变化、
  // 路由不去重导航，下面的 watch 不会再触发，tab 会切不过去。
  router.replace({ query: { ...route.query, tool: id } });
}

// 决策弹窗是全局实例（App.vue 挂载），在 /tools 页本身也能打开 —— 所以 ?tool= 变化
// 不能只靠 setup 时读一次，这里同步监听（弹窗「模拟交易」跳转的正式入口）。
watch(
  () => route.query.tool,
  (v) => {
    if (v && v !== tool.value && validTools.includes(v)) switchTool(v);
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

// 回测净值曲线配置（策略 vs 基准双线，真实历史行情现算）。
// 空数组时显示"暂无净值数据"，不画假线。
const equityCurveOptions = computed(() => {
  const curve = toolResult.value?.equityCurve || [];
  const dates = curve.map((p) => p.date);
  return {
    grid: { left: 48, right: 20, top: 24, bottom: 32 },
    tooltip: { trigger: "axis" },
    legend: { data: ["策略净值", "基准净值"], top: 0, textStyle: { fontSize: 12 } },
    xAxis: { type: "category", data: dates, axisLabel: { fontSize: 11 } },
    yAxis: {
      type: "value",
      scale: true,
      axisLabel: { fontSize: 11, formatter: (v) => v.toFixed(2) },
    },
    series: [
      {
        name: "策略净值",
        type: "line",
        showSymbol: false,
        smooth: true,
        data: curve.map((p) => p.strategy),
        lineStyle: { width: 2, color: "#378ADD" },
        itemStyle: { color: "#378ADD" },
      },
      {
        name: "基准净值",
        type: "line",
        showSymbol: false,
        smooth: true,
        data: curve.map((p) => p.benchmark),
        lineStyle: { width: 1.5, type: "dashed", color: "#888780" },
        itemStyle: { color: "#888780" },
      },
    ],
  };
});
const equityCurvePoints = computed(
  () => (toolResult.value?.equityCurve || []).length,
);
</script>

<template>
  <div class="simple-page quant-tool-page">
    <div class="page-toolbar">
      <div>
        <h1>量化工具</h1>
        <p>与 TOP50、{{ teacherCount }}套因子画像、风险纪律和模拟研究联动</p>
      </div>
      <span
        :class="[
          'tool-data-state',
          { degraded: !platformStatus?.providers?.quant?.configured },
        ]"
      >
        <i />
        {{
          platformStatus?.providers?.quant?.configured
            ? "量化接口已配置 · 运行后显示真实结果"
            : "真实量化引擎待配置"
        }}
      </span>
    </div>

    <div class="quant-tool-tabs">
      <button
        v-for="t in quantToolTabs"
        :key="t.id"
        :class="{ active: tool === t.id }"
        @click="switchTool(t.id)"
      >
        <component :is="t.icon" :size="16" /><span>{{ t.label }}</span>
      </button>
    </div>

    <div v-if="feedback" class="tool-feedback">
      <IconCircleCheck :size="15" /><span>{{ feedback }}</span>
      <button aria-label="关闭操作反馈" @click="feedback = ''">
        <IconX :size="14" />
      </button>
    </div>

    <!-- 行情 -->
    <div v-if="tool === 'market'" class="tool-workspace">
      <div class="tool-form-row">
        <el-select
          v-model="cycle"
          class="ep-form-control ep-form-control--cycle"
          aria-label="持有周期"
          ><el-option v-for="c in cycleOptions" :key="c" :label="c" :value="c"
        /></el-select>
        <button class="primary-button" @click="run('行情快照已读取', 'market')">
          读取真实行情快照
        </button>
      </div>
      <section class="panel screener-result">
        <div v-if="!toolResult" class="account-empty">
          <IconActivity :size="22" /><strong>读取后显示行情来源和TOP10</strong>
          <p>运行后显示真实结果</p>
        </div>
        <template v-else>
          <div class="panel-head">
            <div>
              <h2>冻结TOP50因子榜</h2>
              <span
                >排序：{{ toolResult.rankingSource?.provider || "待确认" }} ·
                数据日
                {{ toolResult.rankingSource?.dataDate || "--" }}；盘中：{{
                  toolResult.marketSource?.provider || "不可用"
                }}
                · {{ marketSourceStatusLabel }}</span
              >
            </div>
            <strong>{{ toolResult.top10?.length || 0 }}只</strong>
          </div>
          <div class="scanner-table">
            <div class="scanner-head">
              <span>排名</span><span>股票</span><span>综合分</span
              ><span>共识</span><span>涨跌幅</span><span>状态</span>
            </div>
            <div v-for="item in toolResult.top10 || []" :key="item.code">
              <b>#{{ item.rank }}</b>
              <span
                ><strong>{{ item.name }}</strong
                ><small>{{ item.code }}</small></span
              >
              <em>{{ item.score }}</em
              ><span>{{ item.agentVotes }}/{{ teacherCount }}</span>
              <span :class="item.pct >= 0 ? 'price-up' : 'price-down'">{{
                pctText(item.pct)
              }}</span>
              <StatusBadge :status="item.status || '仅观察'" />
            </div>
          </div>
        </template>
      </section>
    </div>

    <!-- 分析 -->
    <div v-if="tool === 'analysis'" class="tool-workspace">
      <div class="tool-form-row">
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
        <button
          class="primary-button"
          @click="run(analysisRunLabel, 'analysis')"
        >
          运行完整分析
        </button>
      </div>
      <div v-if="!toolResult" class="account-empty">
        <IconFileAnalytics :size="22" /><strong>运行后显示真实结果</strong>
        <p>因子画像分析需要读取冻结快照。</p>
      </div>
      <template v-else>
        <section class="panel evaluation-result">
          <div class="evaluation-score">
            <span>冻结综合分</span
            ><strong>{{ toolResult.stock?.score ?? "--" }}</strong>
            <p>{{ toolResult.conclusion }}</p>
          </div>
          <div class="evaluation-dimensions">
            <div
              v-for="[label, score] in Object.entries(
                toolResult.factorScores || {},
              )"
              :key="label"
            >
              <span>{{ label }}</span>
              <div><i :style="{ width: `${score}%` }" /></div>
              <b>{{ Math.round(score) }}</b>
            </div>
          </div>
        </section>
        <section class="panel ai-insight-panel">
          <IconBrain :size="22" />
          <div>
            <span>领先因子画像</span>
            <h2>{{ toolResult.topAgents?.join("、") || "暂无" }}</h2>
            <p>
              实际支持 {{ toolResult.agentVotes ?? 0 }}/{{ teacherCount }} ·
              行情日 {{ toolResult.marketDataDate }}
            </p>
          </div>
          <strong>{{ toolResult.stock?.score ?? "--" }}</strong>
        </section>
      </template>
    </div>

    <!-- 回测 -->
    <div v-if="tool === 'backtest'" class="tool-workspace">
      <div class="tool-form-row">
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
        <el-date-picker
          v-model="backtestStart"
          type="date"
          value-format="YYYY-MM-DD"
          class="ep-form-control ep-form-control--date"
          aria-label="回测开始日期"
          :clearable="false"
        />
        <el-date-picker
          v-model="backtestEnd"
          type="date"
          value-format="YYYY-MM-DD"
          class="ep-form-control ep-form-control--date"
          aria-label="回测结束日期"
          :clearable="false"
        />
        <button
          class="primary-button"
          @click="
            run('回测完成', 'backtest', {
              startDate: backtestStart,
              endDate: backtestEnd,
            })
          "
        >
          开始真实历史回测
        </button>
      </div>
      <div v-if="!toolResult" class="account-empty">
        <IconChartCandle :size="22" /><strong
          >选择日期并运行真实历史回测</strong
        >
        <p>运行后显示真实结果</p>
      </div>
      <template v-else>
        <div class="backtest-summary">
          <div>
            <span>策略收益</span
            ><strong
              :class="toolResult.totalReturn >= 0 ? 'price-up' : 'price-down'"
              >{{ toolResult.totalReturn }}%</strong
            >
          </div>
          <div>
            <span>基准收益</span
            ><strong
              :class="toolResult.benchmarkReturn >= 0 ? 'price-up' : 'price-down'"
              >{{ toolResult.benchmarkReturn }}%</strong
            >
          </div>
          <div>
            <span>持仓日胜率</span
            ><strong>{{ toolResult.investedDayWinRate ?? "--" }}%</strong>
          </div>
          <div>
            <span>最大回撤</span
            ><strong class="price-down">{{ toolResult.maxDrawdown }}%</strong>
          </div>
          <div>
            <span>入场次数</span><strong>{{ toolResult.entries }}</strong>
          </div>
        </div>
        <section class="panel backtest-chart-panel">
          <div class="tool-panel-head">
            <div>
              <h2>净值曲线</h2>
              <span>{{ toolResult.strategy }}</span>
            </div>
            <span class="tool-legend"
              >{{ toolResult.startDate }}—{{ toolResult.endDate }} ·
              {{ toolResult.sampleCount }}日</span
            >
          </div>
          <div class="backtest-chart">
            <EChart
              v-if="equityCurvePoints"
              :options="equityCurveOptions"
              height="280px"
            />
            <p v-else class="page-data-method">
              本次回测未产出净值曲线（历史行情不足或行情源不可用）。
            </p>
          </div>
        </section>
      </template>
    </div>

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
            v-for="s in stockChoices"
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

    <!-- 选股 -->
    <div v-if="tool === 'screener'" class="tool-workspace">
      <div class="tool-form-row screener-form">
        <el-select
          v-model="cycle"
          class="ep-form-control ep-form-control--cycle"
          aria-label="持有周期"
          ><el-option v-for="c in cycleOptions" :key="c" :label="c" :value="c"
        /></el-select>
        <button
          class="primary-button"
          @click="run('风险门控后的TOP50扫描完成', 'screener', { limit: 30 })"
        >
          扫描真实TOP50
        </button>
      </div>
      <section class="panel screener-result">
        <div v-if="!toolResult" class="account-empty">
          <IconSearch :size="22" /><strong>运行后显示真实结果</strong>
          <p>硬风险门控已在入池前执行。</p>
        </div>
        <template v-else>
          <div class="panel-head">
            <div>
              <h2>扫描结果</h2>
              <span
                >{{ teacherCount }}套因子画像排名 ·
                硬风险门控已在入池前执行</span
              >
            </div>
            <strong>{{ toolResult.items?.length || 0 }}只</strong>
          </div>
          <div class="scanner-table">
            <div class="scanner-head">
              <span>排名</span><span>股票</span><span>综合分</span
              ><span>因子支持</span><span>状态</span><span>操作</span>
            </div>
            <div v-for="item in toolResult.items || []" :key="item.code">
              <b>#{{ item.rank }}</b>
              <span
                ><strong>{{ item.name }}</strong
                ><small>{{ item.code }}</small></span
              >
              <em>{{ item.score }}</em
              ><span>{{ item.agentVotes }}/{{ teacherCount }}</span>
              <StatusBadge :status="item.status" />
              <button
                @click="
                  stockCode = item.code;
                  switchTool('predict');
                "
              >
                预判
              </button>
            </div>
          </div>
        </template>
      </section>
    </div>

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
            v-for="s in stockChoices"
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
            v-for="s in stockChoices"
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
      class="tool-workspace simulation-workspace"
    >
      <div class="simulation-summary">
        <div>
          <span>模拟可用余额</span><strong>{{ fmtMoney(cash) }}</strong>
        </div>
        <div>
          <span>模拟持仓市值</span
          ><strong>{{ fmtMoney(positionValue) }}</strong>
        </div>
        <div>
          <span>模拟总资产</span><strong>{{ fmtMoney(totalAssets) }}</strong>
        </div>
        <div><span>数据性质</span><strong>本机模拟</strong></div>
      </div>
      <div class="tool-form-row simulation-order">
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
        <el-input-number
          v-model="quantity"
          :min="100"
          :step="100"
          :precision="0"
          class="ep-form-control ep-form-control--number"
          aria-label="模拟交易股数"
        />
        <button class="primary-button" @click="trade('买入')">模拟买入</button>
        <button class="danger-button" @click="trade('卖出')">模拟卖出</button>
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
          @click="emotion = item"
        >
          {{ item }}
        </button>
      </div>
      <div class="account-tabs">
        <button
          v-for="item in ['持仓', '历史', '预委托', '情绪分析']"
          :key="item"
          :class="{ active: accountTab === item }"
          @click="accountTab = item"
        >
          {{ item }}
        </button>
      </div>
      <section class="panel account-content">
        <div v-if="accountTab === '持仓'">
          <div v-if="positionQuantity" class="holding-row">
            <span
              ><strong>{{ stock.name }}</strong
              ><small>{{ stock.code }}</small></span
            >
            <span>{{ positionQuantity }}股</span
            ><span>快照价 {{ fmtMoney(stock.price.toFixed(2)) }}</span>
            <strong>本机模拟</strong
            ><button @click="trade('卖出')">模拟卖出100股</button>
          </div>
          <div v-else class="account-empty">
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
            <strong>{{ fmtMoney(item.price.toFixed(2)) }}</strong
            ><span>{{ item.emotion }}</span>
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
      </section>
    </div>
  </div>
</template>

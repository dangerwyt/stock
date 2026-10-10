<script setup>
import { ref, computed, onMounted } from "vue";
import { useRouter } from "vue-router";
import { useSnapshot } from "@/composables/useSnapshot";
import { useAgentsStore } from "@/stores/agents";
import { hydrateStock } from "@/utils/format";
import {
  IconChevronRight,
  IconBrain,
  IconTargetArrow,
  IconShieldCheck,
  IconX,
} from "@tabler/icons-vue";

const router = useRouter();
const agentsStore = useAgentsStore();
const { data: top50, state: top50State } = useSnapshot("/api/top50", {
  refreshMs: 300000,
});

const strategyStocks = computed(() =>
  (top50.value?.cycles?.["波段"]?.ranking || []).slice(0, 10).map(hydrateStock),
);
const selectedCode = ref(null);
// 右栏的「当前标的」：未点过任何一行时兜底到第一只（右栏总得有内容可展示）。
const current = computed(
  () =>
    strategyStocks.value.find((s) => s.code === selectedCode.value) ||
    strategyStocks.value[0] ||
    null,
);
// 矩阵表格的行高亮状态：**只记用户点过的那一行**，不再跟着 current 走。
// 之前用 current?.code 判定，而 current 有「未选中兜底第一只」的逻辑，导致首行永远
// 挂着 selected —— 页面一进来第一行就是高亮态，看起来像默认选中，容易误读。
const activeRowCode = ref(null);
// Shared persona pool —— 只含用户自己创建的角色（内置 12 位 mock 人设已从产品去掉）。
const teachers = computed(() => agentsStore.teacherList);
// 画像套数 = 实际存在的自建老师数，也是矩阵列数与「x/N」的分母。原来是写死的 12
// （原型 mock 数据）。没有自建老师时兜 1，避免除零。
const teacherCount = computed(() => teachers.value.length || 1);
// 共识票数：agentScores 里 ≥60 分的人数。引擎已把票数口径收敛到「参与打分的画像」，
// 内置 12 位不再出现在 agentScores 里，所以这里直接数即可。
function supportVotes(stock) {
  const scores = stock?.agentScores;
  if (!scores || typeof scores !== "object")
    return Number(stock?.agentVotes) || 0;
  return Object.values(scores).filter((value) => Number(value) >= 60).length;
}
// 实际参与打分的画像数（= agentScores 键数）。自建老师里没学出画像的不参与，
// 所以它可能小于 teacherCount —— 矩阵里那些列会显示「待评分」。
function scoredCount(stock) {
  const scores = stock?.agentScores;
  return scores && typeof scores === "object" ? Object.keys(scores).length : 0;
}
const teacherName = ref(agentsStore.teacherList[0]?.name || "");
const agentByName = computed(() => agentsStore.teacherByName);

onMounted(() => {
  // force：store 在 AI 页可能已经加载过，提炼画像后不能沿用那份旧缓存。
  agentsStore.refresh({ force: true });
});

function scoreLabel(score) {
  if (score >= 75) return { label: "强匹配", cls: "strong" };
  if (score >= 60) return { label: "条件匹配", cls: "conditional" };
  if (score >= 45) return { label: "等待", cls: "wait" };
  return { label: "回避", cls: "avoid" };
}
// 自定义角色只对 TOP10 打过分，也可能是新增股票；区分「0 分」与「没有分」。
function cellScore(stock, name) {
  const raw = stock?.agentScores?.[name];
  return raw === undefined || raw === null || raw === "" ? null : Number(raw);
}
// 右栏当前老师对当前标的的分数；自建角色未评分时为 null（不能当 0 分显示成「回避」）。
const currentScore = computed(() =>
  current.value ? cellScore(current.value, teacherName.value) : null,
);
// 右栏里的老师对象——内置取画像、自建取提炼结果，都由 store 提供。
const selectedTeacher = computed(
  () => teachers.value.find((t) => t.name === teacherName.value) || null,
);
function goAI() {
  router.push("/ai");
}
function onRow(stock) {
  selectedCode.value = stock.code;
  activeRowCode.value = stock.code;
  router.push("/top50");
}
const consensusStocks = computed(() =>
  [...strategyStocks.value]
    .map((stock) => {
      const votes = supportVotes(stock);
      // 「过半支持」按**实际参与打分的画像数**判定：原版是 6/12（= 50%），这里写成
      // votes * 2 >= 参与数，等价于此前的写死阈值，但参与数为 1 时也能给出「条件偏多」，
      // 而不是因为凑不满 6 票就永远「仅观察」。
      const scored = scoredCount(stock);
      const bullish = scored > 0 && votes * 2 >= scored;
      return {
        ...stock,
        consensusVotes: votes,
        consensusDirectionClass: bullish ? "positive" : "negative",
        consensusDirectionLabel: bullish ? "条件偏多" : "仅观察",
      };
    })
    .sort((a, b) => b.consensusVotes - a.consensusVotes || b.score - a.score),
);
// 右栏分歧条：分子与分母都取自「实际老师数」，避免标题写 15 套、条子还按 12 算。
const divergence = computed(() => {
  const total = teacherCount.value || 1;
  const votes = current.value ? supportVotes(current.value) : 0;
  const missing = Math.max(total - votes, 0);
  return {
    votes,
    missing,
    supportWidth: `${(votes / total) * 100}%`,
    missingWidth: `${(missing / total) * 100}%`,
  };
});
</script>

<template>
  <div class="page-grid strategies-page">
    <main class="primary-workspace">
      <div class="teacher-tabs">
        <span>{{ teacherCount }}套策略画像</span>
        <button
          v-for="item in teachers"
          :key="item.name"
          :class="{ active: teacherName === item.name }"
          @click="teacherName = item.name"
        >
          <strong>{{ item.name }}</strong>
          <small
            >{{ item.style }} ·
            {{ agentByName[item.name]?.materialCount || 0 }}份资料</small
          >
        </button>
      </div>

      <section class="panel matrix-panel">
        <div class="panel-head">
          <div>
            <h2>{{ teacherCount }}套策略因子画像矩阵</h2>
            <span>{{
              top50State === "ready"
                ? `波段TOP10 · 行情日 ${top50?.meta?.marketDataDate || "--"} · 批次 ${top50?.cycles?.["波段"]?.snapshotId || "--"}`
                : "正在读取当天TOP50共享快照"
            }}</span>
          </div>
          <span class="agent-version-badge">{{
            agentByName[teacherName]?.productionVersion?.id || "agent-factor-v1"
          }}</span>
        </div>
        <div class="matrix-wrap">
          <table class="strategy-matrix">
            <thead>
              <tr>
                <th>股票</th>
                <th
                  v-for="t in teachers"
                  :key="t.name"
                  :class="{ 'th-custom': agentsStore.isCustom(t.name) }"
                >
                  {{ t.name }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="stock in strategyStocks"
                :key="stock.code"
                :class="{ selected: activeRowCode === stock.code }"
                @click="onRow(stock)"
              >
                <td>
                  <strong>{{ stock.name }}</strong
                  ><small>{{ stock.code }}</small>
                </td>
                <td
                  v-for="t in teachers"
                  :key="t.name"
                  :class="{ 'cell-pending': cellScore(stock, t.name) === null }"
                >
                  <template v-if="cellScore(stock, t.name) === null">
                    <b class="pending">待评分</b><small>--</small>
                  </template>
                  <template v-else>
                    <b :class="scoreLabel(cellScore(stock, t.name)).cls">{{
                      scoreLabel(cellScore(stock, t.name)).label
                    }}</b>
                    <small>{{ Math.round(cellScore(stock, t.name)) }}</small>
                  </template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="matrix-legend">
          <span class="strong">● 强匹配 75分以上</span>
          <span class="conditional">● 条件匹配 60—74分</span>
          <span class="wait">● 等待 45—59分</span>
          <span class="avoid">● 回避 45分以下</span>
        </div>
      </section>

      <section class="panel consensus-panel">
        <div class="panel-head">
          <div>
            <h2>今日因子支持 TOP10</h2>
            <span>按固定因子支持数与波段综合分排序；不足6项仅观察</span>
          </div>
          <button aria-label="查看TOP50">
            <IconChevronRight :size="16" />
          </button>
        </div>
        <table class="consensus-table">
          <thead>
            <tr>
              <th>#</th>
              <th>股票</th>
              <th>共识强度</th>
              <th>支持策略</th>
              <th>共识方向</th>
              <th>最新价</th>
              <th>涨跌幅</th>
              <th>行业</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="stock in consensusStocks"
              :key="stock.code"
              @click="onRow(stock)"
            >
              <td>{{ stock.rank }}</td>
              <td>
                <strong>{{ stock.name }}</strong
                ><small>{{ stock.code }}</small>
              </td>
              <td>
                <b>{{ stock.consensusVotes }}/{{ teacherCount }}</b>
              </td>
              <td>{{ stock.topAgents?.join("、") || "--" }}</td>
              <td :class="stock.consensusDirectionClass">
                {{ stock.consensusDirectionLabel }}
              </td>
              <td>{{ stock.price.toFixed(2) }}</td>
              <td :class="stock.pct >= 0 ? 'price-up' : 'price-down'">
                {{ stock.pct >= 0 ? "+" : "" }}{{ stock.pct }}%
              </td>
              <td>{{ stock.industry }}</td>
            </tr>
          </tbody>
        </table>
      </section>
    </main>

    <aside v-if="current" class="right-rail strategy-rail">
      <div class="agent-profile">
        <div class="agent-avatar"><IconBrain :size="20" /></div>
        <div>
          <span>当前老师 Agent</span>
          <h2>{{ teacherName }}</h2>
          <p>{{ selectedTeacher?.style }} · {{ selectedTeacher?.horizon }}</p>
        </div>
        <b v-if="currentScore !== null" :class="scoreLabel(currentScore).cls">{{
          Math.round(currentScore)
        }}</b>
        <b v-else class="pending">--</b>
      </div>
      <div class="stock-detail-head">
        <div>
          <span>正在分析</span>
          <h2>
            {{ current.name }} <small>{{ current.code }}</small>
          </h2>
          <p>{{ current.industry }}</p>
        </div>
        <b v-if="currentScore !== null" :class="scoreLabel(currentScore).cls">{{
          scoreLabel(currentScore).label
        }}</b>
        <b v-else class="pending">未评分</b>
      </div>
      <div class="stock-quote">
        <strong>{{ current.price.toFixed(2) }}</strong
        ><span :class="current.pct >= 0 ? 'price-up' : 'price-down'"
          >{{ current.pct >= 0 ? "+" : "" }}{{ current.pct }}%</span
        >
      </div>
      <div class="detail-section">
        <h3>Agent决策</h3>
        <p>{{ selectedTeacher?.decision }}</p>
      </div>
      <div class="detail-section agent-rule">
        <h3>选股技巧</h3>
        <p><IconTargetArrow :size="14" />{{ selectedTeacher?.select }}</p>
      </div>
      <div class="detail-section agent-rule risk-list">
        <h3>风险纪律</h3>
        <p><IconShieldCheck :size="14" />{{ selectedTeacher?.risk }}</p>
      </div>
      <div class="detail-section agent-knowledge-summary">
        <h3>持续学习状态</h3>
        <p>
          <span>生产版本</span
          ><b>{{
            agentByName[teacherName]?.productionVersion?.id || "agent-factor-v1"
          }}</b>
        </p>
        <p>
          <span>授权资料</span
          ><b>{{ agentByName[teacherName]?.materialCount || 0 }}份</b>
        </p>
        <p>
          <span>待审候选</span
          ><b>{{ agentByName[teacherName]?.candidateCount || 0 }}个</b>
        </p>
        <small
          >每周日统一检查新增资料；蒸馏仅生成候选知识，必须审核发布，量化权重保持冻结。</small
        >
      </div>
      <div class="detail-section">
        <h3>{{ teacherCount }}套策略画像分歧概览</h3>
        <div class="consensus-bar">
          <i :style="{ width: divergence.supportWidth }" /><i
            :style="{ width: divergence.missingWidth }"
          />
        </div>
        <div class="consensus-labels">
          <span>支持 {{ divergence.votes }}</span
          ><span>未达支持线 {{ divergence.missing }}</span>
        </div>
      </div>
      <div class="detail-section trade-state">
        <div>
          <span>当前结论</span
          ><span
            :class="[
              'status-badge',
              currentScore === null
                ? 'muted'
                : currentScore >= 75
                  ? 'success'
                  : currentScore >= 55
                    ? 'warn'
                    : 'muted',
            ]"
            >{{
              currentScore === null
                ? "待评分"
                : currentScore >= 75
                  ? "可试仓"
                  : currentScore >= 55
                    ? "等待确认"
                    : "仅观察"
            }}</span
          >
        </div>
        <p>触发：{{ current.trigger }}</p>
        <p>失效：{{ current.invalid }}</p>
      </div>
      <button class="primary-button" @click="goAI">
        <IconBrain :size="17" /> 咨询{{ teacherName }} Agent
      </button>
    </aside>
  </div>
</template>

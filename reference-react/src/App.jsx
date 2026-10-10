import { useEffect, useMemo, useRef, useState } from "react";
import { useSharedSnapshot } from "./use-shared-snapshot.js";
import {
  IconActivity,
  IconAlertTriangle,
  IconArrowDownRight,
  IconArrowUpRight,
  IconBell,
  IconBook2,
  IconBrain,
  IconBriefcase2,
  IconBuildingFactory2,
  IconChartCandle,
  IconChartDots3,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCircleCheck,
  IconClock,
  IconCopy,
  IconDatabase,
  IconFileAnalytics,
  IconFilter,
  IconHome2,
  IconInfoCircle,
  IconLayoutSidebarLeftCollapse,
  IconLayoutSidebarLeftExpand,
  IconMenu2,
  IconMessageCircle2,
  IconMinus,
  IconNews,
  IconPlus,
  IconRefresh,
  IconReportAnalytics,
  IconSearch,
  IconSend2,
  IconSettings,
  IconShieldCheck,
  IconSparkles,
  IconStar,
  IconTargetArrow,
  IconTrendingUp,
  IconUserCircle,
  IconUsersGroup,
  IconWorld,
  IconX,
} from "@tabler/icons-react";
import { Bar, CartesianGrid, Cell, ComposedChart, Line, LineChart, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { deriveAgentProgress, deriveSummaryState, shouldKeepAgentJob, shouldShowAgentRunStatus } from "./ai-job-state.js";
import { teachers } from "./data";
import { isCurrentEvidenceRequest } from "./evidence-request.js";
import { focusWithAnimationFrame } from "./focus-utils.js";
import { newsCategories, newsCategoryMatches, newsTierLabel } from "./news-taxonomy.js";
import { ReferenceBanner, ResearchPromo, HomeMetrics } from "./ReferenceDesign.jsx";

const navGroups = [
  {
    label: "常用",
    items: [
      { id: "overview", label: "首页", icon: IconHome2 },
      { id: "top50", label: "TOP50", icon: IconTrendingUp },
      { id: "market", label: "行情", icon: IconActivity },
      { id: "portfolio", label: "自选", icon: IconBriefcase2 },
      { id: "news", label: "资讯", icon: IconNews },
      { id: "ai", label: "AI研究", icon: IconBrain },
    ],
  },
  {
    label: "研究工具",
    items: [
      { id: "industries", label: "行业主题", icon: IconBuildingFactory2 },
      { id: "strategies", label: "老师策略", icon: IconUsersGroup },
      { id: "tools", label: "量化工具", icon: IconChartDots3 },
      { id: "review", label: "盘后复盘", icon: IconFileAnalytics },
    ],
  },
  {
    label: "可信与系统",
    items: [
      { id: "accuracy", label: "准确率证据", icon: IconReportAnalytics },
      { id: "risk", label: "风险中心", icon: IconShieldCheck },
      { id: "operations", label: "运行状态", icon: IconActivity },
    ],
  },
];

const navItems = navGroups.flatMap((group) => group.items);
const mobilePrimaryNavItems = navItems.filter((item) => ["overview", "top50", "portfolio", "news", "ai"].includes(item.id));

const agentJobStateLabels = { waiting: "等待", analyzing: "分析中", retrying: "重试", completed: "完成", failed: "未完成" };
const agentJobPhaseLabels = { queued: "任务排队中", preparing: "正在准备证据", agents: "老师独立研判中", summarizing: "正在生成最终总结", completed: "会诊完成", failed: "会诊未完成" };

function formatDurationMs(durationMs) {
  const value = Number(durationMs);
  if (!Number.isFinite(value) || value <= 0) return "--";
  const totalSeconds = Math.max(1, Math.round(value / 1000));
  if (totalSeconds < 60) return `${totalSeconds}秒`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return seconds ? `${minutes}分${seconds}秒` : `${minutes}分`;
}

function formatShanghaiTime(value) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleTimeString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatShanghaiDateTime(value, withSeconds = false) {
  if (!value) return "--";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}),
  });
}

function displayField(value, fallback = "--") {
  return value == null || value === "" ? fallback : String(value);
}

function handleTabKeyNavigation(event, items, activeItem, onChange) {
  if (!Array.isArray(items) || !items.length) return;
  const currentIndex = Math.max(0, items.indexOf(activeItem));
  let nextIndex = null;
  if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % items.length;
  if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + items.length) % items.length;
  if (event.key === "Home") nextIndex = 0;
  if (event.key === "End") nextIndex = items.length - 1;
  if (nextIndex == null) return;
  event.preventDefault();
  onChange(items[nextIndex]);
  const tabs = [...(event.currentTarget.parentElement?.querySelectorAll('[role="tab"]') || [])];
  tabs[nextIndex]?.focus?.();
}

function describeNewsClassification(item) {
  const reason = item?.classificationReason || item?.marketScope?.classificationReason;
  if (reason === "explicit_global_marker") return "含海外市场关键词，归入全球观察";
  if (reason === "explicit_hong_kong_marker") return "含港股/港交所标记，归入港股";
  if (reason === "domestic_source") return "来自国内披露源，归入A股/中国";
  if (reason === "default_a_share") return "按A股上下文归类";
  return "分类原因待补充";
}

function summarizeNewsScoreBreakdown(scoreBreakdown = {}) {
  return `来源${scoreBreakdown.sourceTrust ?? 0} / 金融${scoreBreakdown.financialRelevance ?? 0} / 时效${scoreBreakdown.timeliness ?? 0} / 实体${scoreBreakdown.entityMatch ?? 0} / A股传导${scoreBreakdown.aShareTransmission ?? 0}`;
}

function useStockDirectorySearch(query) {
  const [items, setItems] = useState([]);
  const [state, setState] = useState("idle");
  useEffect(() => {
    const keyword = query.trim();
    if (!keyword) {
      setItems([]);
      setState("idle");
      return undefined;
    }
    let mounted = true;
    setState("loading");
    const timer = window.setTimeout(() => {
      fetch(`/api/stocks/search?q=${encodeURIComponent(keyword)}`, { cache: "no-cache" })
        .then((response) => {
          if (!response.ok) throw new Error(`Search request failed: ${response.status}`);
          return response.json();
        })
        .then((result) => {
          if (!mounted) return;
          setItems(Array.isArray(result?.items) ? result.items : []);
          setState("ready");
        })
        .catch(() => {
          if (!mounted) return;
          setItems([]);
          setState("unavailable");
        });
    }, 180);
    return () => {
      mounted = false;
      window.clearTimeout(timer);
    };
  }, [query]);
  return { items, state };
}

function StatusBadge({ status }) {
  const cls = status === "可试仓" ? "success" : status === "等待确认" ? "warn" : status === "风险排除" ? "danger" : "muted";
  return <span className={`status-badge ${cls}`}>{status}</span>;
}

function Change({ value }) {
  if (!value) return <span className="change flat"><IconMinus size={12} /></span>;
  return (
    <span className={`change ${value > 0 ? "up" : "down"}`}>
      {value > 0 ? <IconArrowUpRight size={12} /> : <IconArrowDownRight size={12} />} {Math.abs(value)}
    </span>
  );
}

function hydrateStock(item) {
  const base = {};
  const liveRankedItem = Boolean(item?.code && item?.agentScores);
  const pct = Number(item?.pct ?? base.pct ?? 0);
  return {
    rank: item?.rank ?? base.rank ?? 0,
    change: item?.change || 0,
    name: item?.name || base.name || item?.code || "未知股票",
    code: item?.code || base.code || "",
    industry: item?.industry || base.industry || "行业待映射",
    price: Number(item?.close ?? item?.price ?? base.price ?? 0),
    pct,
    score: Number(item?.score ?? base.score ?? 0),
    confidence: Number(item?.confidence ?? base.confidence ?? 0),
    consensus: Number(item?.agentVotes ?? base.consensus ?? 0),
    status: item?.status || base.status || (Number(item?.score) >= 75 ? "可试仓" : "等待确认"),
    valuation: item?.valuation || (liveRankedItem ? (Number(item?.peTtm) > 0 ? `PE(TTM) ${Number(item.peTtm).toFixed(1)}` : "PE暂无有效值") : base.valuation || "按实时因子"),
    trend: item?.trend || (liveRankedItem ? (pct >= 0 ? "当日价格上涨" : "当日价格回撤") : base.trend || "等待数据"),
    risk: item?.risk || (liveRankedItem ? "高" : base.risk || "高"),
    reason: item?.reason || (liveRankedItem ? `${item.topAgents?.join("、") || "12套策略画像"}因子领先；支持${item.agentVotes || 0}/12` : "等待真实因子快照"),
    trigger: item?.trigger || (Number.isFinite(Number(item?.triggerPrice)) ? `突破当日高点 ${Number(item.triggerPrice).toFixed(2)}` : liveRankedItem ? "暂无真实触发位" : base.trigger || "暂无真实触发位"),
    invalid: item?.invalid || (Number.isFinite(Number(item?.invalidPrice)) ? `跌破当日低点 ${Number(item.invalidPrice).toFixed(2)}` : liveRankedItem ? "暂无真实失效位" : base.invalid || "暂无真实失效位"),
    ...item,
  };
}

function resolveWatchlistStocks(codes, liveStocks = [], details = {}) {
  return codes.map((code) => {
    const live = liveStocks.find((item) => item.code === code);
    if (live) return { ...hydrateStock(live), watchlistDataAvailable: true, decisionAvailable: Boolean(live.agentScores) };
    const saved = details[code];
    return {
      code,
      name: saved?.name || code,
      industry: saved?.industry || "行情待刷新",
      watchlistDataAvailable: false,
      decisionAvailable: false,
    };
  });
}

function AppLogo({ collapsed }) {
  return (
    <div className="brand">
      {collapsed ? <div className="brand-mark"><IconChartCandle size={20} /></div> : <img src="/design-reference/brand.png" alt="智策研究 · 智能投研平台" />}
    </div>
  );
}

function Sidebar({ active, setActive, collapsed, setCollapsed, watchlistedCodes, watchlistDetails, onWatchStock, onEditWatchlist, liveStocks = [] }) {

  return (
    <aside className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <AppLogo collapsed={collapsed} />
      <nav aria-label="主导航">
        {navGroups.map((group) => (
          <section className="sidebar-nav-group" aria-label={group.label} key={group.label}>
            {!collapsed && <span className="sidebar-nav-label">{group.label}</span>}
            {group.items.map(({ id, label, icon: Icon }) => (
              <button key={id} className={active === id ? "active" : ""} onClick={() => setActive(id)} aria-label={label} title={collapsed ? label : undefined}>
                <Icon size={19} stroke={1.8} />
                {!collapsed && <span>{label}</span>}
              </button>
            ))}
          </section>
        ))}
      </nav>
      {!collapsed && <ResearchPromo onOpen={() => setActive("ai")} />}
      <div className="sidebar-foot">
        <span className="live-dot" />
        {!collapsed && <span>共享数据缓存</span>}
        <button onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? "展开侧边栏" : "收起侧边栏"}>
          {collapsed ? <IconLayoutSidebarLeftExpand size={17} /> : <IconLayoutSidebarLeftCollapse size={17} />}
        </button>
      </div>
    </aside>
  );
}

function MobilePrimaryNav({ active, setActive }) {
  return (
    <nav className="mobile-primary-nav" aria-label="移动端常用导航">
      {mobilePrimaryNavItems.map(({ id, label, icon: Icon }) => (
        <button className={active === id ? "active" : ""} onClick={() => setActive(id)} key={id}>
          <Icon size={20} stroke={1.8} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}

function Header({ active, onMenu, platformStatus, onNotifications, onSearch }) {
  const title = navItems.find((n) => n.id === active)?.label || "首页";
  const live = platformStatus?.status === "ready";
  const marketAndNewsLive = platformStatus?.providers?.market?.configured && platformStatus?.providers?.news?.configured;
  const session = platformStatus?.session;
  const marketHealth = platformStatus?.health?.market;
  const accuracyCount = platformStatus?.health?.accuracy?.sampleCount || 0;
  const schedulerObserved = platformStatus?.health?.scheduler?.status === "observed";
  const dataLabel = live
    ? "生产链路已验证"
    : platformStatus?.mode === "live"
      ? `${platformStatus?.health?.top50?.status === "refresh_required" ? "TOP50待完整重算" : marketHealth?.status === "auction_only" ? "集合竞价快照" : marketHealth?.status === "degraded" ? "行情降级" : "真实数据"} · 准确率${accuracyCount ? `${accuracyCount}样本` : "采集中"} · ${schedulerObserved ? "调度已运行" : "调度待验证"}`
      : marketAndNewsLive ? "真实行情/资讯 · 其他服务待验证" : "演示数据 · 待配置";
  return (
    <header className="app-header">
      <div className="header-title">
        <button className="mobile-menu" onClick={onMenu} aria-label="打开导航"><IconMenu2 size={20} /></button>
        <strong>{title}</strong>
        <span>{session?.date || "A股交易日"}</span>
        <span>{session?.label || "上海时间"}</span>
        <span className={`data-state ${live ? "" : "degraded"}`} title={marketHealth?.label || dataLabel}><i /> {dataLabel}</span>
      </div>
      <div className="header-actions">
        <button className="header-search" title="全局搜索" aria-label="全局搜索" onClick={onSearch}><IconSearch size={18} /><span>搜索股票 / 代码 / 行业</span></button>
        <button className="notification" title="通知" aria-label={`通知 ${platformStatus?.notificationCount || 0}条`} onClick={onNotifications}><IconBell size={18} /><em>{platformStatus?.notificationCount || 0}</em></button>
        <button className="profile" aria-label="匿名研究模式"><IconUserCircle size={19} /><span>无需登录</span></button>
      </div>
    </header>
  );
}

function StockSearchDialog({ watchlistedCodes, liveStocks, onToggleWatchlist, onOpenStock, onClose }) {
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);
  const { items, state } = useStockDirectorySearch(query);
  useEffect(() => {
    const previousFocus = document.activeElement;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    inputRef.current?.focus();
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      previousFocus?.focus?.();
    };
  }, [onClose]);
  const results = query.trim() ? items : liveStocks.slice(0, 8).map((item) => ({
    code: item.code,
    name: item.name,
    industry: item.industry,
    market: "TOP50",
  }));
  return (
    <div className="stock-search-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="stock-search-dialog" role="dialog" aria-modal="true" aria-label="全A股搜索与自选管理">
        <header><div><span>全市场股票目录</span><h2>搜索股票并加入自选</h2><p>支持股票名称、6位代码；非TOP50股票加入后进入下一轮行情订阅。</p></div><button onClick={onClose} aria-label="关闭股票搜索"><IconX size={18} /></button></header>
        <label className="stock-search-input"><IconSearch size={19} /><input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="输入股票名称或6位代码，例如：平安银行 / 000001" /><button onClick={() => setQuery("")} aria-label="清空搜索" disabled={!query}><IconX size={15} /></button></label>
        <div className="stock-search-status"><span>{query ? "全A股搜索结果" : "当前TOP50快捷入口"}</span><small>{state === "loading" ? "正在搜索…" : query ? `找到 ${results.length} 只` : "输入关键词搜索全市场"}</small></div>
        <div className="stock-search-list">
          {results.map((item) => {
            const ranked = liveStocks.find((stock) => stock.code === item.code);
            const watched = watchlistedCodes.includes(item.code);
            return <div className="stock-search-row" key={item.code}><button className="stock-search-main" disabled={!ranked} onClick={() => ranked && onOpenStock(ranked)}><span><strong>{item.name}</strong><small>{item.code} · {item.industry || "行业待映射"}</small></span><em>{ranked ? `TOP50 #${ranked.rank}` : item.market || "A股"}</em></button><button className={`stock-search-watch ${watched ? "active" : ""}`} onClick={() => onToggleWatchlist(item)}><IconStar size={15} /> {watched ? "已在自选" : "加入自选"}</button></div>;
          })}
          {query && state === "ready" && !results.length && <div className="stock-search-empty"><IconSearch size={24} /><strong>没有找到匹配股票</strong><p>请检查股票名称或输入6位A股代码。</p></div>}
          {state === "unavailable" && <div className="stock-search-empty"><IconAlertTriangle size={24} /><strong>股票目录暂时不可用</strong><p>不会使用静态名单替代真实搜索结果。</p></div>}
        </div>
      </section>
    </div>
  );
}

const phaseDefinitions = {
  pre: {
    title: "盘前计划",
    status: "待确认",
    action: "生成今日盘前计划",
    placeholder: "补充你的盘前假设、重点观察方向或仓位约束…",
    tasks: [
      { title: "宏观", metric: "风险偏好：中性", summary: "政策窗口平稳，海外科技资本开支仍是主线变量。", source: "宏观与政策 Agent" },
      { title: "资金", metric: "增量资金：温和", summary: "北向与机构资金聚焦通信、电子，成交额预计温和放大。", source: "资金流 Agent" },
      { title: "事件", metric: "重要事件：4项", summary: "中报预告、海外云厂商资本开支、产业会议、限售解禁。", source: "事件雷达 Agent" },
      { title: "计划", metric: "候选标的：5只", summary: "为每只股票明确触发价、失效位、初始仓位与禁止动作。", source: "计划编排 Agent" },
    ],
  },
  live: {
    title: "盘中确认",
    status: "监控中",
    action: "记录盘中应对",
    placeholder: "记录新的异动、信号变化或临时应对…",
    tasks: [
      { title: "异动", metric: "发现异动：12项", summary: "通信设备领涨，半导体设备分化，医药出现承接修复。", source: "异动扫描 Agent" },
      { title: "信号", metric: "有效信号：3个", summary: "2个接近触发、1个失效；只接受量价与板块共振信号。", source: "信号确认 Agent" },
      { title: "风控", metric: "预警：2项", summary: "高估值拥挤与组合集中度需要持续监控。", source: "实时风控 Agent" },
      { title: "应对", metric: "执行状态：等待", summary: "按预案试仓、减仓或撤销，不因分时波动临时改变纪律。", source: "执行应对 Agent" },
    ],
  },
  post: {
    title: "盘后复盘",
    status: "可生成",
    action: "生成盘后复盘",
    placeholder: "补充交易记录、偏差原因或明日重点…",
    tasks: [
      { title: "复盘", metric: "已复核：8笔决策", summary: "逐笔核对计划、实际动作、执行价格与是否遵守纪律。", source: "交易复盘 Agent" },
      { title: "归因", metric: "主要贡献：行业选择", summary: "收益来自行业与个股选择，择时贡献中性，仓位略偏集中。", source: "绩效归因 Agent" },
      { title: "优化", metric: "待优化：3项", summary: "减少追价、提前设置条件单、降低单一主题集中度。", source: "纪律优化 Agent" },
      { title: "明日推演", metric: "情景：3种", summary: "乐观延续、中性轮动、谨慎回撤均配置明确应对动作。", source: "情景推演 Agent" },
    ],
  },
};

function readReviewDrafts() {
  try {
    const stored = JSON.parse(window.localStorage.getItem("stock-review-drafts") || "[]");
    return Array.isArray(stored) ? stored : [];
  } catch {
    return [];
  }
}

function DecisionSummary({ showMarket, goTop50, goPortfolio, goRisk, snapshot, platformStatus }) {
  const ranking = snapshot?.cycles?.["短线"]?.ranking || [];
  const actionable = ranking.filter((item) => item.status === "可试仓").length;
  const highRisk = ranking.filter((item) => item.risk === "高").length;
  const items = [
    {
      label: "市场环境",
      value: platformStatus?.health?.market?.status === "auction_only" ? "集合竞价" : platformStatus?.health?.market?.status === "live" ? "盘中行情" : "待更新",
      change: platformStatus?.snapshots?.market?.marketTime || "--",
      note: platformStatus?.health?.market?.label || "暂无可核验行情快照",
      tone: "yellow",
      icon: IconActivity,
      action: showMarket,
      actionLabel: "查看详情",
    },
    {
      label: "建议仓位",
      value: "未绑定",
      change: "匿名模式",
      note: "未接入真实账户，不生成仓位建议",
      tone: "blue",
      icon: IconBriefcase2,
      action: goPortfolio,
      actionLabel: "仓位管理",
    },
    {
      label: "TOP机会",
      value: `${actionable}只`,
      change: `风险门控池 ${ranking.length}只`,
      note: actionable ? "满足模型试仓线，仍需价格触发" : "当前没有达到可试仓线的标的",
      tone: "red",
      icon: IconTrendingUp,
      action: goTop50,
      actionLabel: "查看机会",
    },
    {
      label: "风险预警",
      value: `${highRisk}只`,
      change: "短线TOP池",
      note: "高风险标的仅观察，不进入执行建议",
      tone: "yellow",
      icon: IconAlertTriangle,
      action: goRisk,
      actionLabel: "查看预警",
    },
  ];

  return (
    <section className="decision-summary" aria-label="今日决策摘要">
      {items.map(({ label, value, change, note, tone, icon: Icon, action, actionLabel }) => (
        <article className={`decision-summary-item ${tone}`} key={label}>
          <div className="decision-summary-label"><Icon size={17} stroke={1.7} /><span>{label}</span></div>
          <strong>{value}</strong>
          <small>{change}</small>
          <p>{note}</p>
          <button onClick={action || undefined} disabled={!action}>{actionLabel}<IconChevronRight size={14} /></button>
        </article>
      ))}
    </section>
  );
}

function FocusedPhaseWorkbench({
  phase,
  setPhase,
  completed,
  setCompleted,
  notes,
  setNotes,
  goAI,
  reviewDrafts,
}) {
  const definition = phaseDefinitions[phase];
  const doneCount = definition.tasks.filter((_, index) => completed[`${phase}-${index}`]).length;
  const phaseLabels = { pre: "盘前计划", live: "盘中确认", post: "盘后复盘" };

  return (
    <section className="panel focused-workbench">
      <header className="focused-workbench-head">
        <div>
          <span>今日决策</span>
          <h1>{definition.title}</h1>
          <p>当前阶段 · 4项研究检查单 · 结论由AI研究室生成</p>
        </div>
        <div className="focused-phase-switch" aria-label="决策阶段">
          {Object.entries(phaseLabels).map(([id, label]) => (
            <button key={id} className={phase === id ? "active" : ""} onClick={() => setPhase(id)}>{label}</button>
          ))}
        </div>
      </header>
      <div className="focused-workbench-body">
        <div className="focused-primary-action">
          <span>下一步行动</span>
          <div className="focused-action-title">
            <i><IconFileAnalytics size={25} stroke={1.6} /></i>
            <div><h2>{definition.action}</h2><p>AI研究室将结合当前真实快照整理证据与风险边界，生成可复核的阶段结论。</p></div>
          </div>
          <div className="focused-action-buttons">
            <button className="primary-button" onClick={() => goAI()}><IconSparkles size={16} /> 在AI研究室生成</button>
            <button onClick={() => goAI()}><IconBrain size={16} /> 问AI复核</button>
          </div>
          <div className="focused-hint">流程模板：进入AI研究室后，系统会携带真实TOP50、资讯和老师知识版本生成结论。</div>
          {phase === "post" && reviewDrafts.length > 0 && <div className="review-draft-preview"><span>AI研究室已加入 {reviewDrafts.length} 条复盘材料</span><strong>{reviewDrafts[0].stock?.name || "市场研究"} · {(reviewDrafts[0].teacherNames || []).join("、") || "AI研究室"}</strong><p>{reviewDrafts[0].summary}</p></div>}
          <details className="focused-note">
            <summary>补充人工备注</summary>
            <textarea value={notes[phase]} onChange={(event) => setNotes((items) => ({ ...items, [phase]: event.target.value }))} placeholder={definition.placeholder} />
          </details>
        </div>
        <div className="focused-progress">
          <div className="focused-progress-head"><span>今日进度</span><strong>{doneCount}/4</strong></div>
          {definition.tasks.map((task, index) => {
            const key = `${phase}-${index}`;
            const checked = Boolean(completed[key]);
            return (
              <button key={key} className={checked ? "completed" : ""} onClick={() => setCompleted((items) => ({ ...items, [key]: !items[key] }))}>
                <i>{checked ? <IconCircleCheck size={15} /> : index + 1}</i>
                <span><strong>{task.title}</strong><small>{checked ? "已人工确认" : "待人工或AI核验"}</small></span>
                <em>{checked ? "已完成" : "待执行"}</em>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function TopOpportunityQueue({ onSelect, goTop50, snapshot }) {
  const cycles = ["超短", "短线", "波段", "中长线"];
  const [cycle, setCycle] = useState("短线");
  const items = useMemo(() => {
    const liveItems = snapshot?.cycles?.[cycle]?.ranking;
    if (liveItems?.length) return liveItems.map(hydrateStock).filter((item) => item.status === "可试仓").slice(0, 5);
    return [];
  }, [cycle, snapshot]);

  return (
    <section className="panel opportunity-queue">
      <header>
        <h2>可执行候选</h2>
        <div aria-label="机会周期">
          {cycles.map((item) => <button key={item} className={cycle === item ? "active" : ""} onClick={() => setCycle(item)}>{item}</button>)}
        </div>
      </header>
      <div className="opportunity-list">
        {!items.length && <div className="account-empty"><IconDatabase size={20} /><strong>{snapshot ? "当前没有达到可执行门槛的候选" : "TOP50真实快照暂不可用"}</strong><p>{snapshot ? "高风险标的仍可在TOP50研究池查看，但不会显示为机会。" : "系统不会回退到静态推荐榜。"}</p></div>}
        {items.map((stock, index) => (
          <div className="opportunity-row" key={`${cycle}-${stock.code}`}>
            <button className="opportunity-main" onClick={() => onSelect(stock)}>
              <b>{index + 1}</b>
              <span><strong>{stock.name}</strong><small>{stock.code} · {stock.industry}</small></span>
              <span><strong className={stock.pct >= 0 ? "price-up" : "price-down"}>{stock.price.toFixed(2)}</strong><small className={stock.pct >= 0 ? "price-up" : "price-down"}>{stock.pct >= 0 ? "+" : ""}{stock.pct}%</small></span>
            </button>
            <button className="opportunity-star" onClick={() => onSelect(stock)} aria-label={`查看${stock.name}`}><IconStar size={16} /></button>
          </div>
        ))}
      </div>
      <button className="opportunity-more" onClick={goTop50}>查看全部机会 <IconChevronRight size={15} /></button>
    </section>
  );
}

function formatDailyAmount(value, unit) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `${(amount / (unit === "yuan" ? 100000000 : 100000)).toFixed(2)}亿` : "--";
}

function getMonitorMetrics(stock) {
  const probability = Number(stock.probabilityUp);
  return {
    volumeRatio: Number.isFinite(Number(stock.volumeRatio)) ? Number(stock.volumeRatio) : null,
    turnover: Number.isFinite(Number(stock.turnoverRate)) ? Number(stock.turnoverRate) : null,
    amount: formatDailyAmount(stock.amount, stock.amountUnit),
    amplitude: Number.isFinite(Number(stock.amplitude)) ? `${Number(stock.amplitude).toFixed(2)}%` : "--",
    pe: Number.isFinite(Number(stock.peTtm)) && Number(stock.peTtm) > 0 ? Number(stock.peTtm).toFixed(1) : "--",
    upProb: Number.isFinite(probability) ? Math.round(probability * 100) : null,
    signal: stock.trend || "暂无量价结论",
    confidence: Number.isFinite(probability) ? Math.round(probability * 100) : null,
  };
}

function SingleStockDecisionCard({ stock, onOpenDetail, onSimulation, onAsk, showDetailAction = true }) {
  const metrics = getMonitorMetrics(stock);
  const { snapshot: marketMetrics, state: marketMetricsState } = useSharedSnapshot(`/api/stocks/${stock.code}/metrics`, 600000);
  const [tracked, setTracked] = useState(true);
  const displayConsensus = Math.min(12, Number(stock.agentVotes ?? stock.consensus ?? 0));
  const gaugeData = [
    { name: "谨慎", value: 35, color: "#f05e65" },
    { name: "中性", value: 30, color: "#d8a63d" },
    { name: "乐观", value: 35, color: "#59bf79" },
  ];
  const recommendation = stock.status === "可试仓" ? "满足触发后可小仓试错" : stock.status === "等待确认" ? "等待右侧确认" : "仅观察";
  const trend = metrics.upProb == null ? "待计算" : metrics.upProb >= 60 ? "偏多" : metrics.upProb >= 50 ? "中性偏多" : "偏弱";

  return (
    <div className="single-stock-workspace">
      <article className="benchmark-stock-card" aria-label={`${stock.name}单股票决策卡`}>
        <header className="benchmark-stock-head">
          <div>
            <h3>{stock.name}<button onClick={onSimulation}><IconBriefcase2 size={13} /> 模拟买入</button></h3>
            <span>{stock.code}</span>
            <small>{Number(stock.rank) > 0 ? "数据来自TOP50冻结行情与12套可审计因子画像" : "数据来自当前A股行情快照；未进入TOP50的因子字段显示“--”"}；未接入字段显示“--”</small>
          </div>
          <div>
            <button className={tracked ? "active" : ""} onClick={() => setTracked((value) => !value)} aria-label={tracked ? "取消追踪" : "开始追踪"}><IconTargetArrow size={16} /></button>
            <StatusBadge status={stock.status} />
          </div>
        </header>

        <div className="benchmark-stock-quote">
          <strong>{stock.price.toFixed(2)}</strong>
          <span className={stock.pct >= 0 ? "price-up" : "price-down"}>{stock.pct >= 0 ? "+" : ""}{stock.pct}%　{stock.pct >= 0 ? "+" : ""}{(stock.price * stock.pct / 100).toFixed(2)}</span>
        </div>

        <div className="benchmark-metric-grid">
          <div><span>量比</span><strong>{metrics.volumeRatio == null ? "--" : metrics.volumeRatio.toFixed(2)}</strong><small>{metrics.volumeRatio == null ? "数据未提供" : metrics.volumeRatio >= 1.8 ? "明显放量" : "正常区间"}</small></div>
          <div><span>换手率</span><strong>{metrics.turnover == null ? "--" : `${metrics.turnover.toFixed(2)}%`}</strong><small>{metrics.turnover == null ? "数据未提供" : metrics.turnover > 2 ? "较活跃" : "正常区间"}</small></div>
          <div><span>成交额</span><strong>{metrics.amount}</strong></div>
          <div><span>振幅 / 市盈率（PE）</span><strong>{metrics.amplitude} / {metrics.pe}</strong></div>
        </div>

        <div className="benchmark-average-grid" aria-label="均价指标">
          <div><span>30日均价</span><strong>{marketMetrics?.ma30 != null && Number.isFinite(Number(marketMetrics.ma30)) ? Number(marketMetrics.ma30).toFixed(2) : "--"}</strong><small>{marketMetrics?.marketDataDate || (marketMetricsState === "loading" ? "读取历史行情…" : "历史数据不足")}</small></div>
          <div><span>60日均价</span><strong>{marketMetrics?.ma60 != null && Number.isFinite(Number(marketMetrics.ma60)) ? Number(marketMetrics.ma60).toFixed(2) : "--"}</strong><small>{marketMetrics?.marketDataDate || (marketMetricsState === "loading" ? "读取历史行情…" : "历史数据不足")}</small></div>
          <div><span>{marketMetrics?.averageMode === "daily_vwap" ? "今日成交均价" : "今日分时均价"}</span><strong>{marketMetrics?.intradayVwap != null && Number.isFinite(Number(marketMetrics.intradayVwap)) ? Number(marketMetrics.intradayVwap).toFixed(2) : "--"}</strong><small>{marketMetrics?.intradayTime && marketMetrics?.intradayVwap != null ? `截至 ${String(marketMetrics.intradayTime).match(/\d{2}:\d{2}/)?.[0] || "--:--"}` : marketMetricsState === "loading" ? "读取行情…" : "当前行情未覆盖"}</small></div>
        </div>

        <div className="benchmark-signal"><IconActivity size={15} /><span>量价信号</span><strong>{metrics.signal}</strong></div>

        <section className="benchmark-decision-block">
          <div className="benchmark-block-head"><span><IconTrendingUp size={14} /> {recommendation}</span><strong>{stock.score}分</strong></div>
          <div className="benchmark-power-track"><i style={{ width: `${(displayConsensus / 12) * 100}%` }} /><b style={{ width: `${(1 - displayConsensus / 12) * 100}%` }} /></div>
          <div className="benchmark-power-labels"><span>{displayConsensus}/12 因子支持</span><span>{12 - displayConsensus}/12未达支持线</span></div>
          <div className="benchmark-factor-tags"><span>画像均分 {stock.agentAverage ?? "--"}</span><span>{metrics.signal}</span><span>风险 {stock.risk || "--"}</span></div>
        </section>

        <section className="benchmark-prediction-block">
          <div className="benchmark-block-head"><span><IconTargetArrow size={14} /> 冻结方向因子 <b>{trend}</b></span><strong>因子 {metrics.confidence == null ? "--" : `${metrics.confidence}/100`}</strong></div>
          <div className="benchmark-prediction-body">
            <div className="benchmark-gauge">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie data={gaugeData} dataKey="value" startAngle={180} endAngle={0} cx="50%" cy="78%" innerRadius="58%" outerRadius="82%" stroke="none">
                    {gaugeData.map((item) => <Cell key={item.name} fill={item.color} />)}
                  </Pie>
                </PieChart>
              </ResponsiveContainer>
              <strong>{metrics.upProb ?? "--"}</strong>
            </div>
            <div className="benchmark-probabilities">
              <div><span>{metrics.upProb == null ? "--" : `${metrics.upProb}/100`}</span><i><b style={{ width: `${metrics.upProb || 0}%` }} /></i><small>看多因子</small></div>
              <div><span>{metrics.upProb == null ? "--" : `${100 - metrics.upProb}/100`}</span><i><b style={{ width: `${metrics.upProb == null ? 0 : 100 - metrics.upProb}%` }} /></i><small>反向因子</small></div>
            </div>
          </div>
          <p><strong>{metrics.upProb == null ? "暂无因子" : `${metrics.upProb}/100`}</strong> · 规则评分，未经概率校准，不是胜率或准确率</p>
          <div className="benchmark-prediction-factors">
            <span><IconCircleCheck size={13} /> {displayConsensus}/12 因子支持</span>
            <span><IconCircleCheck size={13} /> {metrics.signal}</span>
            <span className={stock.risk === "低" ? "" : "warn"}><IconAlertTriangle size={13} /> {stock.risk === "低" ? "尾盘承接积极" : "谨防追高"}</span>
          </div>
        </section>

        <section className="benchmark-flow-block warn">
          <div className="benchmark-block-head"><span><IconBriefcase2 size={14} /> 资金流向</span><strong>{tracked ? "追踪中" : "未追踪"}</strong></div>
          <p>当前数据源未提供可核验的主力净流入与峰值数据，不作推算。</p>
        </section>

        <section className="benchmark-tracking-block">
          <div className="benchmark-block-head"><span><IconTargetArrow size={14} /> 行情追踪</span><strong>冻结快照</strong></div>
          <p>当日高 {Number.isFinite(Number(stock.high)) ? Number(stock.high).toFixed(2) : "--"}　|　当日低 {Number.isFinite(Number(stock.low)) ? Number(stock.low).toFixed(2) : "--"}</p>
          <p>成交额 <b>{metrics.amount}</b>　振幅 <b>{metrics.amplitude}</b></p>
        </section>

        <div className="benchmark-sentiment">
          <div><i /><i /><i /><b style={{ left: `${metrics.upProb || 50}%` }} /></div>
          <span>恐慌</span><span>中性</span><span>乐观</span>
        </div>

        <footer className={`benchmark-stock-actions ${showDetailAction ? "" : "two-actions"}`}>
          <button onClick={onAsk}><IconBrain size={14} /> 问AI复核</button>
          {showDetailAction && <button onClick={onOpenDetail}><IconFileAnalytics size={14} /> 完整分析</button>}
          <button className="primary-button" onClick={onSimulation}><IconBriefcase2 size={14} /> 模拟交易</button>
        </footer>
      </article>

      <aside className="single-stock-context">
        <section>
          <div className="single-context-head"><span>我们的决策增强层</span><StatusBadge status={stock.status} /></div>
          <h3>12套因子画像</h3>
          <div className="single-agent-score"><strong>{displayConsensus}/12</strong><span>看多</span><i><b style={{ width: `${(displayConsensus / 12) * 100}%` }} /></i></div>
          <p>AI不决定排名，只汇总老师证据并检查风险边界。</p>
        </section>
        <section>
          <h3>核心证据</h3>
          <ol>
            <li><IconCircleCheck size={14} /><span><strong>产业与基本面</strong>{stock.reason}</span></li>
            <li><IconCircleCheck size={14} /><span><strong>量价与流动性</strong>{metrics.signal}，成交额 {metrics.amount}</span></li>
            <li><IconCircleCheck size={14} /><span><strong>估值与赔率</strong>{stock.valuation}，综合分 {stock.score}</span></li>
          </ol>
        </section>
        <section className="single-risk-discipline">
          <h3>风险纪律</h3>
          <p><span>允许动作</span><strong>{stock.status === "可试仓" ? "回踩试仓 · 单笔≤5%" : "等待确认 · 不追价"}</strong></p>
          <p><span>触发条件</span><strong>{stock.trigger}</strong></p>
          <p><span>失效条件</span><strong className="price-down">{stock.invalid}</strong></p>
        </section>
      </aside>
    </div>
  );
}

function StockDecisionModal({
  stock,
  watchlisted,
  position,
  total,
  snapshotMeta,
  snapshotState,
  followupActions,
  onToggleWatchlist,
  onToggleFollowup,
  onPrevious,
  onNext,
  onClose,
  onOpenDetail,
  onSimulation,
  onAsk,
  showDetailAction = true,
}) {
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    const handleKeyDown = (event) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") onPrevious();
      if (event.key === "ArrowRight") onNext();
    };

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, onPrevious, onNext]);

  const generatedAt = snapshotMeta?.generatedAt
    ? new Date(snapshotMeta.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })
    : "--:--";
  const currentShanghaiDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date());
  const snapshotFresh = snapshotState === "ready" && snapshotMeta?.tradeDate === currentShanghaiDate && snapshotMeta?.sourceMode === "live" && snapshotMeta?.status === "ready";
  const rankedStock = Number(stock.rank) > 0;
  const stockSnapshotFresh = stock.marketDataDate === currentShanghaiDate && stock.freshness === "live";
  const snapshotLabel = rankedStock
    ? snapshotMeta?.status === "refresh_required" ? "风险过滤旧快照" : snapshotFresh ? "当日快照" : "数据待更新"
    : stockSnapshotFresh ? "当日行情快照" : "数据待更新";
  const taskDefinitions = [
    { id: "price", label: "价格提醒", detail: stock.trigger, icon: IconBell },
    { id: "risk", label: "风险预警", detail: stock.invalid, icon: IconShieldCheck },
    { id: "preMarket", label: "盘前复核", detail: "明日 07:20", icon: IconClock },
  ];

  return (
    <div className="stock-decision-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="stock-decision-modal" role="dialog" aria-modal="true" aria-labelledby="stock-decision-title">
        <header className="stock-modal-head">
          <div className="stock-modal-title">
            <span>{rankedStock ? "TOP50 · 单股决策" : "全A股 · 单股研究"}</span>
            <h2 id="stock-decision-title">{stock.name} <small>{stock.code}</small></h2>
          </div>
          <div className="stock-modal-actions">
            <div className="stock-modal-stepper" aria-label="切换股票">
              <button onClick={onPrevious} aria-label="上一只股票"><IconChevronLeft size={16} /></button>
              <span>{position}/{total}</span>
              <button onClick={onNext} aria-label="下一只股票"><IconChevronRight size={16} /></button>
            </div>
            <button className={watchlisted ? "watchlisted" : ""} onClick={onToggleWatchlist}>
              <IconStar size={16} fill={watchlisted ? "currentColor" : "none"} />
              {watchlisted ? "已加入自选" : "加入自选股"}
            </button>
            <button className="stock-modal-close" onClick={onClose} aria-label="关闭单股决策浮层"><IconX size={18} /></button>
          </div>
        </header>
        <div className="stock-data-trust">
          <span className={snapshotFresh || stockSnapshotFresh ? "fresh" : "stale"}><i /> {snapshotLabel}</span>
          <span><IconClock size={13} /> 行情日期 {stock.marketDataDate || snapshotMeta?.marketDataDate || "待更新"}</span>
          <span><IconDatabase size={13} /> {rankedStock ? `TOP50生成 ${generatedAt}` : `行情快照 ${formatShanghaiTime(stock.observedAt)}`} · 共享缓存 {snapshotMeta?.ttlSeconds || 300}秒</span>
          <span><IconUsersGroup size={13} /> {rankedStock ? snapshotMeta?.selectionEngine || "12套可审计因子画像" : "全A股行情研究"} · AI风险复核</span>
        </div>
        {watchlisted ? (
          <div className="watchlist-actionbar">
            <span><IconCircleCheck size={14} /><b>自选已保存</b><small>本机保存 · 可同步匿名设备提醒</small></span>
            <div>
              {taskDefinitions.map(({ id, label, detail, icon: Icon }) => (
                <button key={id} className={followupActions?.[id] ? "active" : ""} onClick={() => onToggleFollowup(id)}>
                  <Icon size={14} />
                  <span>{followupActions?.[id] ? `已开启${label}` : label}<small>{detail}</small></span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="watchlist-prompt"><IconStar size={14} /> 加入自选后可开启价格提醒、风险预警与盘前复核</div>
        )}
        <div className="stock-modal-scroll">
          <SingleStockDecisionCard stock={stock} onOpenDetail={onOpenDetail} onSimulation={onSimulation} onAsk={onAsk} showDetailAction={showDetailAction} />
        </div>
      </section>
    </div>
  );
}

function StockResearchWorkbench(props) {
  return <StockDecisionModal {...props} />;
}

function IntelligencePanel({ onSelect, onOpenStock, selectedStock, modalOpen, tab, setTab }) {
  const tabs = ["市场全景", "榜单变化", "单股监控"];
  const { snapshot: marketSnapshot, state: marketState } = useSharedSnapshot("/api/market", 60000);
  const marketQuotes = marketSnapshot?.quotes || [];
  const upCount = marketQuotes.filter((item) => Number(item.pct) > 0).length;
  const flatCount = marketQuotes.filter((item) => Number(item.pct) === 0).length;
  const downCount = marketQuotes.filter((item) => Number(item.pct) < 0).length;

  return (
    <section className="panel intelligence-panel">
      <div className="intelligence-tabs" aria-label="市场情报视图">
        {tabs.map((item) => (
          <button
            key={item}
            className={(item === "单股监控" ? modalOpen : !modalOpen && tab === item) ? "active" : ""}
            onClick={() => item === "单股监控" ? onOpenStock(selectedStock) : setTab(item)}
          >
            {item}
          </button>
        ))}
      </div>
      {tab === "市场全景" && (
        <div className="market-overview-strip">
          <div><span>行情快照</span><strong>{marketState === "ready" ? marketSnapshot?.meta?.marketTime || marketSnapshot?.meta?.provider || "已读取" : "待更新"}</strong><p>{marketSnapshot?.meta?.session === "opening_auction" ? "09:25集合竞价" : marketSnapshot?.meta?.disclaimer || "暂无行情"}</p></div>
          <div><span>快照涨跌分布</span><div className="breadth-numbers"><b className="price-up">{upCount}</b><b>{flatCount}</b><b className="price-down">{downCount}</b></div><p>仅统计当前快照 {marketQuotes.length} 只，不代表全市场宽度</p></div>
          <div><span>行业强度</span><strong>--</strong><p>当前数据源未提供可核验的申万行业全量快照</p></div>
          <div><span>资金动向</span><strong>--</strong><p>北向、主力与两融口径尚未接入，不作推算</p></div>
        </div>
      )}
      {tab === "榜单变化" && (
        <div className="account-empty"><IconDatabase size={22} /><strong>榜单变化历史正在积累</strong><p>当前只保存冻结榜单；没有连续历史时不展示静态“新入榜/退出”样例。</p></div>
      )}
    </section>
  );
}

function UsEtfMappingPanel({ onOpenSector }) {
  const { snapshot, state, sourceMode } = useSharedSnapshot("/api/us-etf-map", 1800000, "/data/us-etf-map.json");
  const [filter, setFilter] = useState("all");
  const items = snapshot?.items || [];
  const meta = snapshot?.meta || {};
  const summary = snapshot?.summary || {};
  const freshnessLabel = sourceMode === "live"
    ? `采集于${formatShanghaiDateTime(meta.generatedAt)}`
    : sourceMode === "partial"
      ? `部分更新 ${meta.freshCount || 0}/${items.length || 12}`
      : "最近成功快照";
  const generatedTime = meta.generatedAt
    ? new Date(meta.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" })
    : "--:--";
  const filters = [
    { id: "all", label: "全部", count: items.length },
    { id: "bullish", label: "看多", count: summary.bullish },
    { id: "neutral", label: "中性", count: summary.neutral },
    { id: "bearish", label: "看空", count: summary.bearish },
  ];
  const visibleItems = filter === "all" ? items : items.filter((item) => item.direction === filter);

  return (
    <section className="panel us-etf-map" aria-label="美股ETF映射">
      <header className="us-etf-map-head">
        <div>
          <span><IconWorld size={16} /> 隔夜风险映射</span>
          <h2>美股ETF涨跌 → 今日A股板块预判</h2>
          <p>{meta.marketDate || "等待美股收盘"} · {freshnessLabel} · {meta.provider || "美股ETF行情源"} · 上海时间 {generatedTime}</p>
        </div>
        <div className="us-etf-map-tabs" role="tablist" aria-label="ETF映射方向筛选">
          {filters.map((item) => <button key={item.id} role="tab" aria-selected={filter === item.id} className={`${item.id} ${filter === item.id ? "active" : ""}`} onClick={() => setFilter(item.id)}>{item.label}<b>{item.count ?? "--"}</b></button>)}
        </div>
      </header>
      {state === "loading" && <div className="us-etf-map-loading"><IconRefresh size={16} /> 正在读取隔夜ETF共享缓存…</div>}
      {state !== "loading" && (
        <div className="us-etf-map-grid">
          {visibleItems.map((item) => (
            <button className={`us-etf-map-card ${item.direction}`} key={item.symbol} onClick={() => onOpenSector(item)}>
              <span className="us-etf-map-sector"><strong>{item.aShareSector}</strong><small>{item.symbol} · {item.usSector}{item.freshness === "cached" ? " · 上次有效" : ""}</small></span>
              <span className="us-etf-map-signal">
                <strong>{item.pctChange >= 0 ? "+" : ""}{item.pctChange.toFixed(2)}%</strong>
                <small>{item.label}</small>
              </span>
              <i><b style={{ width: `${item.impactStrength}%` }} /></i>
              <em>影响强度 {item.impactStrength}% · 查看板块TOP50 <IconChevronRight size={12} /></em>
            </button>
          ))}
          {!visibleItems.length && <div className="us-etf-map-empty">当前标签暂无映射结果</div>}
        </div>
      )}
      <footer className="us-etf-map-foot">
        <span><IconInfoCircle size={14} /> {meta.methodology || "按隔夜美股行业ETF收盘涨跌进行方向映射"}</span>
        <small>{meta.disclaimer || "外围映射不等同于A股开盘结果，须经竞价和本地资金确认。"}</small>
      </footer>
    </section>
  );
}

function HomeNewsRail({ onOpenNews, onClose }) {
  const { snapshot, state, sourceMode } = useSharedSnapshot("/api/news", 300000);
  const { snapshot: accuracy } = useSharedSnapshot("/api/accuracy", 300000);
  const [category, setCategory] = useState("要闻");
  const [breakingIndex, setBreakingIndex] = useState(0);
  const [accuracyOpen, setAccuracyOpen] = useState(false);
  const sourceItems = useMemo(() => (snapshot?.items || []).filter((item) => item.tier === "primary"), [snapshot]);
  const isStockNews = (item) => Boolean(item.code || (item.stock && item.stock !== "市场") || item.type === "个股");
  const headlines = sourceItems.filter((item) => item.impact === "高" || ["宏观", "政策", "要闻"].includes(item.type));
  const breakingItems = (headlines.length ? headlines : sourceItems).slice(0, 8);
  const items = useMemo(() => {
    if (category === "个股资讯") return sourceItems.filter(isStockNews).slice(0, 8);
    if (category === "市场资讯") return sourceItems.filter((item) => !isStockNews(item)).slice(0, 8);
    return breakingItems;
  }, [snapshot, category]);
  useEffect(() => {
    if (breakingItems.length < 2) return undefined;
    const timer = window.setInterval(() => setBreakingIndex((index) => (index + 1) % breakingItems.length), 5000);
    return () => window.clearInterval(timer);
  }, [breakingItems.length]);
  const breaking = breakingItems[breakingIndex % Math.max(1, breakingItems.length)];
  const accuracyOverall = accuracy?.overall || {};
  const accuracyHorizons = ["5d", "20d", "60d"].map((id) => accuracy?.horizons?.[id] || { label: id.replace("d", "日"), sampleCount: 0, hitRate: null });

  return (
    <aside className="right-rail home-news-rail">
      <section className="prediction-accuracy">
        <button className="prediction-accuracy-head" onClick={() => setAccuracyOpen((value) => !value)}>
          <span><IconTargetArrow size={15} /> 预测准确率</span><small>冻结预测 · 收盘验证</small><IconChevronDown size={14} />
        </button>
        <div className="accuracy-primary">
          <strong>{accuracyOverall.hitRate == null ? "--" : `${accuracyOverall.hitRate}%`}</strong>
          <span>真实方向命中率</span>
          <small>{accuracyOverall.sampleCount || 0}次验证 · Brier {accuracyOverall.brierScore ?? "--"}</small>
        </div>
        <div className="accuracy-summary">
          {accuracyHorizons.map((item) => (
            <div key={item.label}><strong>{item.hitRate == null ? "--" : `${item.hitRate}%`}</strong><span>{item.label}</span><small>{item.sampleCount}次</small></div>
          ))}
        </div>
        {accuracyOpen && <div className="accuracy-stock-list">
          <h3>按周期验证</h3>
          {Object.entries(accuracy?.cycles || {}).map(([cycle, item]) => <div key={cycle}><span>{cycle}</span><b>{item.hitRate == null ? "--" : `${item.hitRate}%`}</b><small>{item.sampleCount}次</small></div>)}
          <h3>已有样本股票</h3>
          {(accuracy?.byStock || []).slice(0, 5).map((item) => <div key={item.code}><span>{item.name}</span><b>{Number.isFinite(item.hitRate) ? `${item.hitRate}%` : "样本不足"}</b><small>{item.sampleCount}次</small></div>)}
          {!accuracy?.byStock?.length && <p>尚无到期样本。系统不会用模型置信度冒充预测准确率。</p>}
        </div>}
      </section>
      <div className="home-news-head">
        <div>
          <span className={sourceMode === "live" ? "" : "demo-source"}><i /> {sourceMode === "live" ? "LIVE" : "DEMO"}</span>
          <h2><IconNews size={16} /> 定时资讯</h2>
        </div>
        <div className="home-news-actions">
          <small>{state === "ready" ? "5分钟全球聚合" : state === "fallback" ? "演示缓存" : "正在同步"}</small>
          <button onClick={onClose} className="rail-close" aria-label="关闭定时资讯"><IconX size={16} /></button>
        </div>
      </div>
      <div className="home-news-tabs" aria-label="资讯分类">
        {["个股资讯", "市场资讯", "要闻"].map((item) => (
          <button
            key={item}
            role="tab"
            aria-selected={category === item}
            className={category === item ? "active" : ""}
            onClick={() => setCategory(item)}
            onKeyDown={(event) => handleTabKeyNavigation(event, ["个股资讯", "市场资讯", "要闻"], category, setCategory)}
          >
            {item}
          </button>
        ))}
      </div>
      {breaking && <a className="home-breaking-ticker" href={breaking.url} target="_blank" rel="noreferrer"><b>要闻</b><span key={breaking.id}>{breaking.title}</span><time>{breaking.time}</time></a>}
      <div className="home-news-stream">
        {state === "loading" && <div className="home-news-empty"><IconRefresh size={16} /> 正在读取共享资讯缓存…</div>}
        {state !== "loading" && items.length === 0 && <div className="home-news-empty">当前真实资讯源暂无主要级别{category}，不会使用无关内容补位</div>}
        {items.map((item) => (
          <a key={item.id} className="home-news-item" href={item.url} target="_blank" rel="noreferrer">
            <span className="home-news-meta"><time title={item.timestampBasis === "source_updated_at" ? "来源更新时间，非原文发布时间" : "原文发布时间"}>{item.time}{item.timestampBasis === "source_updated_at" ? " 更新" : ""}</time><b className={`news-type type-${item.type}`}>{item.type}</b><i className={item.tone} /></span>
            <strong>{item.title}</strong>
            <small><b>{item.market || "A股"}</b> · {item.source} · {item.score ?? "--"}分 · {describeNewsClassification(item)}</small>
          </a>
        ))}
      </div>
      <button className="home-news-more" onClick={onOpenNews}>进入定时资讯中心 <IconChevronRight size={15} /></button>
    </aside>
  );
}

function MonitorCommandBar({ platformStatus, onSearch, goPortfolio }) {
  const marketHealth = platformStatus?.health?.market;
  const live = marketHealth?.status === "live";
  return (
    <section className="panel monitor-command-bar" aria-label="股票监控控制台">
      <header>
        <div><h1><IconChartDots3 size={18} /> 股票监控</h1><span className={live ? "live" : "warn"}><i /> {live ? "交易中" : marketHealth?.status === "auction_only" ? "集合竞价" : "行情降级"}</span></div>
        <small>{platformStatus?.session?.label || "上海时间"} · 12套因子画像已计算</small>
      </header>
      <div className="monitor-command-actions">
        <button className="monitor-search-trigger" onClick={onSearch}><IconSearch size={16} /><span>输入6位代码或名称添加到自选</span></button>
        <button className="monitor-add-button" onClick={onSearch}><IconPlus size={15} /> 添加</button>
        <button className="monitor-portfolio-button" onClick={goPortfolio}><IconBriefcase2 size={15} /> 自选组合</button>
      </div>
    </section>
  );
}

function WatchlistMonitorPanel({ codes, details, liveStocks, onOpenStock, onAddStock, goPortfolio }) {
  const items = resolveWatchlistStocks(codes, liveStocks, details);
  return (
    <section className="panel home-watchlist-monitor" aria-label="自选监控">
      <header><div><h2><IconBriefcase2 size={15} /> 自选监控 <b>{items.length}只</b></h2><span>与侧边栏、自选组合同步</span></div><button onClick={onAddStock}><IconPlus size={14} /> 添加股票</button></header>
      <div className="home-watchlist-list">
        {items.length ? items.map((stock) => (
          <article key={stock.code} className={stock.decisionAvailable ? "clickable" : ""} onClick={() => stock.decisionAvailable && onOpenStock(stock)}>
            <div><strong>{stock.name}</strong><small>{stock.code} · {stock.industry}</small></div>
            <div><strong className={stock.pct == null ? "" : stock.pct >= 0 ? "price-up" : "price-down"}>{stock.price == null ? "--" : stock.price.toFixed(2)}</strong><small className={stock.pct == null ? "" : stock.pct >= 0 ? "price-up" : "price-down"}>{stock.pct == null ? "待刷新" : `${stock.pct >= 0 ? "+" : ""}${stock.pct}%`}</small></div>
            <span>{stock.decisionAvailable ? `${stock.agentVotes ?? 0}/12 因子支持` : "待下一轮评估"}</span>
          </article>
        )) : <div className="home-watchlist-empty"><span>还没有自选股票</span><button onClick={onAddStock}>搜索并添加</button></div>}
      </div>
      <button className="home-watchlist-more" onClick={goPortfolio}>管理全部自选 <IconChevronRight size={14} /></button>
    </section>
  );
}

function IntegratedNewsFeed({ goNews }) {
  const { snapshot, state, sourceMode } = useSharedSnapshot("/api/news", 300000);
  const [tab, setTab] = useState("市场资讯");
  const [headlineIndex, setHeadlineIndex] = useState(0);
  const source = useMemo(() => (snapshot?.items || []).filter((item) => item.tier === "primary"), [snapshot]);
  const isStock = (item) => Boolean(item.code || (item.stock && item.stock !== "市场") || item.type === "个股");
  const headlines = source.filter((item) => item.impact === "高" || ["宏观", "政策", "要闻"].includes(item.type));
  const tickerItems = (headlines.length ? headlines : source).slice(0, 8);
  const items = (tab === "个股资讯" ? source.filter(isStock) : tab === "市场资讯" ? source.filter((item) => !isStock(item)) : tickerItems).slice(0, 7);
  useEffect(() => {
    if (tickerItems.length < 2) return undefined;
    const timer = window.setInterval(() => setHeadlineIndex((index) => (index + 1) % tickerItems.length), 5000);
    return () => window.clearInterval(timer);
  }, [tickerItems.length]);
  const ticker = tickerItems[headlineIndex % Math.max(1, tickerItems.length)];
  return (
    <section className="integrated-panel integrated-news" aria-label="定时资讯">
<header className="integrated-panel-head"><div><h2>定时资讯</h2><span className={sourceMode === "live" ? "live" : "warn"}><i /> {snapshot?.meta?.collection?.label || (snapshot?.meta?.delayed ? "资讯更新延迟" : sourceMode === "live" ? "真实资讯源" : "最近真实缓存")}</span></div><button onClick={goNews}>资讯中心 <IconChevronRight size={14} /></button></header>
      <div className="integrated-tabs" role="tablist" aria-label="首页资讯分类">{["个股资讯", "市场资讯", "要闻"].map((item) => <button role="tab" aria-selected={tab === item} className={tab === item ? "active" : ""} key={item} onClick={() => setTab(item)} onKeyDown={(event) => handleTabKeyNavigation(event, ["个股资讯", "市场资讯", "要闻"], tab, setTab)}>{item}</button>)}</div>
      {ticker && <a className="integrated-ticker" href={ticker.url} target="_blank" rel="noreferrer"><b>要闻滚动</b><span>{ticker.title}</span><time>{ticker.time}</time></a>}
      <div className="integrated-news-list">
        {state === "loading" && <div className="integrated-empty">正在同步资讯…</div>}
        {state !== "loading" && !items.length && <div className="integrated-empty">当前真实资讯源暂无主要级别{tab}</div>}
        {items.map((item) => <a key={item.id} href={item.url} target="_blank" rel="noreferrer"><time>{item.time}</time><i className={item.tone} /><div><strong>{item.title}</strong><small>{item.source} · {item.market || "A股"} · {item.score ?? "--"}分</small></div></a>)}
      </div>
    </section>
  );
}

function MarketResearchBrief({ platformStatus, top50Snapshot }) {
  const marketHealth = platformStatus?.health?.market;
  const marketReady = ["live", "ready"].includes(marketHealth?.status);
  const accuracySamples = Number(platformStatus?.health?.accuracy?.sampleCount || 0);
  return (
    <section className={`home-market-status terminal-market-summary ${marketReady ? "live" : "degraded"}`} aria-label="首页数据状态">
      <div><i /><strong>{platformStatus?.session?.label || "A股交易日"}</strong><span>{platformStatus?.session?.date || "上海时间"}</span></div>
      <div><IconClock size={16} /><span>行情</span><strong>{marketHealth?.label || "正在读取真实行情"}</strong></div>
      <div><IconDatabase size={16} /><span>榜单</span><strong>{top50Snapshot?.meta?.tradeDate || "待生成"} · {formatShanghaiTime(top50Snapshot?.meta?.generatedAt)}</strong></div>
      <button type="button" title="达到30个成熟样本后公开准确率" aria-label="总体准确率、看涨准确率和看跌准确率达到30个成熟样本后公开"><IconReportAnalytics size={16} /><span>准确率样本</span><strong>{Math.min(accuracySamples, 30)}/30</strong></button>
    </section>
  );
}

function IndustryHeatmap({ activeSector, onSelectSector, goIndustries }) {
  const { snapshot, sourceMode } = useSharedSnapshot("/api/us-etf-map", 1800000, "/data/us-etf-map.json");
  const items = snapshot?.items || [];
  const meta = snapshot?.meta || {};
  const freshnessLabel = sourceMode === "live" ? `采集于${formatShanghaiDateTime(meta.generatedAt)}` : sourceMode === "partial" ? `部分更新 ${meta.freshCount || 0}/${items.length || 12}` : "最近成功快照";
  const ordered = [...items].sort((a, b) => Number(b.pctChange) - Number(a.pctChange));
  const groups = [["涨幅居前", ordered.slice(0, Math.ceil(ordered.length / 2))], ["涨幅居后", ordered.slice(Math.ceil(ordered.length / 2))]];
  return (
    <section className="integrated-panel industry-heatmap" aria-label="隔夜美股ETF影响">
      <header className="integrated-panel-head"><div><h2><IconWorld size={20} /> 隔夜美股ETF影响</h2><span>美股交易日 {meta.marketDate || "待更新"} · {freshnessLabel}</span></div><button onClick={goIndustries}>查看更多 <IconChevronRight size={14} /></button></header>
      <div className="etf-reference-groups">{groups.map(([label, group]) => <section key={label}><h3>{label}<small>非A股行业涨跌</small></h3>{group.map((item) => <button className={activeSector?.symbol === item.symbol ? "selected" : ""} aria-pressed={activeSector?.symbol === item.symbol} key={item.symbol} onClick={() => onSelectSector(activeSector?.symbol === item.symbol ? null : item)} title={`${item.symbol} · ${item.label}${item.freshness === "cached" ? " · 上次有效快照" : ""}`}><IconBuildingFactory2 size={15} /><strong>{item.aShareSector}</strong><b className={item.pctChange >= 0 ? "price-up" : "price-down"}>{item.pctChange >= 0 ? "+" : ""}{Number(item.pctChange).toFixed(2)}%</b></button>)}</section>)}</div>
      <footer><span>{activeSector ? `已联动筛选：${activeSector.aShareSector}` : "点击行业可联动筛选右侧TOP50"}</span><button onClick={goIndustries}>查看全部行业 <IconChevronRight size={14} /></button></footer>
    </section>
  );
}

function HomeTop50Summary({ snapshot, activeSector, onOpenStock, goTop50 }) {
  const windows = [["超短", "超短"], ["短线", "短线"], ["波段", "波段"], ["中长线", "中长线"]];
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", dateStyle: "short" }).format(new Date());
  const [activeCycle, setActiveCycle] = useState("超短");
  const cycleData = snapshot?.cycles?.[activeCycle];
  const ranking = (cycleData?.ranking || []).map(hydrateStock).filter((item) => !activeSector || activeSector.industryKeywords?.some((keyword) => item.industry.includes(keyword)));
  const preview = ranking.slice(0, 5);
  const lastSuccess = formatShanghaiDateTime(snapshot?.meta?.generatedAt);
  const emptyReason = cycleData?.reason || snapshot?.reason || (snapshot ? `${activeCycle}当前没有满足风控门槛的标的` : "真实TOP50快照尚未生成");
  const columns = ["排名", "股票", "行业", "综合分", "因子支持", "状态"];
  return (
    <section className="integrated-panel home-top50-summary design-top50-strip">
      {/* <img className="home-top50-promo" src="/design-reference/top50-promo.png" alt="发现市场最强势的中国力量 TOP50" /> */}
      <header><div><h2>四周期TOP50 · {snapshot?.meta?.tradeDate === today ? "今日冻结" : "最近一期"}</h2>{activeSector && <button className="home-sector-chip" onClick={() => goTop50(activeSector)}>{activeSector.aShareSector} <IconChevronRight size={13} /></button>}</div><span>{snapshot?.meta?.tradeDate || "--"}榜单 · {formatShanghaiTime(snapshot?.meta?.generatedAt)}生成 · 行情基准 {snapshot?.meta?.marketDataDate || "--"}收盘{snapshot?.meta?.tradeDate !== today ? " · 今日榜单未就绪" : ""}</span></header>
      <div className="home-top50-window-tabs" role="tablist" aria-label="首页四周期TOP50">
        {windows.map(([label, cycle]) => (
          <button
            role="tab"
            aria-selected={activeCycle === cycle}
            className={activeCycle === cycle ? "active" : ""}
            key={cycle}
            onClick={() => setActiveCycle(cycle)}
            onKeyDown={(event) => handleTabKeyNavigation(event, windows.map(([, value]) => value), activeCycle, setActiveCycle)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="home-top50-preview-head" role="row">{columns.map((column) => <span role="columnheader" key={column}>{column}</span>)}</div>
      <div className="home-top50-preview-rows" aria-label={`${activeCycle}榜单预览，共${ranking.length}只`}>
        {preview.map((item) => (
          <button className="home-top50-preview-row" role="row" onClick={() => onOpenStock(item)} key={`${activeCycle}:${item.code}`}>
            <b>#{item.rank}</b>
            <span><strong>{item.name}</strong><small>{item.code}</small></span>
            <span>{item.industry}</span>
            <b>{item.score}</b>
            <span>{item.agentVotes}/12</span>
            <StatusBadge status={item.status} />
          </button>
        ))}
        {!preview.length && <div className="home-top50-preview-empty"><strong>{emptyReason}</strong><span>最后成功 {lastSuccess}</span><small>等待下一次 07:20 冻结榜单</small></div>}
      </div>
      <button className="home-summary-detail" onClick={goTop50}>查看详情 <IconChevronRight size={15} /></button>
    </section>
  );
}

function HomeWatchlistSummary({ watchlistedCodes, watchlistDetails, liveStocks, onOpenStock, onEditWatchlist }) {
  const items = resolveWatchlistStocks(watchlistedCodes, liveStocks, watchlistDetails).slice(0, 6);
  return (
    <section className="integrated-panel home-watchlist-summary" aria-label="自选股提醒">
      <header className="integrated-panel-head"><div><h2>我的自选</h2><span>{watchlistedCodes.length ? `${watchlistedCodes.length}只正在跟踪` : "先添加关注股票"}</span></div><button onClick={onEditWatchlist}>{watchlistedCodes.length ? "管理自选" : "添加股票"} <IconChevronRight size={14} /></button></header>
      <div className="home-watchlist-list">
        {items.map((item) => <button disabled={!item.decisionAvailable} onClick={() => onOpenStock(item)} key={item.code}><span><strong>{item.name}</strong><small>{item.code} · {item.industry}</small></span>{item.watchlistDataAvailable ? <b className={item.pct >= 0 ? "price-up" : "price-down"}>{item.pct >= 0 ? "+" : ""}{item.pct}%<small>{item.price.toFixed(2)}</small></b> : <b>待刷新</b>}</button>)}
        {!items.length && <div className="home-watchlist-empty"><IconStar size={22} /><strong>还没有自选股</strong><span>添加股票后，在这里查看今日变化和风险提醒。</span><button onClick={onEditWatchlist}>添加第一只股票</button></div>}
      </div>
    </section>
  );
}

function OverviewPage({
  onOpenStock,
  goNews,
  goTop50,
  goIndustries,
  watchlistedCodes,
  watchlistDetails,
  liveStocks,
  onEditWatchlist,
}) {
  const { snapshot: top50Snapshot } = useSharedSnapshot("/api/top50", 300000);
  const { snapshot: platformStatus } = useSharedSnapshot("/api/status", 60000);
  const [activeSector, setActiveSector] = useState(null);
  return (
    <div className="integrated-home">
      <HomeMetrics status={platformStatus} top50={top50Snapshot} />
      <section className="market-brief-screen">
        <div className="market-brief-grid">
          <IndustryHeatmap activeSector={activeSector} onSelectSector={setActiveSector} goIndustries={goIndustries} />
          <HomeTop50Summary snapshot={top50Snapshot} activeSector={activeSector} onOpenStock={onOpenStock} goTop50={goTop50} />
          <HomeWatchlistSummary watchlistedCodes={watchlistedCodes} watchlistDetails={watchlistDetails} liveStocks={liveStocks} onOpenStock={onOpenStock} onEditWatchlist={onEditWatchlist} />
          <IntegratedNewsFeed goNews={goNews} />
        </div>
      </section>
      <div className="integrated-disclaimer"><IconShieldCheck size={15} /><span>本平台提供的所有信息仅供研究参考，不构成证券投资建议；行情延迟或数据不完整时禁止用于交易执行。</span></div>
    </div>
  );
}

function StockDetailRail({ stock, cycle, cycleData, onClose, goAI }) {
  return (
    <aside className="right-rail stock-detail">
      <div className="stock-detail-head">
        <div><h2>{stock.name} <small>{stock.code}</small></h2><p>{stock.industry}</p></div>
        <button onClick={onClose} aria-label="关闭个股详情"><IconX size={17} /></button>
      </div>
      <div className="stock-quote">
        <strong>{stock.price.toFixed(2)}</strong><span className={stock.pct >= 0 ? "price-up" : "price-down"}>{stock.pct >= 0 ? "+" : ""}{stock.pct}%</span>
        <small>{stock.marketDataDate || "行情截止时间待更新"}</small>
      </div>
      <div className="detail-score-grid">
        <div><span>TOP50排名</span><strong>#{stock.rank}</strong><Change value={stock.change} /></div>
        <div><span>综合分</span><strong>{stock.score}</strong></div>
        <div><span>方向因子</span><strong>{stock.confidence ?? "--"}/100</strong></div>
      </div>
      <div className="detail-section">
        <h3>策略匹配</h3>
        <div className="tag-row"><span>{cycle}</span><span>12套因子加权</span><span>AI复核</span></div>
        <p>持有周期：{cycleData?.holdingPeriod || "2—8周"}</p>
      </div>
      <div className="detail-section agent-consensus-detail">
        <div className="section-line"><h3>{cycle} · 12套因子盘前结果</h3><strong>{stock.agentVotes ?? stock.consensus ?? 0}/12</strong></div>
        <p>领先Agent：{stock.topAgents?.join("、") || "陈江挺、产业调研凌、曾剑枫"}</p>
        <div className="agent-vote-track"><i style={{ width: `${((stock.agentVotes ?? stock.consensus ?? 0) / 12) * 100}%` }} /></div>
      </div>
      <div className="detail-section evidence">
        <div className="section-line"><h3>当前冻结证据</h3><span>{stock.marketDataDate || "截止时间待更新"}</span></div>
        <ol>
          <li><b>因子依据</b><p>{stock.reason || "真实因子依据待更新"}</p></li>
          <li><b>量价状态</b><p>{stock.trend || "真实量价状态待更新"}</p></li>
          <li><b>估值字段</b><p>{stock.valuation || "真实估值字段待更新"}</p></li>
        </ol>
      </div>
      <div className="detail-section risk-list">
        <h3>当前风险边界</h3>
        <p><IconAlertTriangle size={14} /> 风险等级：{stock.risk || "待评估"}</p>
        <p><IconAlertTriangle size={14} /> {stock.invalid || "真实失效位待更新"}</p>
      </div>
      <div className="detail-section trade-state">
        <div><span>交易状态</span><StatusBadge status={stock.status} /></div>
        <p><span>建议关注区间</span><b>{stock.trigger}</b></p>
        <p><span>止损参考</span><b>{stock.invalid}</b></p>
      </div>
      <button className="primary-button" onClick={goAI}><IconBrain size={17} /> 按多策略问AI</button>
      <p className="disclaimer">本信息仅供研究，不构成投资建议。市场有风险，投资需谨慎。</p>
    </aside>
  );
}

function SnapshotBanner({ snapshot, state, sourceMode, cycle, cycleData }) {
  const meta = snapshot?.meta;
  const generatedTime = meta?.generatedAt ? new Date(meta.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" }) : "--:--";
  return (
    <section className="snapshot-banner">
      <div className="snapshot-icon"><IconDatabase size={21} /></div>
      <div className="snapshot-title">
        <span>盘前自动任务</span>
        <strong>{state === "loading" ? "正在读取共享缓存…" : sourceMode === "live" ? `今日${cycle} TOP50已自动生成` : `${cycle}演示快照 · 待接入真实行情`}</strong>
        <small>{sourceMode === "live" ? "12套可审计因子画像基于真实行情加权 · AI只做证据汇总与风险复核" : "真实行情不可用，不生成排名"}</small>
      </div>
      <div className="snapshot-flow">
        <div><span>全市场</span><strong>{meta?.marketUniverse || "--"}</strong></div>
        <IconChevronRight size={15} />
        <div><span>初筛候选</span><strong>{meta?.candidateCount || "--"}</strong></div>
        <IconChevronRight size={15} />
        <div><span>因子画像</span><strong>{meta?.completedAgents || "--"}/{meta?.agentCount || 12}</strong></div>
        <IconChevronRight size={15} />
        <div><span>最终入选</span><strong>{meta?.selectedCount || 50}</strong></div>
      </div>
      <div className="snapshot-cache">
        <span className={sourceMode === "live" ? "" : "demo-source"}><i /> {sourceMode === "live" ? "真实共享缓存已就绪" : "演示备用快照"}</span>
        <strong>{cycleData?.snapshotId || "等待真实快照"}</strong>
        <small>生成 {generatedTime} · A股交易日 07:20 自动运行</small>
        {meta?.riskGate?.requiresRegeneration && <small className="price-down">旧快照已即时风险过滤，当前{cycle}剩余{cycleData?.ranking?.length || 0}只；下次生成补齐完整门槛。</small>}
      </div>
    </section>
  );
}

function CycleMethodStrip({ cycle, cycleData, meta }) {
  return (
    <section className="cycle-method-strip" aria-label={`${cycle}选股方法`}>
      <div className="method-lead">
        <span>本周期选股引擎</span>
        <strong>{meta?.selectionEngine || "等待真实因子快照"}</strong>
        <small>AI不直接决定排名，只负责{meta?.aiRole || "证据汇总与风险复核"}</small>
      </div>
      <div className="method-focus">
        <span>{cycle}关注重点</span>
        <strong>{cycleData?.focus || "产业景气、趋势结构与风险收益比"}</strong>
        <small>建议持有：{cycleData?.holdingPeriod || "2—8周"}</small>
      </div>
      <div className="method-weights">
        <span>核心Agent权重</span>
        <div>
          {(cycleData?.weights || []).map((item) => (
            <b key={item.agent}>{item.agent}<small>{item.weight}%</small></b>
          ))}
        </div>
      </div>
    </section>
  );
}

function Top50EvidenceDialog({ evidenceId, evidence, evidenceState, onClose, dialogRef }) {
  if (!evidenceId) return null;
  const selectionEvidence = evidence?.selectionEvidence;
  const prediction = evidence?.prediction;
  const timeline = selectionEvidence?.timeline?.length ? selectionEvidence.timeline : evidence?.events || [];
  return (
    <div className="top50-evidence-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="top50-evidence-dialog" role="dialog" aria-modal="true" aria-labelledby="top50-evidence-title" ref={dialogRef} tabIndex="-1">
        <header>
          <div>
            <span>冻结选股证据</span>
            <h2 id="top50-evidence-title">{prediction?.name || prediction?.code || evidenceId}</h2>
            <p>{prediction?.code || evidenceId} · {displayField(selectionEvidence?.cycle || prediction?.cycle, "周期待补充")} · {displayField(prediction?.horizonLabel || prediction?.horizon, "期限待补充")}</p>
          </div>
          <button onClick={onClose} aria-label="关闭选股证据"><IconX size={17} /></button>
        </header>
        {evidenceState === "loading" && <div className="top50-evidence-state">正在读取冻结选股证据…</div>}
        {evidenceState === "unavailable" && <div className="top50-evidence-state"><IconAlertTriangle size={18} /><strong>选股证据暂不可用</strong><p>未能读取该 predictionId 的冻结记录；系统不会改用其他股票或静态样例补位。</p></div>}
        {evidenceState === "ready" && evidence && selectionEvidence && (
          <div className="top50-evidence-body">
            <div className="top50-evidence-meta">
              <div><span>入选理由</span><strong>{displayField(selectionEvidence.reason, "未记录")}</strong></div>
              <div><span>冻结批次</span><strong>{displayField(selectionEvidence.cycleSnapshotId || selectionEvidence.snapshotId, "未记录")}</strong></div>
              <div><span>来源截止</span><strong>{formatShanghaiDateTime(evidence.dataCutoff || selectionEvidence.dataCutoff, true)}</strong></div>
              <div><span>评估截止</span><strong>{displayField(prediction?.maturityTradeDate, "待到期验证")}</strong></div>
            </div>

            <section className="top50-evidence-section">
              <h3>因子拆解</h3>
              <div className="top50-evidence-factor-list">
                {(selectionEvidence.factorBreakdown || []).map((item) => (
                  <article key={`${item.agent}-${item.weight}`}>
                    <strong>{item.agent}</strong>
                    <span>权重 {item.weight}% · 原始 {item.score ?? "--"} · 贡献 {item.contribution ?? "--"}</span>
                    <p>{item.thesis || item.style || "未记录额外说明"}</p>
                  </article>
                ))}
              </div>
            </section>

            <section className="top50-evidence-section">
              <h3>Agent 观点</h3>
              <div className="top50-evidence-agent-columns">
                <div>
                  <span>支持 Agent</span>
                  {(selectionEvidence.supportingAgents || []).length
                    ? <ul>{selectionEvidence.supportingAgents.map((item) => <li key={`${item.agent}-${item.score}`}><strong>{item.agent}</strong><span>{item.score ?? "--"}分 · {item.rationale || item.style || "未记录"}</span></li>)}</ul>
                    : <p>暂无达到支持阈值的 Agent 记录。</p>}
                </div>
                <div>
                  <span>反对 Agent</span>
                  {(selectionEvidence.opposingAgents || []).length
                    ? <ul>{selectionEvidence.opposingAgents.map((item) => <li key={`${item.agent}-${item.score}`}><strong>{item.agent}</strong><span>{item.score ?? "--"}分 · {item.concern || item.style || "未记录"}</span></li>)}</ul>
                    : <p>暂无明确反对意见。</p>}
                </div>
              </div>
            </section>

            <section className="top50-evidence-section">
              <h3>触发与失效</h3>
              <div className="top50-evidence-rule-grid">
                <article>
                  <span>触发条件</span>
                  <strong>{displayField(selectionEvidence.trigger?.rule, "未记录")}</strong>
                  <p>{displayField(selectionEvidence.trigger?.context, "未记录")} · 价格 {displayField(selectionEvidence.trigger?.price, "--")}</p>
                </article>
                <article>
                  <span>失效条件</span>
                  <strong>{displayField(selectionEvidence.invalidation?.rule, "未记录")}</strong>
                  <p>{displayField(selectionEvidence.invalidation?.context, "未记录")} · 价格 {displayField(selectionEvidence.invalidation?.price, "--")}</p>
                </article>
              </div>
            </section>

            <section className="top50-evidence-section">
              <h3>评估时间线</h3>
              {timeline.length
                ? <ol className="top50-evidence-timeline">{timeline.map((item, index) => <li key={`${item.type || "event"}-${item.occurredAt || index}`}><strong>{displayField(item.type, "事件")}</strong><time>{formatShanghaiDateTime(item.occurredAt, true)}</time><p>{displayField(item.reason, "未记录说明")}</p></li>)}</ol>
                : <p className="top50-evidence-empty">暂无后续评估事件；系统仅展示该 predictionId 的冻结记录。</p>}
            </section>
          </div>
        )}
      </section>
    </div>
  );
}

function Top50StatusBar({ snapshot, state, cycle, count }) {
  return (
    <div className="top50-status-bar">
      <span className={state === "ready" ? "ready" : "warn"}><i /> {state === "ready" ? "真实冻结榜单" : "正在读取榜单"}</span>
      <span>周期 <strong>{cycle}</strong></span>
      <span>入选 <strong>{count}只</strong></span>
      <span>榜单日 <strong>{snapshot?.meta?.tradeDate || "--"}</strong></span>
      <span>行情截止 <strong>{snapshot?.meta?.marketDataDate || "--"}</strong></span>
      <span>生成 <strong>{formatShanghaiTime(snapshot?.meta?.generatedAt)}</strong></span>
    </div>
  );
}

function Top50Page({ selected, setSelected, sectorFilter, onClearSectorFilter, watchlistedCodes, onToggleWatchlist, followupActions, onToggleFollowup, goStockAI, goSimulation }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [cycle, setCycle] = useState("超短");
  const [showFilters, setShowFilters] = useState(false);
  const [evidenceId, setEvidenceId] = useState(null);
  const [evidence, setEvidence] = useState(null);
  const [evidenceState, setEvidenceState] = useState("idle");
  const triggerRef = useRef(null);
  const dialogRef = useRef(null);
  const evidenceRequestRef = useRef({ token: 0, predictionId: null });
  const { snapshot, state, sourceMode } = useSharedSnapshot("/api/top50", 300000);
  const cycleData = snapshot?.cycles?.[cycle];
  const rankedStocks = useMemo(() => {
    return (cycleData?.ranking || []).map(hydrateStock).sort((a, b) => a.rank - b.rank);
  }, [cycleData]);
  const filtered = useMemo(() => rankedStocks.filter((stock) => {
    const matchesQuery = `${stock.name}${stock.code}${stock.industry}`.includes(query.trim());
    const matchesSector = !sectorFilter || sectorFilter.industryKeywords.some((keyword) => stock.industry.includes(keyword));
    return matchesQuery && matchesSector;
  }), [query, rankedStocks, sectorFilter]);
  const pageCount = Math.max(1, Math.ceil(filtered.length / 10));
  const currentPage = Math.min(page, pageCount);
  const pageStocks = filtered.slice((currentPage - 1) * 10, currentPage * 10);
  useEffect(() => { setPage(1); }, [query, cycle, sectorFilter]);
  const selectedCycleStock = selected ? rankedStocks.find((stock) => stock.code === selected.code) : null;
  const selectedIndex = selectedCycleStock ? rankedStocks.findIndex((stock) => stock.code === selectedCycleStock.code) : -1;
  const changeSelected = (offset) => {
    if (!rankedStocks.length) return;
    const nextIndex = (selectedIndex + offset + rankedStocks.length) % rankedStocks.length;
    setSelected(rankedStocks[nextIndex]);
  };
  const closeEvidence = () => {
    evidenceRequestRef.current = { token: evidenceRequestRef.current.token + 1, predictionId: null };
    setEvidenceId(null);
    setEvidence(null);
    setEvidenceState("idle");
    focusWithAnimationFrame(triggerRef.current);
  };
  useEffect(() => {
    if (!evidenceId) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") closeEvidence();
    };
    document.addEventListener("keydown", onKeyDown);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [evidenceId]);
  const openEvidence = (stock, event) => {
    const predictionId = stock?.predictionId;
    if (!predictionId) return;
    event.stopPropagation();
    triggerRef.current = event.currentTarget;
    const request = { token: evidenceRequestRef.current.token + 1, predictionId };
    evidenceRequestRef.current = request;
    setEvidenceId(predictionId);
    setEvidence(null);
    setEvidenceState("loading");
    fetch(`/api/top50/evidence?predictionId=${encodeURIComponent(predictionId)}`, { cache: "no-cache" })
      .then((response) => {
        if (!response.ok) throw new Error(`Evidence request failed: ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (!isCurrentEvidenceRequest(evidenceRequestRef.current, request)) return;
        setEvidence(data);
        setEvidenceState("ready");
      })
      .catch(() => {
        if (!isCurrentEvidenceRequest(evidenceRequestRef.current, request)) return;
        setEvidenceState("unavailable");
      });
  };
  return (
    <div className="page-grid top50-page">
      <main className="primary-workspace">
        <Top50StatusBar snapshot={snapshot} state={state} cycle={cycle} count={filtered.length} />
        <div className="page-toolbar">
          <div className="segmented" role="tablist" aria-label="TOP50周期切换">
            {["超短", "短线", "波段", "中长线"].map((item) => <button role="tab" aria-selected={cycle === item} className={cycle === item ? "active" : ""} onClick={() => setCycle(item)} onKeyDown={(event) => handleTabKeyNavigation(event, ["超短", "短线", "波段", "中长线"], cycle, setCycle)} key={item}>{item}</button>)}
          </div>
          <label className="search-field"><IconSearch size={15} /><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索股票 / 代码 / 行业" /></label>
          <button className={showFilters ? "toolbar-button active" : "toolbar-button"} onClick={() => setShowFilters(!showFilters)}><IconFilter size={15} /> 筛选</button>
        </div>
        {sectorFilter && (
          <div className={`sector-filter-banner ${sectorFilter.direction}`}>
            <IconWorld size={15} />
            <span>隔夜ETF映射：<strong>{sectorFilter.aShareSector}</strong></span>
            <b>{sectorFilter.symbol} {sectorFilter.pctChange >= 0 ? "+" : ""}{sectorFilter.pctChange.toFixed(2)}% · {sectorFilter.label}</b>
            <button onClick={onClearSectorFilter}><IconX size={14} /> 清除板块筛选</button>
          </div>
        )}
        {showFilters && (
          <div className="filter-bar">
            <span>策略：12套可审计因子画像</span><span>行业：全部</span><span>硬门槛：上市≥90天</span><span>排除涨跌停/低流动性/风险警示</span><button onClick={() => setShowFilters(false)}>收起</button>
          </div>
        )}
        <div className="table-wrap">
          <table className="decision-table">
            <thead><tr><th>排名</th><th>股票/代码</th><th>所属行业</th><th>综合分</th><th>因子支持</th><th>状态</th><th>为什么入选</th><th>失效条件</th><th>行情日</th><th>操作</th></tr></thead>
            <tbody>
              {pageStocks.map((stock) => (
                <tr className={selected?.code === stock.code ? "selected" : ""} onClick={() => setSelected(stock)} key={stock.code}>
                  <td><span className={`rank rank-${stock.rank}`}>{stock.rank}</span></td>
                  <td><strong>{stock.name}</strong><small>{stock.code}</small></td>
                  <td><b>{stock.industry || "--"}</b></td>
                  <td><b className="score-value">{stock.score}</b></td>
                  <td><b className="agent-vote-value">{stock.agentVotes ?? stock.consensus ?? 0}<small>/12</small></b></td>
                  <td><StatusBadge status={stock.status} /></td>
                  <td><span className="top50-reason">{stock.reason || stock.trend}</span></td>
                  <td><span className="top50-invalid">{stock.invalid || "待更新"}</span></td>
                  <td><time>{stock.marketDataDate || snapshot?.meta?.marketDataDate || "--"}</time></td>
                  <td><button className="table-action evidence-trigger" onClick={(event) => openEvidence(stock, event)} disabled={!stock.predictionId}>查看证据</button></td>
                </tr>
              ))}
              {!filtered.length && <tr><td colSpan="10"><div className="top50-table-empty"><strong>{query.trim() ? "没有符合当前搜索条件的标的" : displayField(snapshot?.reason, `${cycle}暂无可展示榜单`)}</strong><small>最后成功 {formatShanghaiDateTime(snapshot?.meta?.generatedAt)} · 等待下一次 07:20 冻结榜单</small></div></td></tr>}
            </tbody>
          </table>
          <div className="table-footer"><span>共 {filtered.length} 只 · 每页10只{sectorFilter ? ` · ${sectorFilter.aShareSector}` : ""}</span><div><button aria-label="上一页" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}><IconChevronLeft size={15} /></button>{Array.from({ length: pageCount }, (_, index) => index + 1).map((number) => <button className={number === currentPage ? "active" : ""} aria-label={`第${number}页`} aria-current={number === currentPage ? "page" : undefined} onClick={() => setPage(number)} key={number}>{number}</button>)}<button aria-label="下一页" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}><IconChevronRight size={15} /></button></div></div>
        </div>
        <div className="top50-mobile-list" aria-label={`${cycle}移动榜单`}>
          {filtered.map((stock) => (
            <article className="top50-mobile-card" key={`${cycle}-${stock.code}`} onClick={() => setSelected(stock)}>
              <div className="top50-mobile-head">
                <strong>#{stock.rank} {stock.name}</strong>
                <StatusBadge status={stock.status} />
              </div>
              <p>{stock.code} · {stock.industry}</p>
              <div className="top50-mobile-metrics">
                <span>综合分 <b>{stock.score}</b></span>
                <span>因子支持 <b>{stock.agentVotes ?? stock.consensus ?? 0}/12</b></span>
                <span>方向因子 <b>{stock.confidence ?? "--"}/100</b></span>
                <span>领先画像 <b>{stock.topAgents?.[0] || "产业调研"}</b></span>
              </div>
              <small>{stock.reason || stock.trend}</small>
              <div className="top50-mobile-actions">
                <button onClick={(event) => { event.stopPropagation(); setSelected(stock); }}>查看详情</button>
                <button className="primary" onClick={(event) => openEvidence(stock, event)} disabled={!stock.predictionId}>选股证据</button>
              </div>
              <small className="top50-mobile-cutoff">行情日 {stock.marketDataDate || snapshot?.meta?.marketDataDate || "--"} · 失效：{stock.invalid || "待更新"}</small>
            </article>
          ))}
          {!filtered.length && <div className="top50-mobile-empty"><strong>{query.trim() ? "没有符合当前搜索条件的标的" : displayField(snapshot?.reason, `${cycle}暂无可展示榜单`)}</strong><span>最后成功 {formatShanghaiDateTime(snapshot?.meta?.generatedAt)}</span><small>等待下一次 07:20 冻结榜单</small></div>}
        </div>
        <details className="top50-method-disclosure">
          <summary>查看选股方法、数据范围与Agent权重</summary>
          <SnapshotBanner snapshot={snapshot} state={state} sourceMode={sourceMode} cycle={cycle} cycleData={cycleData} />
          <CycleMethodStrip cycle={cycle} cycleData={cycleData} meta={snapshot?.meta} />
        </details>
      </main>
      <Top50EvidenceDialog evidenceId={evidenceId} evidence={evidence} evidenceState={evidenceState} onClose={closeEvidence} dialogRef={dialogRef} />
      {selectedCycleStock && (
        <StockResearchWorkbench
          stock={selectedCycleStock}
          watchlisted={watchlistedCodes.includes(selectedCycleStock.code)}
          position={selectedIndex + 1}
          total={rankedStocks.length}
          snapshotMeta={snapshot?.meta}
          snapshotState={state}
          followupActions={followupActions[selectedCycleStock.code] || {}}
          onToggleWatchlist={() => onToggleWatchlist(selectedCycleStock.code)}
          onToggleFollowup={(type) => onToggleFollowup(selectedCycleStock.code, type)}
          onPrevious={() => changeSelected(-1)}
          onNext={() => changeSelected(1)}
          onClose={() => setSelected(null)}
          onSimulation={() => goSimulation(selectedCycleStock)}
          onAsk={() => goStockAI(selectedCycleStock)}
          showDetailAction={false}
        />
      )}
    </div>
  );
}

function EmptySelection() {
  return <aside className="right-rail empty-rail"><IconChartDots3 size={34} /><h2>选择一只股票</h2><p>查看入选证据、策略共识、风险和执行条件。</p></aside>;
}

function NewsPage() {
  const { snapshot, state, sourceMode } = useSharedSnapshot("/api/news", 300000);
  const [category, setCategory] = useState("主要");
  const [query, setQuery] = useState("");
  const [top50Only, setTop50Only] = useState(false);
  const [visibleCount, setVisibleCount] = useState(8);
  const items = snapshot?.items || [];
  const filtered = useMemo(() => items.filter((item) => {
    const matchesCategory = newsCategoryMatches(item, category);
    const matchesQuery = `${item.stock}${item.code}${item.title}${item.source}`.includes(query.trim());
    const matchesTop50 = !top50Only || Boolean(item.relatedTop50Rank);
    return matchesCategory && matchesQuery && matchesTop50;
  }), [items, category, query, top50Only]);
  const meta = snapshot?.meta;
  return (
    <div className="page-grid news-page">
      <main className="primary-workspace news-workspace">
        <div className="news-statusbar">
          <div><span className="live-pulse" /><strong>全球影响资讯流</strong><small>北京时间交易日8轮采集；非交易日2轮</small></div>
          <div><IconDatabase size={14} /><span>{meta?.collection?.label || (meta?.delayed ? "资讯更新延迟 · 最近真实缓存" : sourceMode === "live" ? "真实API共享缓存" : "等待真实资讯")}</span><b>{meta?.snapshotId || "等待真实快照"}</b></div>
          <div><span>最后同步</span><strong>{meta?.generatedAt ? new Date(meta.generatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }) : "--:--"}</strong><small>{category} {filtered.length} 条 / 共 {meta?.itemCount || items.length} 条</small></div>
        </div>
        <div className="news-toolbar">
          <div className="news-tabs" role="tablist" aria-label="资讯层级切换">
            {newsCategories.map((item) => <button role="tab" aria-selected={category === item} className={category === item ? "active" : ""} onClick={() => { setCategory(item); setVisibleCount(8); }} onKeyDown={(event) => handleTabKeyNavigation(event, newsCategories, category, setCategory)} key={item}>{item}</button>)}
          </div>
          <label className="search-field"><IconSearch size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索资讯 / 股票 / 代码" /></label>
          <button className={`top50-toggle ${top50Only ? "active" : ""}`} onClick={() => setTop50Only(!top50Only)}><IconStar size={14} /> 仅TOP50</button>
        </div>
        <div className="news-reference-grid"><section className="panel news-stream">
          <div className="panel-head"><div><h2>最新资讯</h2><span>显示分数、分类原因与 A 股传导路径；标题直达原文</span></div><span className={`stream-state ${sourceMode === "live" ? "" : "warn"}`}><i /> {sourceMode === "live" ? "真实源在线" : "待配置API"}</span></div>
          {state === "loading" && <div className="news-empty"><IconRefresh size={18} /> 正在读取共享资讯缓存…</div>}
          {state !== "loading" && filtered.length === 0 && <div className="news-empty">没有符合当前层级与筛选条件的资讯</div>}
          {filtered.slice(0, visibleCount).map((item) => (
            <a className="news-row" href={item.url} target="_blank" rel="noreferrer" key={item.id}>
              <span className={`news-type type-${item.type}`}>{newsTierLabel(item)}</span>
              <span className="news-time" title={item.timestampBasis === "source_updated_at" ? "来源更新时间，非原文发布时间" : "原文发布时间"}>{item.time}{item.timestampBasis === "source_updated_at" ? " 更新" : ""}</span>
              <span className="news-main"><strong>{item.title}</strong><small><b>{item.market || "A股"}</b> · {item.source} · {item.score ?? "--"}分 · {describeNewsClassification(item)}{item.marketImpact?.length ? ` · A股影响：${item.marketImpact.join(" / ")}` : ""}</small><em className="news-score-reason">{summarizeNewsScoreBreakdown(item.scoreBreakdown)}</em></span>
              {item.relatedTop50Rank && <span className="news-rank">TOP50 #{item.relatedTop50Rank}</span>}
              <span className={`news-impact ${item.tone}`}><i /> {item.impact}影响</span>
              <IconChevronRight size={15} />
            </a>
          ))}
          {visibleCount < filtered.length && <button className="load-more" onClick={() => setVisibleCount((count) => count + 8)}>加载更多资讯 <IconChevronDown size={15} /></button>}
        </section>
        <aside className="panel news-focus"><h2>市场焦点</h2><p>来自当前真实资讯快照 · 标题直达原文</p>{[...items].sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, 6).map((item) => <a key={item.id} href={item.url} target="_blank" rel="noreferrer"><strong>{item.title}</strong><small>{item.source} · {item.time}</small></a>)}{!items.length && <p>暂无已核验资讯，不使用示例新闻补位。</p>}</aside></div>
      </main>
    </div>
  );
}

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

function ToolStockSelect({ value, onChange, items = [] }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)}>
      {items.map((stock) => <option value={stock.code} key={stock.code}>{stock.name} · {stock.code}</option>)}
    </select>
  );
}

function QuantEmpty({ label = "运行后显示真实结果" }) {
  return <div className="account-empty"><IconDatabase size={22} /><strong>{label}</strong><p>本页不会用静态样例或公式推算替代接口结果。</p></div>;
}

function QuantToolkitPage({ initialTool = "market", initialStock }) {
  const [tool, setTool] = useState(initialTool);
  const [cycle, setCycle] = useState("波段");
  const [stockCode, setStockCode] = useState(initialStock?.code || "");
  const [feedback, setFeedback] = useState("");
  const [toolResult, setToolResult] = useState(null);
  const [quantity, setQuantity] = useState(100);
  const [emotion, setEmotion] = useState("逻辑驱动");
  const [accountTab, setAccountTab] = useState("持仓");
  const [cash, setCash] = useState(1000000);
  const [positionQuantity, setPositionQuantity] = useState(0);
  const [trades, setTrades] = useState([]);
  const [backtestStart, setBacktestStart] = useState("2025-01-01");
  const [backtestEnd, setBacktestEnd] = useState(() => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(new Date()));
  const { snapshot: platformStatus } = useSharedSnapshot("/api/status", 60000);
  const { snapshot: accuracy } = useSharedSnapshot("/api/accuracy", 60000);
  const { snapshot: top50Snapshot } = useSharedSnapshot("/api/top50", 300000);
  const stockOptions = useMemo(() => {
    const ranked = (top50Snapshot?.cycles?.[cycle]?.ranking || []).map(hydrateStock);
    if (!initialStock?.code || ranked.some((item) => item.code === initialStock.code)) return ranked;
    return [hydrateStock(initialStock), ...ranked];
  }, [cycle, top50Snapshot, initialStock]);
  const stock = stockOptions.find((item) => item.code === stockCode) || stockOptions[0] || hydrateStock(initialStock || {});
  const positionValue = Math.round(positionQuantity * stock.price);
  const totalAssets = cash + positionValue;
  const marketSourceStatusLabel = ({ live: "实时", partial: "部分更新", snapshot: "缓存快照", stale: "缓存快照", unavailable: "不可用" })[toolResult?.marketSource?.status] || toolResult?.marketSource?.status || "不可用";
  useEffect(() => {
    if (!stockCode && stockOptions[0]) setStockCode(stockOptions[0].code);
  }, [stockCode, stockOptions]);
  const run = async (message, requestedTool = tool, extra = {}) => {
    setFeedback("正在读取冻结因子榜与真实数据源…");
    setToolResult(null);
    try {
      const response = await fetch(`/api/quant/${requestedTool}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ stockCode: stock.code, cycle, quantity, action: message, ...extra }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.reason || result.error || "量化服务暂不可用");
      setToolResult(result.result);
      setFeedback(`${message} · 内置因子计算已完成 · ${new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}`);
    } catch (error) {
      setFeedback(`量化计算未运行：${error.message}。系统不会用静态结果冒充运行结果。`);
    }
  };
  const localFeedback = (message) => setFeedback(`${message} · 仅保存在本机模拟账户`);
  const trade = (side) => {
    const amount = Math.round(quantity * stock.price);
    if (side === "买入" && amount <= cash) {
      setCash((value) => value - amount);
      setPositionQuantity((value) => value + quantity);
      setTrades((items) => [{ side, quantity, price: stock.price, stock: stock.name, createdAt: new Date().toISOString(), emotion }, ...items]);
      localFeedback(`模拟买入 ${quantity} 股成功`);
    } else if (side === "卖出" && positionQuantity >= quantity) {
      setCash((value) => value + amount);
      setPositionQuantity((value) => value - quantity);
      setTrades((items) => [{ side, quantity, price: stock.price, stock: stock.name, createdAt: new Date().toISOString(), emotion }, ...items]);
      localFeedback(`模拟卖出 ${quantity} 股成功`);
    } else {
      localFeedback(side === "买入" ? "可用资金不足" : "可卖持仓不足");
    }
  };

  return (
    <div className="simple-page quant-tool-page">
      <div className="page-toolbar">
        <div><h1>量化工具</h1><p>与 TOP50、12套可审计因子画像、风险纪律和模拟研究联动</p></div>
        <span className={`tool-data-state ${platformStatus?.providers?.quant?.configured ? "" : "degraded"}`}><i /> {platformStatus?.providers?.quant?.configured ? "量化接口已配置 · 运行后显示真实结果" : "真实量化引擎待配置"}</span>
      </div>
      <div className="quant-tool-tabs">
        {quantToolTabs.map(({ id, label, icon: Icon }) => (
          <button key={id} className={tool === id ? "active" : ""} onClick={() => { setTool(id); setFeedback(""); setToolResult(null); }}>
            <Icon size={16} /><span>{label}</span>
          </button>
        ))}
      </div>
      {feedback && <div className="tool-feedback"><IconCircleCheck size={15} /><span>{feedback}</span><button onClick={() => setFeedback("")} aria-label="关闭操作反馈"><IconX size={14} /></button></div>}

      {tool === "market" && (
        <div className="tool-workspace">
          <div className="tool-form-row"><select value={cycle} onChange={(event) => setCycle(event.target.value)}>{["超短","短线","波段","中长线"].map((item) => <option key={item}>{item}</option>)}</select><button className="primary-button" onClick={() => run("行情快照已读取", "market")}>读取真实行情快照</button></div>
          <section className="panel screener-result">
            {!toolResult ? <QuantEmpty label="读取后显示行情来源和TOP10" /> : <><div className="panel-head"><div><h2>冻结TOP50因子榜</h2><span>排序：{toolResult.rankingSource?.provider || "待确认"} · 数据日 {toolResult.rankingSource?.dataDate || "--"}；盘中：{toolResult.marketSource?.provider || "不可用"} · {marketSourceStatusLabel}</span></div><strong>{toolResult.top10?.length || 0}只</strong></div><div className="scanner-table"><div className="scanner-head"><span>排名</span><span>股票</span><span>综合分</span><span>共识</span><span>涨跌幅</span><span>状态</span></div>{(toolResult.top10 || []).map((item) => <div key={item.code}><b>#{item.rank}</b><span><strong>{item.name}</strong><small>{item.code}</small></span><em>{item.score}</em><span>{item.agentVotes}/12</span><span className={item.pct >= 0 ? "price-up" : "price-down"}>{item.pct >= 0 ? "+" : ""}{item.pct}%</span><StatusBadge status={item.status || "仅观察"} /></div>)}</div></>}
          </section>
        </div>
      )}

      {tool === "analysis" && (
        <div className="tool-workspace">
          <div className="tool-form-row"><ToolStockSelect value={stock.code} onChange={setStockCode} items={stockOptions} /><button className="primary-button" onClick={() => run("12套因子画像分析已更新", "analysis")}>运行完整分析</button></div>
          {!toolResult ? <QuantEmpty /> : <><section className="panel evaluation-result"><div className="evaluation-score"><span>冻结综合分</span><strong>{toolResult.stock?.score ?? "--"}</strong><p>{toolResult.conclusion}</p></div><div className="evaluation-dimensions">{Object.entries(toolResult.factorScores || {}).map(([label, score]) => <div key={label}><span>{label}</span><div><i style={{ width: `${score}%` }} /></div><b>{Math.round(score)}</b></div>)}</div></section><section className="panel ai-insight-panel"><IconBrain size={22} /><div><span>领先因子画像</span><h2>{toolResult.topAgents?.join("、") || "暂无"}</h2><p>实际支持 {toolResult.agentVotes ?? 0}/12 · 行情日 {toolResult.marketDataDate}</p></div><strong>{toolResult.stock?.score ?? "--"}</strong></section></>}
        </div>
      )}

      {tool === "backtest" && (
        <div className="tool-workspace">
          <div className="tool-form-row">
            <ToolStockSelect value={stock.code} onChange={setStockCode} items={stockOptions} />
            <input type="date" value={backtestStart} onChange={(event) => setBacktestStart(event.target.value)} aria-label="回测开始日期" /><input type="date" value={backtestEnd} onChange={(event) => setBacktestEnd(event.target.value)} aria-label="回测结束日期" />
            <button className="primary-button" onClick={() => run("回测完成", "backtest", { startDate: backtestStart, endDate: backtestEnd })}>开始真实历史回测</button>
          </div>
          {!toolResult ? <QuantEmpty label="选择日期并运行真实历史回测" /> : <><div className="backtest-summary"><div><span>策略收益</span><strong className={toolResult.totalReturn >= 0 ? "price-up" : "price-down"}>{toolResult.totalReturn}%</strong></div><div><span>持仓日胜率</span><strong>{toolResult.investedDayWinRate ?? "--"}%</strong></div><div><span>最大回撤</span><strong className="price-down">{toolResult.maxDrawdown}%</strong></div><div><span>入场次数</span><strong>{toolResult.entries}</strong></div></div><section className="panel backtest-chart-panel"><div className="tool-panel-head"><div><h2>净值曲线</h2><span>{toolResult.strategy}</span></div><span className="tool-legend">{toolResult.startDate}—{toolResult.endDate} · {toolResult.sampleCount}日</span></div><div className="backtest-chart"><ResponsiveContainer width="100%" height="100%"><LineChart data={toolResult.equityCurve || []}><XAxis dataKey="date" hide /><YAxis domain={["auto", "auto"]} hide /><Tooltip /><Line type="monotone" dataKey="strategy" stroke="#4bc38a" strokeWidth={2} dot={false} /><Line type="monotone" dataKey="benchmark" stroke="#7f8da1" strokeWidth={1.5} dot={false} /></LineChart></ResponsiveContainer></div></section></>}
        </div>
      )}

      {tool === "signals" && (
        <div className="tool-workspace">
          <div className="tool-form-row"><ToolStockSelect value={stock.code} onChange={setStockCode} items={stockOptions} /><button className="primary-button" onClick={() => run("风险信号已计算", "signals")}>计算真实因子信号</button></div>
          {!toolResult ? <QuantEmpty /> : <section className="panel evaluation-result"><div className="evaluation-score"><span>因子分歧</span><strong>{toolResult.dispersion ?? "--"}</strong><StatusBadge status={stock.status} /></div><div className="evaluation-dimensions">{Object.entries(toolResult.dimensions || {}).map(([label, score]) => <div key={label}><span>{label}</span><div><i style={{ width: `${score}%` }} /></div><b>{Math.round(score)}</b></div>)}</div><div className="evaluation-actions"><div><span>允许动作</span><strong>{toolResult.allowedAction}</strong></div><div><span>禁止动作</span><strong className="negative">{toolResult.prohibitedAction}</strong></div></div></section>}
        </div>
      )}

      {tool === "screener" && (
        <div className="tool-workspace">
          <div className="tool-form-row screener-form">
            <select value={cycle} onChange={(event) => setCycle(event.target.value)}>{["超短","短线","波段","中长线"].map((item) => <option key={item}>{item}</option>)}</select>
            <button className="primary-button" onClick={() => run("风险门控后的TOP50扫描完成", "screener", { limit: 30 })}>扫描真实TOP50</button>
          </div>
          <section className="panel screener-result">
            {!toolResult ? <QuantEmpty /> : <><div className="panel-head"><div><h2>扫描结果</h2><span>12套因子画像排名 · 硬风险门控已在入池前执行</span></div><strong>{toolResult.items?.length || 0}只</strong></div><div className="scanner-table"><div className="scanner-head"><span>排名</span><span>股票</span><span>综合分</span><span>因子支持</span><span>状态</span><span>操作</span></div>{(toolResult.items || []).map((item) => <div key={item.code}><b>#{item.rank}</b><span><strong>{item.name}</strong><small>{item.code}</small></span><em>{item.score}</em><span>{item.agentVotes}/12</span><StatusBadge status={item.status} /><button onClick={() => { setStockCode(item.code); setTool("predict"); setToolResult(null); }}>预判</button></div>)}</div></>}
          </section>
        </div>
      )}

      {tool === "predict" && (
        <div className="tool-workspace predict-workspace">
          <div className="tool-form-row"><ToolStockSelect value={stock.code} onChange={setStockCode} items={stockOptions} /><select value={cycle} onChange={(event) => setCycle(event.target.value)}>{["超短","短线","波段","中长线"].map((item) => <option key={item}>{item}</option>)}</select><button className="primary-button" onClick={() => run("预判已从冻结TOP50读取", "predict")}>生成预判</button></div>
          <section className="panel predict-result-card">
            <div className="predict-result-head"><div><span>12套因子画像 + AI 风险复核</span><h2>{stock.name} · 短线预判</h2></div><StatusBadge status={stock.status} /></div>
            <div className="predict-probability"><div><span>看多因子</span><strong>{Number.isFinite(toolResult?.probabilityUp) ? `${Math.round(toolResult.probabilityUp * 100)}/100` : "--"}</strong></div><div className="probability-track"><i style={{ width: Number.isFinite(toolResult?.probabilityUp) ? `${toolResult.probabilityUp * 100}%` : "0%" }} /><b style={{ width: Number.isFinite(toolResult?.probabilityUp) ? `${(1 - toolResult.probabilityUp) * 100}%` : "0%" }} /></div><div><span>反向因子</span><strong>{Number.isFinite(toolResult?.probabilityUp) ? `${Math.round((1 - toolResult.probabilityUp) * 100)}/100` : "--"}</strong></div></div>
            <div className="predict-levels"><div><span>参考入场</span><strong>{toolResult?.referencePrice ?? "--"}</strong></div><div><span>目标区间</span><strong className="price-up">{toolResult?.targetRange || "--"}</strong></div><div><span>失效位置</span><strong className="price-down">{toolResult?.invalidPrice ?? "--"}</strong></div><div><span>真实历史命中率</span><strong>{Number.isFinite(accuracy?.overall?.hitRate) ? `${accuracy.overall.hitRate}%` : "--"} <small>{accuracy?.overall?.sampleCount || 0}次</small></strong></div></div>
            <p><IconAlertTriangle size={14} /> 方向因子是规则评分，未经概率校准；只有预先冻结、到达目标交易日且行情完整的预测才计入准确率。</p>
          </section>
        </div>
      )}

      {tool === "evaluate" && (
        <div className="tool-workspace evaluate-workspace">
          <div className="tool-form-row"><ToolStockSelect value={stock.code} onChange={setStockCode} items={stockOptions} /><button className="primary-button" onClick={() => run("风险评估已更新", "evaluate")}>运行评估</button></div>
          <section className="panel evaluation-result">
            {!toolResult ? <QuantEmpty /> : <><div className="evaluation-score"><span>冻结综合评分</span><strong>{toolResult.stock?.score ?? "--"}</strong><StatusBadge status={stock.status} /><p>因子分歧 {toolResult.dispersion ?? "--"}，结果来自当日12套因子画像快照。</p></div><div className="evaluation-dimensions">{Object.entries(toolResult.dimensions || {}).map(([label, score]) => <div key={label}><span>{label}</span><div><i style={{width:`${score}%`}} /></div><b>{Math.round(score)}</b></div>)}</div><div className="evaluation-actions"><div><span>允许动作</span><strong>{toolResult.allowedAction}</strong></div><div><span>禁止动作</span><strong className="negative">{toolResult.prohibitedAction}</strong></div></div></>}
          </section>
        </div>
      )}

      {tool === "simulation" && (
        <div className="tool-workspace simulation-workspace">
          <div className="simulation-summary"><div><span>模拟可用余额</span><strong>¥{cash.toLocaleString()}</strong></div><div><span>模拟持仓市值</span><strong>¥{positionValue.toLocaleString()}</strong></div><div><span>模拟总资产</span><strong>¥{totalAssets.toLocaleString()}</strong></div><div><span>数据性质</span><strong>本机模拟</strong></div></div>
          <div className="tool-form-row simulation-order"><ToolStockSelect value={stock.code} onChange={setStockCode} items={stockOptions} /><input type="number" min="100" step="100" value={quantity} onChange={(event) => setQuantity(Number(event.target.value) || 100)} aria-label="模拟交易股数" /><button className="primary-button" onClick={() => trade("买入")}>模拟买入</button><button className="danger-button" onClick={() => trade("卖出")}>模拟卖出</button></div>
          <div className="emotion-selector"><span>下单心态</span>{["FOMO追涨","逆向抄底","跟风操作","逻辑驱动","恐慌割肉","贪心加仓"].map((item) => <button className={emotion === item ? "active" : ""} onClick={() => setEmotion(item)} key={item}>{item}</button>)}</div>
          <div className="account-tabs">{["持仓","历史","预委托","情绪分析"].map((item) => <button className={accountTab === item ? "active" : ""} onClick={() => setAccountTab(item)} key={item}>{item}</button>)}</div>
          <section className="panel account-content">
            {accountTab === "持仓" && (positionQuantity ? <div className="holding-row"><span><strong>{stock.name}</strong><small>{stock.code}</small></span><span>{positionQuantity}股</span><span>快照价 ¥{stock.price.toFixed(2)}</span><strong>本机模拟</strong><button onClick={() => trade("卖出")}>模拟卖出100股</button></div> : <QuantEmpty label="当前没有模拟持仓" />)}
            {accountTab === "历史" && (trades.length ? trades.map((item) => <div className="holding-row" key={item.createdAt}><span><strong>{item.stock}</strong><small>{new Date(item.createdAt).toLocaleTimeString("zh-CN")}</small></span><span>{item.side}</span><span>{item.quantity}股</span><strong>¥{item.price.toFixed(2)}</strong><span>{item.emotion}</span></div>) : <QuantEmpty label="暂无模拟交易历史" />)}
            {accountTab === "预委托" && <QuantEmpty label="暂无模拟条件单" />}
            {accountTab === "情绪分析" && <div className="account-empty"><IconBrain size={22} /><strong>{trades.length ? `已记录${trades.length}笔下单心态` : "暂无可分析记录"}</strong><p>情绪分析仅基于本机模拟交易记录，不推断真实账户行为。</p></div>}
          </section>
        </div>
      )}
    </div>
  );
}

function scoreLabel(score) {
  if (score >= 75) return { label: "强匹配", cls: "strong" };
  if (score >= 60) return { label: "条件匹配", cls: "conditional" };
  if (score >= 45) return { label: "等待", cls: "wait" };
  return { label: "回避", cls: "avoid" };
}

function StrategiesPage({ selected, setSelected, teacher, setTeacher, goAI, onOpenStock }) {
  const [detailOpen, setDetailOpen] = useState(false);
  const { snapshot: agentSnapshot } = useSharedSnapshot("/api/teachers", 60000);
  const { snapshot: top50Snapshot, state: top50State } = useSharedSnapshot("/api/top50", 300000);
  const strategyStocks = useMemo(() => (top50Snapshot?.cycles?.["波段"]?.ranking || []).slice(0, 10).map(hydrateStock), [top50Snapshot]);
  const current = strategyStocks.find((item) => item.code === selected?.code) || strategyStocks[0] || null;
  const activeTeacher = teachers.find((item) => item.name === teacher) || teachers[0];
  const agentByName = Object.fromEntries((agentSnapshot?.items || []).map((item) => [item.name, item]));
  return (
    <div className={`page-grid strategies-page ${detailOpen ? "detail-open" : ""}`}>
      <main className="primary-workspace">
        <ReferenceBanner page="strategies" />
        <div className="teacher-tabs">
          <span>12套策略画像</span>
          {teachers.map((item) => <button className={teacher === item.name ? "active" : ""} onClick={() => { setTeacher(item.name); setDetailOpen(true); }} key={item.name}><strong>{item.name}</strong><small>{item.style} · {agentByName[item.name]?.materialCount || 0}份资料</small></button>)}
        </div>
        <section className="panel matrix-panel">
          <div className="panel-head"><div><h2>12套策略因子画像矩阵</h2><span>{top50State === "ready" ? `波段TOP10 · 行情日 ${top50Snapshot?.meta?.marketDataDate || "--"} · 批次 ${top50Snapshot?.cycles?.["波段"]?.snapshotId || "--"}` : "正在读取当天TOP50共享快照"}</span></div><span className="agent-version-badge">{agentByName[activeTeacher.name]?.productionVersion?.id || "agent-factor-v1"}</span></div>
          <div className="matrix-wrap">
            <table className="strategy-matrix">
              <thead><tr><th>股票</th>{teachers.map((t) => <th key={t.name}>{t.name}</th>)}</tr></thead>
              <tbody>{strategyStocks.map((stock) => <tr className={current?.code === stock.code ? "selected" : ""} onClick={() => { setSelected(stock); onOpenStock(stock); }} key={stock.code}><td><strong>{stock.name}</strong><small>{stock.code}</small></td>{teachers.map((item) => { const score = Number(stock.agentScores?.[item.name] ?? 0); const label = scoreLabel(score); return <td key={item.name}><b className={label.cls}>{label.label}</b><small>{score ? Math.round(score) : "--"}</small></td>; })}</tr>)}</tbody>
            </table>
          </div>
          <div className="matrix-legend"><span className="strong">● 强匹配 75分以上</span><span className="conditional">● 条件匹配 60—74分</span><span className="wait">● 等待 45—59分</span><span className="avoid">● 回避 45分以下</span></div>
        </section>
        <section className="panel consensus-panel">
          <div className="panel-head"><div><h2>今日因子支持 TOP10</h2><span>按固定因子支持数与波段综合分排序；不足6项仅观察</span></div><button aria-label="查看TOP50"><IconChevronRight size={16} /></button></div>
          <table className="consensus-table">
            <thead><tr><th>#</th><th>股票</th><th>共识强度</th><th>支持策略</th><th>共识方向</th><th>最新价</th><th>涨跌幅</th><th>行业</th></tr></thead>
            <tbody>{[...strategyStocks].sort((a, b) => b.agentVotes - a.agentVotes || b.score - a.score).map((stock) => <tr onClick={() => onOpenStock(stock)} key={stock.code}><td>{stock.rank}</td><td><strong>{stock.name}</strong><small>{stock.code}</small></td><td><b>{stock.agentVotes}/12</b></td><td>{stock.topAgents?.join("、") || "--"}</td><td className={stock.agentVotes >= 6 ? "positive" : "negative"}>{stock.agentVotes >= 6 ? "条件偏多" : "仅观察"}</td><td>{stock.price.toFixed(2)}</td><td className={stock.pct >= 0 ? "price-up" : "price-down"}>{stock.pct >= 0 ? "+" : ""}{stock.pct}%</td><td>{stock.industry}</td></tr>)}</tbody>
          </table>
        </section>
      </main>
      {current && <StrategyRail stock={current} teacher={activeTeacher} agentState={agentByName[activeTeacher.name]} goAI={() => goAI(activeTeacher.name)} onClose={() => setDetailOpen(false)} />}
    </div>
  );
}

function StrategyRail({ stock, teacher, agentState, goAI, onClose }) {
  const score = Number(stock.agentScores?.[teacher.name] ?? 0);
  const match = scoreLabel(score);
  return (
    <aside className="right-rail strategy-rail">
      <div className="agent-profile">
        <div className="agent-avatar"><IconBrain size={20} /></div>
        <div><span>当前老师 Agent</span><h2>{teacher.name}</h2><p>{teacher.style} · {teacher.horizon}</p></div>
        <b className={match.cls}>{Math.round(score)}</b>
        <button className="rail-close" onClick={onClose} aria-label="关闭老师策略详情"><IconX size={16} /></button>
      </div>
      <div className="stock-detail-head"><div><span>正在分析</span><h2>{stock.name} <small>{stock.code}</small></h2><p>{stock.industry}</p></div><b className={match.cls}>{match.label}</b></div>
      <div className="stock-quote"><strong>{stock.price.toFixed(2)}</strong><span className={stock.pct >= 0 ? "price-up" : "price-down"}>{stock.pct >= 0 ? "+" : ""}{stock.pct}%</span></div>
      <div className="detail-section">
        <h3>Agent决策</h3>
        <p>{teacher.decision}</p>
      </div>
      <div className="detail-section agent-rule"><h3>选股技巧</h3><p><IconTargetArrow size={14} />{teacher.select}</p></div>
      <div className="detail-section agent-rule risk-list"><h3>风险纪律</h3><p><IconShieldCheck size={14} />{teacher.risk}</p></div>
      <div className="detail-section agent-knowledge-summary"><h3>持续学习状态</h3><p><span>生产版本</span><b>{agentState?.productionVersion?.id || "agent-factor-v1"}</b></p><p><span>授权资料</span><b>{agentState?.materialCount || 0}份</b></p><p><span>待审候选</span><b>{agentState?.candidateCount || 0}个</b></p><small>每周日统一检查新增资料；蒸馏仅生成候选知识，必须审核发布，量化权重保持冻结。</small></div>
      <div className="detail-section">
        <h3>12套策略画像分歧概览</h3>
        <div className="consensus-bar"><i style={{ width: `${stock.agentVotes / 12 * 100}%` }} /><i style={{ width: `${(12 - stock.agentVotes) / 12 * 100}%` }} /></div>
        <div className="consensus-labels"><span>支持 {stock.agentVotes}</span><span>未达支持线 {12 - stock.agentVotes}</span></div>
      </div>
      <div className="detail-section trade-state"><div><span>当前结论</span><StatusBadge status={score >= 75 ? "可试仓" : score >= 55 ? "等待确认" : "仅观察"} /></div><p>触发：{stock.trigger}</p><p>失效：{stock.invalid}</p></div>
      <button className="primary-button" onClick={goAI}><IconBrain size={17} /> 咨询{teacher.name} Agent</button>
    </aside>
  );
}

function AILabPage({ contextStock, contextTeacher, clientId }) {
  const { snapshot: labTop50Snapshot } = useSharedSnapshot("/api/top50", 60000);
  const [input, setInput] = useState("");
  const [threadItems, setThreadItems] = useState([]);
  const [activeThreadId, setActiveThreadId] = useState(null);
  const [threadFilter, setThreadFilter] = useState("all");
  const [roleDialogOpen, setRoleDialogOpen] = useState(false);
  const [roleName, setRoleName] = useState("");
  const [roleNameError, setRoleNameError] = useState("");
  const [messages, setMessages] = useState([]);
  const [agentItems, setAgentItems] = useState([]);
  const [selectedAgentNames, setSelectedAgentNames] = useState([contextTeacher?.name || "谭琦"]);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [stockPickerOpen, setStockPickerOpen] = useState(false);
  const [stockQuery, setStockQuery] = useState("");
  const [stockResults, setStockResults] = useState([]);
  const [stockSearchState, setStockSearchState] = useState("idle");
  const [manualStock, setManualStock] = useState(null);
  const [sending, setSending] = useState(false);
  const [agentJob, setAgentJob] = useState(null);
  const chatEndRef = useRef(null);
  const systemMessage = { role: "assistant", content: "选择股票和老师后开始研究。回答会标注数据来源和截止时间，仍需人工核验。", type: "system" };
  const activeThread = threadItems.find((item) => item.id === activeThreadId);
  const selectedAgents = selectedAgentNames.map((name) => teachers.find((item) => item.name === name)).filter(Boolean);
  const visibleAgentNames = selectedAgentNames.slice(0, 3);
  const activeTeacher = agentItems.find((item) => item.name === selectedAgentNames[0]);
  const primaryTeacher = selectedAgents[0] || contextTeacher || teachers[2];
  const labTop50Stocks = useMemo(() => Object.values(labTop50Snapshot?.cycles || {}).flatMap((item) => item.ranking || []), [labTop50Snapshot]);
  const threadStockCode = activeThread?.stockCode || null;
  const activeStock = manualStock || contextStock || labTop50Stocks.find((item) => item.code === threadStockCode) || null;
  const requestStock = activeStock || (threadStockCode ? { code: threadStockCode, name: "历史会话标的" } : null);
  const quickQuestions = [
    requestStock ? `为什么${requestStock.name}值得关注？请列出证据和主要风险。` : "今天哪些行业和股票值得关注？请只引用当前真实数据。",
    requestStock ? `${requestStock.name}当前最重要的失效条件是什么？` : "比较今天TOP50前三名的入选理由和风险。",
    requestStock ? `如果${requestStock.name}明日低开3%，应该观察哪些确认信号？` : "结合隔夜全球市场，推演今日A股三种情景。",
    requestStock ? `生成${requestStock.name}的盘后复盘清单。` : "生成今日盘后复盘清单。",
  ];
  const hasConversation = messages.some((message) => message.role === "user" || message.type === "live" || message.type === "error");
  const {
    liveAgentStates,
    liveAgentTotal,
    independentCompletedCount,
    independentFailureCount,
  } = deriveAgentProgress(agentJob, selectedAgentNames);
  const deadlineExceeded = agentJob?.pollingState === "deadline_exceeded";
  const showAgentRunStatus = shouldShowAgentRunStatus({ sending, agentJob });
  const toggleAgent = (name) => setSelectedAgentNames((names) => (
    names.includes(name) ? (names.length > 1 ? names.filter((item) => item !== name) : names) : [...names, name]
  ));
  const refreshThreads = async (preferredId = null) => {
    const response = await fetch(`/api/ai/threads?clientId=${encodeURIComponent(clientId)}`, { cache: "no-cache" });
    if (!response.ok) return;
    const result = await response.json();
    setThreadItems(result.items || []);
    const targetId = preferredId || activeThreadId;
    if (targetId) await loadThread(targetId);
    else setMessages([systemMessage]);
  };
  const loadThread = async (threadId) => {
    const response = await fetch(`/api/ai/threads/${threadId}?clientId=${encodeURIComponent(clientId)}`, { cache: "no-cache" });
    if (!response.ok) return;
    const result = await response.json();
    setActiveThreadId(threadId);
    const savedAgents = result.thread?.teacherNames?.filter((name) => teachers.some((item) => item.name === name));
    if (savedAgents?.length) setSelectedAgentNames(savedAgents);
    else if (result.thread?.teacherName && teachers.some((item) => item.name === result.thread.teacherName)) setSelectedAgentNames([result.thread.teacherName]);
    setMessages(result.thread?.messages?.length ? result.thread.messages.map((item) => ({ ...item, type: item.role === "assistant" ? "live" : undefined })) : [systemMessage]);
    if (result.thread?.activeJobId) {
      const pending = await fetch(`/api/ai/jobs/${result.thread.activeJobId}?clientId=${encodeURIComponent(clientId)}`, { cache: "no-cache" }).then((value) => value.json());
      setAgentJob(pending.job || null);
    } else setAgentJob(null);
  };
  useEffect(() => {
    refreshThreads();
    fetch("/api/teachers", { cache: "no-cache" }).then((response) => response.json()).then((result) => setAgentItems(result.items || [])).catch(() => {});
  }, [clientId]);
  useEffect(() => {
    const query = stockQuery.trim();
    if (!stockPickerOpen || !query) {
      setStockResults([]);
      setStockSearchState("idle");
      return undefined;
    }
    setStockSearchState("loading");
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      fetch(`/api/stocks/search?q=${encodeURIComponent(query)}`, { cache: "no-cache", signal: controller.signal })
        .then((response) => response.ok ? response.json() : Promise.reject(new Error("search unavailable")))
        .then((result) => { setStockResults(result.items || []); setStockSearchState("ready"); })
        .catch((error) => { if (error.name !== "AbortError") setStockSearchState("error"); });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [stockPickerOpen, stockQuery]);
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages, sending, agentJob]);
  const createNewThread = async (title) => {
    const response = await fetch("/api/ai/threads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, title, teacherName: title, teacherNames: [title], stockCode: contextStock?.code || null }),
    });
    const result = await response.json();
    if (!response.ok) return;
    setRoleDialogOpen(false);
    setRoleName("");
    setRoleNameError("");
    await refreshThreads(result.thread.id);
  };
  const openRoleDialog = () => {
    setRoleName("");
    setRoleNameError("");
    setRoleDialogOpen(true);
  };
  const submitNewRole = async (event) => {
    event.preventDefault();
    const title = roleName.trim();
    if (!title) {
      setRoleNameError("请输入角色（老师）名称");
      return;
    }
    await createNewThread(title);
  };
  const toggleFavorite = async () => {
    if (!activeThreadId) return;
    await fetch(`/api/ai/threads/${activeThreadId}?clientId=${encodeURIComponent(clientId)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ favorite: !activeThread?.favorite }),
    });
    await refreshThreads(activeThreadId);
  };
  const rateMessage = async (messageId, feedback) => {
    if (!activeThreadId || !messageId) return;
    await fetch("/api/ai/feedback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, threadId: activeThreadId, messageId, feedback }),
    });
    setMessages((items) => items.map((item) => item.id === messageId ? { ...item, feedback } : item));
  };
  const send = async (resumeJob = null) => {
    if ((!resumeJob && !input.trim()) || sending) return;
    const question = input.trim();
    setAgentPickerOpen(false);
    setStockPickerOpen(false);
    if (!resumeJob) setMessages((prev) => [...prev, { role: "user", content: question }]);
    setInput("");
    setSending(true);
    setAgentJob(null);
    try {
      const response = resumeJob ? null : await fetch("/api/ai/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          incremental: true,
          clientId,
          threadId: activeThreadId,
          question,
          stock: requestStock,
          teacher: primaryTeacher,
          teachers: selectedAgents,
        }),
      });
      const accepted = resumeJob ? { job: resumeJob } : await response.json();
      if (response && !response.ok) throw new Error(accepted.reason || accepted.message || accepted.error || "AI服务暂不可用");
      setActiveThreadId(accepted.job.threadId);
      setAgentJob(accepted.job);
      const fallbackDeadlineAtMs = Date.now() + 15 * 60 * 1000;
      let keepAgentJob = false;
      let result = null;
      for (let attempt = 0; attempt < 900; attempt += 1) {
        const jobResponse = await fetch(`/api/ai/jobs/${accepted.job.id}?clientId=${encodeURIComponent(clientId)}`, { cache: "no-cache" });
        const jobResult = await jobResponse.json();
        if (!jobResponse.ok) throw new Error(jobResult.message || jobResult.error || "无法读取AI任务状态");
        const currentJob = jobResult.job || null;
        const serverDeadlineAtMs = Date.parse(currentJob?.deadlineAt || "");
        const effectiveDeadlineAtMs = Number.isFinite(serverDeadlineAtMs) ? serverDeadlineAtMs : fallbackDeadlineAtMs;
        const jobWithDeadline = currentJob && !currentJob.deadlineAt
          ? { ...currentJob, deadlineAt: new Date(effectiveDeadlineAtMs).toISOString() }
          : currentJob;
        setAgentJob(jobWithDeadline);
        if (currentJob?.status === "completed") {
          result = currentJob.result;
          break;
        }
        if (currentJob?.status === "failed") {
          keepAgentJob = true;
          throw new Error(currentJob.error || "AI会诊任务未完成");
        }
        if (Date.now() > effectiveDeadlineAtMs) {
          keepAgentJob = true;
          setAgentJob({ ...(jobWithDeadline || {}), pollingState: "deadline_exceeded" });
          throw new Error("任务已超过执行上限，已停止轮询。请稍后刷新研究会话查看最终结果。");
        }
        if (currentJob?.incremental) {
          let advancing = true;
          const advance = fetch(`/api/ai/jobs/${currentJob.id}/advance`, {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ clientId, step: currentJob.step }),
          }).then(async (value) => {
            const payload = await value.json();
            if (!value.ok) throw new Error(payload.error || "会诊步骤暂未完成");
            return payload;
          }).finally(() => { advancing = false; });
          // Observe progress without creating additional AI calls.
          advance.catch(() => {});
          while (advancing) {
            await new Promise((resolve) => setTimeout(resolve, 1500));
            if (advancing) {
              const progress = await fetch(`/api/ai/jobs/${currentJob.id}?clientId=${encodeURIComponent(clientId)}`, { cache: "no-cache" }).then((value) => value.json());
              if (progress.job) setAgentJob(progress.job);
            }
          }
          const advanced = await advance;
          if (advanced.job) setAgentJob(advanced.job);
          if (advanced.busy) await new Promise((resolve) => setTimeout(resolve, 1500));
        } else await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      if (!result) throw new Error("AI会诊等待超时，请稍后从研究会话恢复结果");
      setMessages((prev) => [...prev, {
        role: "assistant",
        content: result.text,
        id: result.messageId,
        type: "live",
        model: result.model,
        verification: result.verification,
        dataCutoff: result.dataCutoff,
        citations: result.citations,
        teacherVersion: result.teacherVersion,
        teacherNames: result.teacherNames,
        agentResponses: result.agentResponses,
        failedAgentNames: result.failedAgentNames,
        summaryText: result.summaryText,
        summaryStatus: result.summaryStatus,
        independentSuccessCount: result.independentSuccessCount,
        independentFailureCount: result.independentFailureCount,
        fallbackMode: result.fallbackMode,
        consensus: result.consensus,
        deadlineAt: result.deadlineAt,
        stock: requestStock,
      }]);
      setActiveThreadId(result.threadId);
      await refreshThreads(result.threadId);
      if (!keepAgentJob) setAgentJob(null);
    } catch (error) {
      setMessages((prev) => [...prev, {
        role: "assistant",
        content: String(error.message || "").includes("任务已超过执行上限")
          ? `${error.message} 系统不会用预设答案替代。`
          : `真实AI尚未完成运行：${error.message}。已保存的老师观点不会丢失，可在本会话继续；系统不会用预设答案替代。`,
        type: "error",
      }]);
    } finally {
      setSending(false);
      setAgentJob((current) => current?.incremental || shouldKeepAgentJob(current) ? current : null);
    }
  };
  return (
    <div className="ai-layout">
      <aside className="thread-list">
        <div className="thread-head"><h2>研究会话</h2><button onClick={openRoleDialog}><IconPlus size={15} /> 新建角色</button></div>
        <div className="thread-tabs"><button className={threadFilter === "all" ? "active" : ""} onClick={() => setThreadFilter("all")}>全部</button><button className={threadFilter === "favorite" ? "active" : ""} onClick={() => setThreadFilter("favorite")}>收藏夹</button></div>
        {threadItems.filter((thread) => threadFilter === "all" || thread.favorite).map((thread) => <button className={activeThreadId === thread.id ? "active" : ""} onClick={() => loadThread(thread.id)} key={thread.id}><strong>{thread.teacherName}</strong><span>{new Date(thread.updatedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}</span><small>{thread.messageCount ? `${thread.messageCount} 条消息 · 已同步` : "等待开始研究"}</small></button>)}
        {!threadItems.length && <div className="thread-empty"><IconMessageCircle2 size={22} /><strong>暂无研究会话</strong><span>点击“新建角色”开始。本浏览器可恢复会话；不同浏览器不会自动共享。</span></div>}
        <div className="thread-bottom"><span>共 {threadItems.length} 条会话</span><span>最多保留100条</span></div>
      </aside>
      {roleDialogOpen && <div className="role-create-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setRoleDialogOpen(false); }}>
        <form className="role-create-dialog" role="dialog" aria-modal="true" aria-labelledby="role-create-title" onSubmit={submitNewRole}>
          <div className="role-create-head"><div><span>AI研究</span><h2 id="role-create-title">新建角色</h2></div><button type="button" onClick={() => setRoleDialogOpen(false)} aria-label="关闭"><IconX size={17} /></button></div>
          <label className="role-create-field"><span>角色（老师）名称</span><input autoFocus value={roleName} maxLength={80} onChange={(event) => { setRoleName(event.target.value); setRoleNameError(""); }} onKeyDown={(event) => { if (event.key === "Escape") setRoleDialogOpen(false); }} placeholder="例如：趋势交易老师" /></label>
          {roleNameError && <p className="role-create-error" role="alert">{roleNameError}</p>}
          <p className="role-create-hint">角色名称会显示在研究会话列表中；具体研判老师仍可在会话内选择。</p>
          <div className="role-create-actions"><button type="button" onClick={() => setRoleDialogOpen(false)}>取消</button><button className="primary" type="submit">创建角色</button></div>
        </form>
      </div>}
      <main className="chat-main">
        <div className="chat-head"><div><h1>{activeThread?.teacherName || activeThread?.title || "新研究会话"}</h1><span>{selectedAgentNames.length === 1 ? `${selectedAgentNames[0]} Agent` : `${selectedAgentNames.length}位 Agent 联合研判`} · 结构化证据引用 · {activeTeacher?.productionVersion?.id || "agent-factor-v1"}</span></div><div><button onClick={toggleFavorite} aria-label={activeThread?.favorite ? "取消收藏" : "收藏会话"}><IconStar size={17} fill={activeThread?.favorite ? "currentColor" : "none"} /></button></div></div>
        <div className="chat-scroll">
          {!hasConversation && <ReferenceBanner page="ai" />}
          {(messages.length ? messages : [systemMessage]).map((message, index) => message.role === "assistant" ? <AssistantMessage message={message} onRate={rateMessage} stock={message.stock || requestStock} key={message.id || index} /> : <div className="user-message" key={message.id || index}>{message.content}</div>)}
          {!hasConversation && <section className="ai-quick-start">
            <div><span>开始一项研究</span><h2>{requestStock ? `${requestStock.name} ${requestStock.code}` : "全市场A股研究"}</h2><p>{selectedAgentNames.length === 1 ? `${selectedAgentNames[0]} Agent` : `${selectedAgentNames.length}位老师联合研判`} · 回答保留来源和数据截止时间</p></div>
            <div className="ai-quick-question-grid">{quickQuestions.map((question) => <button disabled={sending} onClick={() => setInput(question)} key={question}><IconSparkles size={16} /><span>{question}</span><IconChevronRight size={15} /></button>)}</div>
          </section>}
          {sending && <div className="typing"><i /><i /><i /></div>}
          <div ref={chatEndRef} />
        </div>
        <div className="composer">
          <div className="context-chips">
            {requestStock && <span>{requestStock.name} {requestStock.code}</span>}
            {visibleAgentNames.map((name) => <span key={name}>{name} Agent <button disabled={sending || selectedAgentNames.length === 1} onClick={() => toggleAgent(name)} aria-label={`移除${name} Agent`}><IconX size={12} /></button></span>)}
            {selectedAgentNames.length > visibleAgentNames.length && <span className="agent-overflow-chip">+{selectedAgentNames.length - visibleAgentNames.length}位</span>}
            {Number.isFinite(Number(activeStock?.rank)) && Number(activeStock.rank) > 0 && <span>TOP50 #{activeStock.rank}</span>}
            <button disabled={sending} onClick={() => { setAgentPickerOpen(false); setStockPickerOpen((open) => !open); }}><IconSearch size={13} /> 搜索A股</button>
            <button disabled={sending} onClick={() => { setStockPickerOpen(false); setAgentPickerOpen((open) => !open); }}><IconPlus size={13} /> 选择老师 Agent</button>
          </div>
          {stockPickerOpen && <div className="stock-picker">
            <div className="stock-picker-head"><strong>选择任意A股作为本次研究上下文</strong><button onClick={() => setStockPickerOpen(false)}>关闭</button></div>
            <label><IconSearch size={15} /><input autoFocus value={stockQuery} onChange={(event) => setStockQuery(event.target.value)} placeholder="输入股票代码或名称，例如 603893 / 瑞芯微" /></label>
            <div className="stock-search-results">
              {stockSearchState === "loading" && <span>正在搜索全市场A股…</span>}
              {stockSearchState === "error" && <span>行情搜索暂不可用，请检查Tushare数据源。</span>}
              {stockSearchState === "ready" && !stockResults.length && <span>没有匹配的上市A股。</span>}
              {stockResults.map((item) => <button key={item.tsCode || item.code} onClick={() => { setManualStock(item); setStockPickerOpen(false); setStockQuery(""); }}><strong>{item.name}</strong><span>{item.code} · {item.industry}</span></button>)}
            </div>
          </div>}
          {agentPickerOpen && <div className="agent-picker">
            <div className="agent-picker-head"><strong>选择参与本次会诊的老师 Agent</strong><span>已选 {selectedAgentNames.length}/12</span><button onClick={() => setAgentPickerOpen(false)}>完成选择</button></div>
            <div className="agent-picker-actions"><button disabled={sending} onClick={() => setSelectedAgentNames(teachers.map((item) => item.name))}>全选12位</button><button disabled={sending} onClick={() => setSelectedAgentNames([contextTeacher?.name || "谭琦"])}>仅保留当前老师</button></div>
            <div className="agent-picker-grid">{teachers.map((item) => <button className={selectedAgentNames.includes(item.name) ? "active" : ""} disabled={sending} onClick={() => toggleAgent(item.name)} key={item.name}><strong>{item.name}</strong><small>{item.style} · {item.horizon}</small></button>)}</div>
          </div>}
          {showAgentRunStatus && <div className="agent-run-status" aria-live="polite">
            <div className="agent-run-head"><span><IconActivity size={14} /> {deadlineExceeded ? "任务已超过执行上限" : agentJobPhaseLabels[agentJob?.phase] || "正在创建AI会诊任务"}</span><b>{independentCompletedCount}/{liveAgentTotal}</b>{!sending && agentJob?.incremental && !["completed", "failed"].includes(agentJob.status) && <button onClick={() => send(agentJob)}>继续会诊</button>}{agentJob?.id && !["completed", "failed"].includes(agentJob.status) && <button onClick={async () => { const response = await fetch(`/api/ai/jobs/${agentJob.id}/cancel`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ clientId }) }); if (response.ok) { const data = await response.json(); setAgentJob(data.job); } }}>停止后续会诊</button>}</div>
            <div className="agent-run-summary">
              <span>独立完成 <b>{independentCompletedCount}/{liveAgentTotal}</b></span>
              <span>未完成 <b>{independentFailureCount}</b></span>
              <span>执行上限 <b>{formatShanghaiTime(agentJob?.deadlineAt)}</b></span>
              {agentJob?.fallbackMode === "shared_model" && <span className="fallback">共享模型降级，未计入老师共识</span>}
            </div>
            {deadlineExceeded && <div className="agent-run-alert">任务已超过执行上限，已停止轮询。请稍后刷新研究会话查看最终结果。</div>}
            <div className="agent-progress-grid">{liveAgentStates.map((item) => {
              const state = item.status || "waiting";
              return (
                <article className={`agent-progress-card ${state}`} key={item.teacherName}>
                  <div className="agent-progress-top">
                    <div><b>{item.teacherName}</b><small>{agentJobStateLabels[state]}</small></div>
                    <span>耗时 {formatDurationMs(item.durationMs)}</span>
                  </div>
                  <div className="agent-progress-detail">
                    <span>分类 {item.errorCategory || "--"}</span>
                    <span>脱敏原因：{item.publicMessage || "--"}</span>
                  </div>
                  {agentJob?.checkpoint?.agentResponses?.find((response) => response.teacherName === item.teacherName) && <details><summary>查看已保存观点</summary><p>{agentJob.checkpoint.agentResponses.find((response) => response.teacherName === item.teacherName).text}</p></details>}
                </article>
              );
            })}</div>
          </div>}
          <div className="composer-input"><textarea value={input} disabled={sending} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} placeholder="输入你的研究问题，或引用文件 / 数据 / 图表" /><button disabled={sending || !input.trim()} onClick={() => send()} aria-label="发送研究问题"><IconSend2 size={17} /></button></div>
          <div className="composer-actions"><button disabled={sending} onClick={() => setInput(activeStock ? `比较${activeStock.name}与同行公司的基本面和买点` : "比较两只指定A股的基本面、风险和触发条件")}><IconChartDots3 size={14} /> 比较股票</button><button disabled={sending} onClick={() => setInput("如果明日低开3%，三种情景如何应对？")}><IconTargetArrow size={14} /> 情景推演</button><button disabled={sending} onClick={() => setInput("生成一份完整的打印版研究报告")}><IconFileAnalytics size={14} /> 生成报告</button></div>
        </div>
      </main>
      {activeStock
        ? <ResearchContext stock={hydrateStock(activeStock)} teacher={primaryTeacher} agentState={activeTeacher} />
        : <aside className="research-context"><div className="context-head"><h2>研究上下文</h2></div><section><h3>当前范围</h3><p>全市场A股研究<b>未指定股票</b></p><p>所选Agent<b>{selectedAgentNames.length}位</b></p></section><section><h3>使用方式</h3><p>可直接询问市场、行业或任意A股；从股票卡片点击“问AI复核”时，系统会额外带入该股票的真实代码、行情证据和榜单信息。</p></section></aside>}
    </div>
  );
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  textarea.remove();
}

function AssistantMessage({ message, onRate, stock }) {
  const live = message.type === "live";
  const multiAgentSummary = live && message.summaryText && message.teacherNames?.length > 1;
  const totalAgents = message.teacherNames?.length || 0;
  const completedAgents = Number.isFinite(Number(message.independentSuccessCount)) ? Number(message.independentSuccessCount) : (message.agentResponses?.length || 0);
  const failedAgents = Number.isFinite(Number(message.independentFailureCount)) ? Number(message.independentFailureCount) : (message.failedAgentNames?.length || 0);
  const {
    coordinatorFallback,
    summaryTimedOut,
    summaryUnavailable,
    partial: summaryPartial,
    label: summaryLabel,
  } = deriveSummaryState({
    summaryStatus: message.summaryStatus,
    fallbackMode: message.fallbackMode,
    failedAgents,
  });
  const [actionState, setActionState] = useState(null);
  const finalText = message.summaryText || message.content || "";
  const evidenceLabel = message.verification?.status === "screened" ? "已返回的AI正文通过有限规则筛查；不等于全文事实核验或投资结论正确。" : "此历史回答未经过本轮证据筛查，请核对原始资料。";
  const exportText = `【AI生成内容】${evidenceLabel}\n\n${finalText}\n\n本次提供的参考资料：\n${(message.citations || []).map((source) => `[${source.id}] ${source.title} · ${source.publishedAt || "日期未提供"}${source.url ? ` · ${source.url}` : ""}\n${source.excerpt || ""}`).join("\n")}`;
  const handleCopy = async () => {
    await copyText(exportText);
    setActionState("copied");
  };
  const handleReview = () => {
    const existing = readReviewDrafts();
    const draft = { id: message.id || `review-${Date.now()}`, createdAt: new Date().toISOString(), stock: stock || null, teacherNames: message.teacherNames || [], summary: exportText, dataCutoff: message.dataCutoff || null };
    window.localStorage.setItem("stock-review-drafts", JSON.stringify([draft, ...existing.filter((item) => item.id !== draft.id)].slice(0, 100)));
    window.dispatchEvent(new Event("stock-review-draft-added"));
    setActionState("reviewed");
  };
  return (
    <article className={`assistant-message ${message.type === "error" ? "assistant-error" : ""}`}>
      <div className="assistant-icon"><IconBrain size={18} /></div>
      <div>
        <h2>{live ? "AI研究结论" : "研究室状态"} {live && <StatusBadge status="等待确认" />}</h2>
        {multiAgentSummary ? <>
          <section className="agent-final-summary">
            <div className="agent-final-summary-head"><div><span>{coordinatorFallback ? "多策略联合会话" : "多 Agent 最终输出"}</span><strong>最终总结</strong></div><span className={`summary-state ${summaryPartial ? "partial" : "complete"}`}>{summaryLabel}</span></div>
            <div className="agent-summary-stats"><span>参与 <b>{totalAgents}</b></span><span>独立完成 <b>{completedAgents}/{totalAgents}</b></span><span>未完成 <b>{failedAgents}</b></span></div>
            <ResearchAnswer text={message.summaryText} />
            {coordinatorFallback ? <small>共享模型降级，未计入老师共识。独立Agent本次未返回有效正文；以上为真实模型基于所选策略画像生成的共享会话，不等同于独立Agent共识。</small> : summaryTimedOut ? <small>独立Agent结果已返回，但最终汇总在截止时间前超时；下方仍保留独立观点和可用总结文本。</small> : summaryUnavailable ? <small>独立Agent结果已返回，但最终汇总暂未生成；下方仍保留独立观点和失败后的可用总结文本。</small> : failedAgents > 0 && <small>未完成：{message.failedAgentNames.join("、")}；以上结论仅统计实际返回的老师。</small>}
          </section>
          {!coordinatorFallback && <details className="agent-opinion-details"><summary>查看 {completedAgents} 位老师的独立观点</summary><ResearchAnswer text={message.content} /></details>}
        </> : <ResearchAnswer text={message.content} />}
        {live && <p className="research-evidence-note">{evidenceLabel}{message.verification?.scope && <small>{message.verification.scope}</small>}</p>}
        {live && message.citations?.length > 0 && <details className="research-evidence-sources"><summary>查看本次参考资料（{message.citations.length}条，不代表全部被回答引用）</summary>{message.citations.map((source) => <section key={source.id}><strong>[{source.id}] {source.title}</strong><small>{source.source} · {source.publishedAt || "日期未提供"}</small><p>{source.excerpt || "无可展示摘录"}</p>{source.url && <a href={source.url} target="_blank" rel="noreferrer">打开原始来源 ↗</a>}</section>)}</details>}
        {live && <small className="data-cutoff">模型：{message.model} · 老师版本：{message.teacherVersion || "agent-factor-v1"} · TOP50截止：{message.dataCutoff?.top50 || "未提供"} · 资讯截止：{message.dataCutoff?.news || "未提供"} · AI生成内容</small>}
        {live && <div className="message-output-actions"><button onClick={handleCopy}><IconCopy size={14} /> {actionState === "copied" ? "已复制" : "复制最终总结"}</button><button onClick={handleReview}><IconFileAnalytics size={14} /> {actionState === "reviewed" ? "已加入盘后复盘" : "加入盘后复盘"}</button></div>}
        {live && message.id && <div className="message-feedback"><span>这条研究是否有帮助？</span><button className={message.feedback === "helpful" ? "active" : ""} onClick={() => onRate(message.id, "helpful")}>有帮助</button><button className={message.feedback === "not_helpful" ? "active negative" : ""} onClick={() => onRate(message.id, "not_helpful")}>需改进</button></div>}
      </div>
    </article>
  );
}

function InlineResearchText({ text }) {
  return String(text || "").split(/(\*\*[^*]+\*\*|\[[A-Z]\d+\])/g).filter(Boolean).map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (/^\[[A-Z]\d+\]$/.test(part)) return <b className="inline-citation" key={index}>{part}</b>;
    return <span key={index}>{part}</span>;
  });
}

function ResearchAnswer({ text }) {
  const lines = String(text || "").split("\n");
  return <div className="ai-live-answer">{lines.map((line, index) => {
    const value = line.trim();
    if (!value) return <div className="answer-gap" key={index} />;
    if (/^\|?[-:| ]+\|?$/.test(value)) return null;
    if (value.includes("|") && value.split("|").filter((cell) => cell.trim()).length > 1) {
      return <div className="answer-table-row" key={index}>{value.split("|").filter((cell) => cell.trim()).map((cell, cellIndex) => <span key={cellIndex}><InlineResearchText text={cell.trim()} /></span>)}</div>;
    }
    const heading = value.match(/^#{1,3}\s+(.+)$/);
    if (heading) return <h3 key={index}><InlineResearchText text={heading[1]} /></h3>;
    if (/^[-*]\s+/.test(value)) return <p className="answer-bullet" key={index}><InlineResearchText text={value.replace(/^[-*]\s+/, "")} /></p>;
    return <p key={index}><InlineResearchText text={value} /></p>;
  })}</div>;
}

function ResearchContext({ stock, teacher, agentState }) {
  const ranked = Number(stock.rank) > 0;
  const quoted = Number(stock.price) > 0;
  const strongestFactors = Object.entries(stock.agentScores || {}).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 3);
  return (
    <aside className="research-context">
      <div className="context-head"><h2>研究上下文</h2><button aria-label="刷新研究上下文"><IconRefresh size={15} /></button></div>
      <section><div className="stock-detail-head"><div><h2>{stock.name} <small>{stock.code}</small></h2><p>{stock.industry}</p></div>{ranked && <StatusBadge status={stock.status} />}</div>{quoted ? <div className="stock-quote"><strong>{stock.price.toFixed(2)}</strong><span className={stock.pct >= 0 ? "price-up" : "price-down"}>{stock.pct >= 0 ? "+" : ""}{stock.pct}%</span></div> : <p className="context-data-note">发送问题时读取最近交易日行情，并作为可引用的M2证据。</p>}</section>
      {ranked && <section className="context-score"><div><span>TOP50地位</span><strong>#{stock.rank}<small>/50</small></strong></div><div><span>得分</span><strong>{stock.score}</strong></div><div><span>方向因子</span><strong>{stock.confidence ?? "--"}/100</strong></div></section>}
      <section><h3>老师策略（{teacher.name} Agent）</h3><p>风格：{teacher.style} · {teacher.horizon}</p><p>决策：{teacher.decision}</p><p>纪律：{teacher.risk}</p></section>
      <section className="agent-learning-state"><h3>知识与版本状态</h3><p>生产版本 <b>{agentState?.productionVersion?.id || "agent-factor-v1"}</b></p><p>授权资料 <b>{agentState?.materialCount || 0} 份</b></p><p>候选版本 <b>{agentState?.candidateCount || 0} 个</b></p><small>每周日统一蒸馏新增资料；候选未经门禁不会改变线上选股权重。</small></section>
      {ranked && <section><h3>最高因子画像（真实冻结分）</h3>{strongestFactors.length ? <ol className="factor-list">{strongestFactors.map(([name, score], index) => <li key={name}><b>{index + 1}</b><span>{name}</span><strong>{Number(score).toFixed(1)}</strong></li>)}</ol> : <p>当前快照未提供因子明细。</p>}</section>}
      {ranked && <section><h3>当前风险边界</h3><p>风险等级 <b className={stock.risk === "高" ? "negative" : "neutral"}>{stock.risk || "待评估"}</b></p><p>{stock.invalid || "真实失效位待数据源提供"}</p></section>}
      {ranked && <section><h3>历史排名证据</h3><p>当前仅保存本期冻结排名 #{stock.rank}；尚未形成连续历史序列，不绘制模拟趋势。</p></section>}
    </aside>
  );
}

function IndustriesPage({ onSelect }) {
  const { snapshot, state } = useSharedSnapshot("/api/industries", 300000);
  const industries = snapshot?.industries || [];
  const catalysts = snapshot?.catalysts || [];
  const dataDate = snapshot?.meta?.marketDataDate || "--";
  return (
    <div className="simple-page">
      <div className="page-toolbar"><div><h1>行业与主题</h1><p>{state === "ready" ? `TOP50真实行情分组 · 行情截止 ${dataDate}` : "正在读取真实行业快照"}</p></div><span className="toolbar-button"><IconDatabase size={15} /> {snapshot?.meta?.sourceMode === "derived_from_live" ? "真实数据推导" : "等待数据"}</span></div>
      {state === "unavailable" && <div className="account-empty"><IconAlertTriangle size={22} /><strong>真实行业数据暂不可用</strong><p>本页不会展示静态行业涨跌或虚构催化。</p></div>}
      <div className="industry-reference-grid"><div className="industry-ranking-list">
        <div className="industry-ranking-head"><span>排名 / 行业</span><span>区间表现</span><span>规则强度</span><span>上涨家数</span><span>样本</span><span>核心股票</span></div>
        {industries.map((sector, index) => (
          <section className={`industry-ranking-row ${sector.stockCount <= 2 ? "small-sample" : ""}`} key={sector.name}>
            <div className="industry-ranking-name"><b>#{index + 1}</b><span><strong>{sector.name}</strong><small>{sector.stockCount <= 2 ? "小样本，仅供观察" : "TOP50行业分组"}</small></span></div>
            <strong className={Number(sector.averagePct) >= 0 ? "price-up" : "price-down"}>{sector.averagePct == null ? "--" : `${sector.averagePct >= 0 ? "+" : ""}${sector.averagePct}%`}</strong>
            <div className="industry-strength"><span><i style={{ width: `${sector.strengthScore}%` }} /></span><b>{sector.strengthScore}</b></div>
            <span>{sector.positiveBreadth}%</span>
            <span className={sector.stockCount <= 2 ? "sample-warning" : ""}>{sector.stockCount}只</span>
            <div className="industry-core-stocks">{sector.topStocks.slice(0, 3).map((stock) => <button onClick={() => onSelect(stock)} key={stock.code}><span>{stock.name}<small>{stock.code} · {stock.risk}风险</small></span><b>{stock.score}</b></button>)}</div>
          </section>
        ))}
      </div>
      <aside className="panel industry-core-panel"><div className="panel-head"><h2>核心股票</h2></div>{industries.slice(0, 6).map((sector) => <section className="industry-core-group" key={sector.name}><h3>{sector.name}</h3>{sector.topStocks.slice(0, 3).map((stock) => <button key={stock.code} onClick={() => onSelect(stock)}><span>{stock.name}<small>{stock.code}</small></span><b>{stock.score}</b></button>)}</section>)}</aside></div>
      <section className="panel industry-table"><div className="panel-head"><div><h2>行业关联资讯</h2><span>来自定时资讯原文 · 仅按行业关键词关联，不自动判定利好利空</span></div></div>{catalysts.length ? <table><thead><tr><th>时间</th><th>行业</th><th>来源</th><th>新闻标题</th><th>匹配方式</th></tr></thead><tbody>{catalysts.map((item) => <tr key={`${item.industry}:${item.id}`}><td>{item.time || "--"}</td><td>{item.industry}</td><td>{item.source}</td><td><a href={item.url} target="_blank" rel="noreferrer">{item.title}</a></td><td>行业关键词</td></tr>)}</tbody></table> : <div className="account-empty"><IconNews size={22} /><strong>暂无可核验的行业关联资讯</strong><p>不使用静态事件补位。</p></div>}</section>
      {snapshot?.meta?.methodology && <p className="page-data-method"><IconInfoCircle size={15} /> {snapshot.meta.methodology}</p>}
    </div>
  );
}

function MarketCenterPage({ onOpenStock, goTop50, goNews, watchlistedCodes, watchlistDetails, onToggleWatchlist }) {
  const [refreshKey, setRefreshKey] = useState(0);
  const [cycle, setCycle] = useState("短线");
  const [query, setQuery] = useState("");
  const { items: directoryResults, state: directoryState } = useStockDirectorySearch(query);
  const { snapshot: marketSnapshot, state: marketState } = useSharedSnapshot(`/api/market?refresh=${refreshKey}`, 60000);
  const { snapshot: platformStatus } = useSharedSnapshot("/api/status", 60000);
  const { snapshot: top50Snapshot } = useSharedSnapshot("/api/top50", 300000);
  const { snapshot: newsSnapshot, state: newsState } = useSharedSnapshot("/api/news", 60000);
  const allTop50 = useMemo(() => {
    const items = Object.values(top50Snapshot?.cycles || {}).flatMap((item) => item.ranking || []).map(hydrateStock);
    return [...new Map(items.map((item) => [item.code, item])).values()];
  }, [top50Snapshot]);
  const stockByCode = useMemo(() => new Map(allTop50.map((item) => [item.code, item])), [allTop50]);
  const marketRows = useMemo(() => (marketSnapshot?.quotes || []).map((quote) => {
    const ranked = stockByCode.get(quote.code);
    const price = Number(quote.price);
    const open = Number(quote.open);
    return {
      ...quote,
      name: ranked?.name || watchlistDetails?.[quote.code]?.name || quote.name || quote.code,
      industry: ranked?.industry || watchlistDetails?.[quote.code]?.industry || "自选跟踪",
      ranked,
      price,
      open,
      changeFromOpen: open ? Number(((price / open - 1) * 100).toFixed(2)) : null,
    };
  }), [marketSnapshot, stockByCode, watchlistDetails]);
  const cycleRanking = useMemo(() => (top50Snapshot?.cycles?.[cycle]?.ranking || []).map(hydrateStock), [cycle, top50Snapshot]);
  const upCount = marketRows.filter((item) => item.changeFromOpen > 0).length;
  const downCount = marketRows.filter((item) => item.changeFromOpen < 0).length;
  const marketDegraded = ["degraded", "partial"].includes(platformStatus?.health?.market?.status);
  const minuteMode = Boolean(platformStatus?.health?.market?.isIntraday);
  const realtimeDailyMode = /rt_k/i.test(String(marketSnapshot?.meta?.provider || ""));
  const marketPanelTitle = minuteMode ? "盘中分钟行情" : realtimeDailyMode ? "当日行情" : "行情快照";
  const marketPanelDescription = minuteMode
    ? "真实分钟快照 · 价格方向按当前价相对开盘价计算"
    : realtimeDailyMode
      ? "盘中日线 / 收盘快照 · 按8轮计划采集，非逐笔实时"
      : "最近有效快照 · 价格方向按当前价相对开盘价计算";
  const generatedAt = marketSnapshot?.meta?.generatedAt
    ? new Date(marketSnapshot.meta.generatedAt).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit" })
    : "--";
  return (
    <div className="simple-page market-center-page">
      <div className="page-toolbar market-center-toolbar">
        <div><h1>定时行情中心</h1><p>盘中快照、自选跟踪、TOP50热度与资讯联动；点击股票打开完整决策浮层</p></div>
        <div className="market-toolbar-actions"><label><IconSearch size={17} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索全部A股名称 / 6位代码" /></label><button className="toolbar-button" onClick={() => setRefreshKey((value) => value + 1)}><IconRefresh size={16} /> 刷新行情</button></div>
        {query && <div className="market-search-results">{directoryResults.length ? directoryResults.map((item) => { const ranked = stockByCode.get(item.code); const watched = watchlistedCodes.includes(item.code); return <div className="market-search-result-row" key={item.code}><button className="market-search-stock" disabled={!ranked} onClick={() => { if (ranked) onOpenStock(ranked); setQuery(""); }}><span><strong>{item.name}</strong><small>{item.code} · {item.industry}</small></span><b>{ranked ? `#${ranked.rank}` : item.market}</b></button><button className={watched ? "active" : ""} onClick={() => onToggleWatchlist(item)}><IconStar size={14} /> {watched ? "已自选" : "加入"}</button></div>; }) : <div>{directoryState === "loading" ? "正在搜索全A股目录…" : "没有找到匹配股票"}</div>}</div>}
      </div>
      <div className="market-kpis">
        <section><span>行情状态</span><strong className={marketDegraded ? "neutral" : marketState === "ready" ? "positive" : "neutral"}>{marketDegraded ? "延迟" : marketState === "ready" ? "已连接" : "读取中"}</strong><small>{platformStatus?.health?.market?.label || marketSnapshot?.meta?.provider || "等待真实行情"}</small></section>
        <section><span>快照时间</span><strong>{generatedAt}</strong><small>上海时间 · 自动刷新60秒</small></section>
        <section><span>跟踪股票</span><strong>{marketRows.length}</strong><small>当前自选与候选监控范围</small></section>
        <section><span>较开盘上涨 / 下跌</span><strong><i className="price-up">{upCount}</i> / <i className="price-down">{downCount}</i></strong><small>仅统计当前{marketRows.length}只，不代表全市场</small></section>
      </div>
      <div className="market-center-grid">
        <section className="panel market-live-panel">
          <div className="panel-head"><div><h2>{marketPanelTitle}</h2><span>{marketPanelDescription}</span></div><span className={`stream-state ${marketState !== "ready" || marketDegraded ? "warn" : ""}`}><i /> {marketDegraded ? "行情延迟" : marketState === "ready" ? "行情已读取" : "沿用最近快照"}</span></div>
          <div className="market-live-table"><div className="market-live-head"><span>股票</span><span>现价</span><span>较开盘</span><span>最高 / 最低</span><span>成交额</span><span>数据时间</span></div>{marketRows.map((item) => { const rawTime = item.observedAt || item.time || item.snapshotAt || ""; const parsedTime = Date.parse(rawTime); const displayedTime = String(rawTime).includes("T") && Number.isFinite(parsedTime) ? new Date(parsedTime).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }) : String(rawTime).match(/\d{2}:\d{2}/)?.[0] || "--"; const isSnapshot = ["stale", "snapshot"].includes(item.freshness); const modalStock = item.ranked || hydrateStock({ ...item, pct: item.changeFromOpen, marketDataDate: marketSnapshot?.meta?.tradeDate }); return <button key={item.code} onClick={() => onOpenStock(modalStock)}><span><strong>{item.name}</strong><small>{item.code} · {item.industry}</small></span><b>{Number.isFinite(item.price) ? item.price.toFixed(2) : "--"}</b><em className={item.changeFromOpen >= 0 ? "price-up" : "price-down"}>{Number.isFinite(item.changeFromOpen) ? `${item.changeFromOpen >= 0 ? "+" : ""}${item.changeFromOpen}%` : "--"}</em><span>{Number.isFinite(Number(item.high)) ? Number(item.high).toFixed(2) : "--"} / {Number.isFinite(Number(item.low)) ? Number(item.low).toFixed(2) : "--"}</span><span>{Number.isFinite(Number(item.amount)) ? `${(Number(item.amount) / 100000000).toFixed(2)}亿` : "--"}</span><time className={isSnapshot ? "stale" : ""}>{displayedTime}{isSnapshot ? " 快照" : ""}</time></button>; })}</div>
          {!marketRows.length && <div className="account-empty"><IconDatabase size={22} /><strong>暂无行情快照</strong><p>系统会保留最近有效快照，不使用静态价格填充。</p></div>}
          <div className="market-scope-note"><IconInfoCircle size={16} /><span>当前接口按自选与候选集合抓取{minuteMode ? "分钟行情快照" : realtimeDailyMode ? "盘中日线快照" : "行情快照"}，按8轮计划采集，不是逐笔实时或全市场涨跌家数；请核对报价时间。</span></div>
        </section>
        <aside className="panel market-hot-panel">
          <div className="panel-head"><div><h2>TOP50热度</h2><span>{cycle}周期 · 最近交易日冻结榜</span></div><button onClick={goTop50}>完整榜单 <IconChevronRight size={14} /></button></div>
          <div className="market-cycle-tabs">{["超短", "短线", "波段", "中长线"].map((item) => <button className={cycle === item ? "active" : ""} onClick={() => setCycle(item)} key={item}>{item}</button>)}</div>
          <div className="market-hot-list">{cycleRanking.slice(0, 8).map((item) => <button key={item.code} onClick={() => onOpenStock(item)}><b>#{item.rank}</b><span><strong>{item.name}</strong><small>{item.code} · {item.industry}</small></span><span><strong className={item.pct >= 0 ? "price-up" : "price-down"}>{item.pct >= 0 ? "+" : ""}{item.pct}%</strong><small>{item.agentVotes}/12 因子支持</small></span></button>)}</div>
        </aside>
        <aside className="panel market-news-panel">
          <div className="panel-head"><div><h2>定时资讯</h2><span>{newsSnapshot?.meta?.sourceMode === "live" ? "真实资讯源" : "最近缓存"}</span></div><button onClick={goNews}>资讯中心 <IconChevronRight size={14} /></button></div>
          <div className="market-news-list">{(newsSnapshot?.items || []).slice(0, 8).map((item) => <a href={item.url} target="_blank" rel="noreferrer" key={item.id}><time>{item.time}</time><span><strong>{item.title}</strong><small>{item.market || "A股"} · {item.source}</small></span></a>)}</div>
          {newsState === "loading" && <div className="account-empty"><IconRefresh size={20} /><strong>正在读取资讯</strong></div>}
        </aside>
      </div>
    </div>
  );
}

function PortfolioPage({ onOpenStock, watchlistedCodes, watchlistDetails, liveStocks, onToggleWatchlist, onAddStock }) {
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferText, setTransferText] = useState("");
  const [transferMessage, setTransferMessage] = useState("");
  const watchItems = resolveWatchlistStocks(watchlistedCodes, liveStocks, watchlistDetails);
  const availableCount = watchItems.filter((item) => item.watchlistDataAvailable).length;
  const top50Count = watchItems.filter((item) => item.decisionAvailable && item.rank > 0).length;
  const actionableCount = watchItems.filter((item) => item.decisionAvailable && item.status === "可试仓").length;
  const highRiskCount = watchItems.filter((item) => item.decisionAvailable && item.risk === "高").length;
  return (
    <div className="simple-page">
      <div className="page-toolbar"><div><h1>自选组合</h1><p>当前浏览器自选 · 可复制股票代码到其他浏览器导入 · 不代表真实持仓</p></div><button className="outline-button" onClick={() => { setTransferOpen(!transferOpen); setTransferText(watchlistedCodes.join(",")); setTransferMessage(""); }}>导入 / 导出</button><button className="primary-button compact" onClick={onAddStock}><IconSearch size={16} /> 添加股票</button></div>
      {transferOpen && <section className="panel portfolio-transfer"><label htmlFor="portfolio-transfer">复制或粘贴六位股票代码（逗号、空格或换行分隔）</label><textarea id="portfolio-transfer" value={transferText} maxLength={3000} onChange={(event) => setTransferText(event.target.value)} /><button className="outline-button" onClick={() => { const codes = [...new Set(transferText.trim().split(/[\s,，]+/).filter(Boolean))]; if (!codes.length || codes.length > 100 || codes.some((code) => !/^\d{6}$/.test(code))) { setTransferMessage("请输入最多100个有效的六位股票代码。"); return; } codes.filter((code) => !watchlistedCodes.includes(code)).forEach((code) => onToggleWatchlist({ code, name: code })); setTransferMessage("已合并到当前自选，名称将从行情资料补全。"); }}>合并导入</button><p role="status">{transferMessage}</p></section>}
      <div className="portfolio-summary">
        <section><span>自选股票</span><strong>{watchItems.length}</strong><small>按实际加入顺序显示</small></section><section><span>行情已就绪</span><strong>{availableCount}</strong><small>{watchItems.length - availableCount ? `${watchItems.length - availableCount}只等待快照刷新` : "全部已有最新研究快照"}</small></section><section><span>当前TOP50</span><strong>{top50Count}</strong><small>基于当前四周期合并榜单</small></section><section><span>可执行 / 高风险</span><strong>{actionableCount} / {highRiskCount}</strong><small>以最新冻结因子结果为准</small></section>
      </div>
      <section className="panel portfolio-table"><div className="panel-head"><div><h2>我的自选</h2><span>本机保存 · 与侧边栏实时一致</span></div></div>{watchItems.length ? <table><thead><tr><th>股票</th><th>行业</th><th>参考价</th><th>涨跌幅</th><th>TOP50排名</th><th>因子支持</th><th>风险状态</th><th>操作</th></tr></thead><tbody>{watchItems.map((item) => <tr onClick={() => item.decisionAvailable && onOpenStock(item)} key={item.code}><td><strong>{item.name}</strong><small>{item.code}</small></td><td>{item.industry}</td><td>{item.watchlistDataAvailable ? item.price.toFixed(2) : "--"}</td><td className={item.watchlistDataAvailable ? (item.pct >= 0 ? "price-up" : "price-down") : ""}>{item.watchlistDataAvailable ? `${item.pct >= 0 ? "+" : ""}${item.pct}%` : "待刷新"}</td><td>{item.decisionAvailable && item.rank > 0 ? `#${item.rank}` : "--"}</td><td>{item.decisionAvailable ? `${item.consensus}/12` : "--"}</td><td><span className={item.decisionAvailable ? (item.risk === "低" ? "positive" : "negative") : "neutral"}>{item.decisionAvailable ? `${item.risk}风险` : "待评估"}</span></td><td>{item.decisionAvailable && <button className="table-action" onClick={(event) => { event.stopPropagation(); onOpenStock(item); }}>查看</button>}<button className="table-action" onClick={(event) => { event.stopPropagation(); onToggleWatchlist(item.code); }}>移除</button></td></tr>)}</tbody></table> : <div className="account-empty"><IconStar size={22} /><strong>暂未加入自选股票</strong><p>点击上方“添加股票”可搜索全部A股。</p></div>}</section>
    </div>
  );
}

function ReviewPage({ onOpenStock }) {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai" }).format(new Date());
  const [date, setDate] = useState(today);
  const [cycle, setCycle] = useState("超短");
  const [refresh, setRefresh] = useState(0);
  const [drafts, setDrafts] = useState(readReviewDrafts);
  useEffect(() => {
    const update = () => setDrafts(readReviewDrafts());
    window.addEventListener("stock-review-draft-added", update);
    return () => window.removeEventListener("stock-review-draft-added", update);
  }, []);
  const { snapshot, state } = useSharedSnapshot(`/api/review?date=${date}&refresh=${refresh}`, 60000);
  const report = snapshot?.date === date ? snapshot.report : null;
  const active = report?.cycles?.find((item) => item.cycle === cycle);
  const pct = (value) => value == null ? "--" : `${value > 0 ? "+" : ""}${Number(value).toFixed(2)}%`;
  return <div className="simple-page review-page">
    <div className="page-toolbar"><div><h1>盘后复盘</h1><p>真实收盘数据 × 盘前冻结榜单 · 报告生成不依赖AI回答</p></div><div className="review-controls"><label>报告日期 <input aria-label="复盘日期" type="date" value={date} max={today} onChange={(event) => setDate(event.target.value || today)} /></label><button className="toolbar-button" onClick={() => setRefresh((value) => value + 1)}><IconRefresh size={15} /> 刷新报告</button></div></div>
    {state === "unavailable" && <div role="status" className="operations-unavailable">报告读取失败。保留已显示报告及原时间，不冒充最新数据。</div>}
    <div className="review-history">已有报告：{snapshot?.dates?.length ? snapshot.dates.map((item) => <button key={item} className={item === date ? "active" : ""} onClick={() => setDate(item)}>{item}</button>) : "暂无存档"}</div>
    {snapshot?.date === date && snapshot.attempt?.reason && <p className="review-warning" role="status">{snapshot.attempt.reason}</p>}
    {!!drafts.length && <details className="review-materials"><summary>本浏览器研究材料（{drafts.length}条，不计入自动报告和预测验证）</summary>{drafts.map((item) => <article key={item.id}><h3>{item.stock?.name || "市场研究"} · {(item.teacherNames || []).join("、")}</h3><small>{formatShanghaiDateTime(item.createdAt)}</small><p>{item.summary}</p></article>)}</details>}
    {!report ? <div className="account-empty" role="status"><IconFileAnalytics size={24} /><strong>{snapshot?.date !== date ? "正在读取报告" : "当日报告待生成"}</strong><p>{snapshot?.attempt?.reason || "交易日15:20首次生成，17:35、18:35补充校准；缺收盘数据时不生成虚构结论。"}</p></div> : <>
      <div className="operations-summary"><span>{report.status === "ready" ? "收盘样本已核验" : "报告不完整 · 不作完整结论"}</span><strong>{report.tradeDate} · 生成于 {formatShanghaiDateTime(report.generatedAt)}</strong><small>冻结 {formatShanghaiDateTime(report.frozenAt)} · 行情基准 {report.referenceDate || "未记录"} · {report.source}</small></div>
      {!!report.gaps?.length && <p className="review-warning" role="status">{report.gaps.join("；")}</p>}
      <div className="review-tabs" role="tablist" aria-label="复盘周期">{["超短", "短线", "波段", "中长线"].map((item) => <button role="tab" aria-selected={cycle === item} key={item} onClick={() => setCycle(item)}>{item}</button>)}</div>
      <div className="accuracy-kpis"><section><span>有效收盘覆盖</span><strong>{active?.observed ?? 0} / {active?.expected ?? 0}</strong><small>当日价格匹配，不用旧价补位</small></section><section><span>榜单等权日表现</span><strong>{pct(active?.averageChange)}</strong><small>相对冻结参考价，非实盘收益</small></section><section><span>上涨股票</span><strong>{active?.advancing ?? 0}</strong><small>仅统计有效价格样本</small></section><section><span>收盘跌破失效价</span><strong>{active?.invalidated ?? 0}</strong><small>规则复核项，不自动下单</small></section></div>
      <section className="panel"><div className="panel-head"><div><h2>逐股复核 · {cycle}</h2><span>{report.method}</span></div></div><div className="quality-table-scroll"><table><thead><tr><th>股票</th><th>行业</th><th>冻结参考价</th><th>当日收盘</th><th>日表现</th><th>失效规则</th><th>研究</th></tr></thead><tbody>{active?.stocks?.map((item) => <tr key={item.code}><td><strong>{item.name}</strong><small>{item.code}</small></td><td>{item.industry}</td><td>{item.referencePrice ?? "--"}</td><td>{item.close ?? "缺数据"}</td><td className={item.change > 0 ? "price-up" : item.change < 0 ? "price-down" : ""}>{pct(item.change)}</td><td>{item.invalidated == null ? "未核验" : item.invalidated ? `跌破 ${item.invalidPrice}` : `未跌破 ${item.invalidPrice}`}</td><td><button className="table-action" onClick={() => onOpenStock(item)}>查看股票</button></td></tr>)}</tbody></table></div></section>
      <div className="review-two-columns"><section className="panel"><div className="panel-head"><div><h2>行业表现分布</h2><span>描述性归因，不证明因果</span></div></div><div className="review-list">{active?.industries?.map((item) => <div key={item.industry}><strong>{item.industry}</strong><span>{item.count}只</span><b>{pct(item.averageChange)}</b></div>)}</div><p className="page-data-method">{report.attributionMethod}</p></section><section className="panel"><div className="panel-head"><div><h2>当日资讯依据</h2><span>点击跳转原文，自行核验关联性</span></div></div><div className="review-news">{report.news?.length ? report.news.map((item) => <a key={item.url} href={item.url} target="_blank" rel="noopener noreferrer"><strong>{item.title}</strong><small>{formatShanghaiDateTime(item.publishedAt)}</small></a>) : <p>没有当日可核验资讯，未使用旧新闻填充。</p>}</div></section></div>
      <section className="panel"><div className="panel-head"><div><h2>次日研究检查单</h2><span>条件式推演，不是涨跌预测</span></div></div><div className="review-scenarios">{report.nextDayPlan?.map((item) => <article key={item.scenario}><h3>{item.scenario}</h3><p>{item.condition}</p><small>{item.action}</small></article>)}</div></section>
    </>}
  </div>;
}

function SourceQualityPanel({ hideFeeds = false }) {
  const { snapshot, state } = useSharedSnapshot("/api/source-quality", 30000);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState("all");
  const labels = { ready: "有效响应", failed: "请求失败", empty: "空数据" };
  const endpoints = (snapshot?.endpoints || []).filter((item) => `${item.provider} ${item.endpoint}`.toLowerCase().includes(query.trim().toLowerCase()) && (result === "all" || item.status === result));
  return <section className="panel source-quality-panel"><div className="panel-head"><div><h2>数据源质量</h2><span>{snapshot?.window || "等待真实接口观测"}</span></div><div className="quality-filters"><label className="search-field"><IconSearch size={14} /><input placeholder="搜索数据源 / 接口" value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label="接口响应状态" value={result} onChange={(event) => setResult(event.target.value)}><option value="all">全部状态</option>{Object.entries(labels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></div></div>
    {state === "unavailable" && <p className="review-warning" role="status">质量记录读取失败，不能据此认定数据源正常。</p>}
    {!hideFeeds && <SourceFeedCards feeds={snapshot?.feeds} />}
    {snapshot?.endpoints?.length ? <div className="quality-table-scroll"><table><thead><tr><th>数据源 / 接口</th><th>最近结果</th><th>原始行数</th><th>数据时间</th><th>最近成功</th><th>请求样本</th><th>失败率 / 空响应</th><th>P95耗时</th><th>剩余额度</th></tr></thead><tbody>{endpoints.map((item) => <tr key={`${item.provider}:${item.endpoint}`}><td><strong>{item.provider}</strong><small>{item.endpoint}</small></td><td>{labels[item.status] || "未知"}<small>{item.errorCategory || ""}</small></td><td>{item.rowCount}</td><td>{item.dataTime || "未返回"}</td><td>{formatShanghaiDateTime(item.lastSuccessAt)}</td><td>{item.sampleCount}</td><td>{item.failureRate}% / {item.emptyCount}次</td><td>{formatDurationMs(item.p95DurationMs)}</td><td>未知</td></tr>)}{!endpoints.length && <tr><td colSpan="9">没有符合筛选条件的接口</td></tr>}</tbody></table></div> : <div className="account-empty"><strong>尚无本版本接口观测</strong><p>后续真实采集请求会自动记录；不会补造历史错误率。</p></div>}
    <p className="page-data-method">{snapshot?.quotaNote} 原始行数不等于有效股票覆盖。观测截止 {formatShanghaiDateTime(snapshot?.generatedAt)}</p>
  </section>;
}

function SourceFeedCards({ feeds }) {
  return <div className="review-feed-grid">{feeds?.map((item) => <article key={item.name}><h3>{item.name}</h3><strong>{item.count ?? "--"}{item.expected ? ` / ${item.expected}` : ""}<small> 条</small></strong><p>{item.status}</p><small>{item.provider || "来源未记录"} · 数据日 {item.date || "见原文时间"}<br />采集 {formatShanghaiDateTime(item.at)}{item.staleCount != null ? ` · 旧价 ${item.staleCount} 条` : ""}</small></article>)}</div>;
}

function AccuracyPage() {
  const { snapshot, state } = useSharedSnapshot("/api/accuracy", 300000);
  const { snapshot: acceptance } = useSharedSnapshot("/api/acceptance", 60000);
  const [version, setVersion] = useState("all");
  const [cycle, setCycle] = useState("all");
  const [horizon, setHorizon] = useState("all");
  const [breakdown, setBreakdown] = useState("四周期");
  const overall = version === "all" ? snapshot?.overall || {} : snapshot?.factorVersions?.[version] || { sampleCount: 0, sampleStatus: "insufficient" };
  const records = (snapshot?.recentEvaluations || []).filter((item) => (cycle === "all" || item.cycle === cycle) && (horizon === "all" || item.horizon === horizon));
  const versions = [...new Set([snapshot?.currentFactorVersion, ...Object.keys(snapshot?.factorVersions || {})].filter(Boolean))];
  const [evidenceId, setEvidenceId] = useState(null);
  const [evidence, setEvidence] = useState(null);
  const [evidenceState, setEvidenceState] = useState("idle");
  const triggerRef = useRef(null);
  const dialogRef = useRef(null);
  const evidenceRequestRef = useRef({ token: 0, predictionId: null });
  const breakdowns = [
    ["预测方向", [["看涨", snapshot?.directions?.up], ["看跌", snapshot?.directions?.down]]],
    ["四周期", Object.entries(snapshot?.cycles || {})],
    ["验证期限", Object.entries(snapshot?.horizons || {}).map(([key, value]) => [value.label || key, value])],
    ["行业", Object.entries(snapshot?.industries || {})],
    ["市场环境", Object.entries(snapshot?.marketRegimes || {}).map(([key, value]) => [{ bull: "偏强", risk_off: "风险收缩", range: "震荡", unknown: "未记录" }[key] || key, value])],
    ["老师因子支持组", Object.entries(snapshot?.byAgent || {})],
    ["因子版本", Object.entries(snapshot?.factorVersions || {})],
  ];
  const hasNumber = (value) => value != null && Number.isFinite(Number(value));
  const percent = (value, digits = 1) => hasNumber(value) ? `${Number(value).toFixed(digits)}%` : "--";
  const metricLabel = (metric) => metric?.sampleStatus === "insufficient"
    ? `样本积累中（${metric.sampleCount || 0}/${snapshot?.minimumSample || 30}）`
    : percent(metric?.hitRate);
  const closeEvidence = () => {
    evidenceRequestRef.current = { token: evidenceRequestRef.current.token + 1, predictionId: null };
    setEvidenceId(null);
    setEvidence(null);
    setEvidenceState("idle");
    focusWithAnimationFrame(triggerRef.current);
  };
  useEffect(() => {
    if (!evidenceId) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") closeEvidence();
    };
    document.addEventListener("keydown", onKeyDown);
    dialogRef.current?.focus();
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [evidenceId]);
  const openEvidence = (item, event) => {
    if (!item.id) return;
    triggerRef.current = event.currentTarget;
    const request = { token: evidenceRequestRef.current.token + 1, predictionId: item.id };
    evidenceRequestRef.current = request;
    setEvidenceId(item.id);
    setEvidence(null);
    setEvidenceState("loading");
    fetch(`/api/accuracy/evidence?predictionId=${encodeURIComponent(item.id)}`, { cache: "no-cache" })
      .then((response) => {
        if (!response.ok) throw new Error(`Evidence request failed: ${response.status}`);
        return response.json();
      })
      .then((data) => {
        if (!isCurrentEvidenceRequest(evidenceRequestRef.current, request)) return;
        setEvidence(data);
        setEvidenceState("ready");
      })
      .catch(() => {
        if (!isCurrentEvidenceRequest(evidenceRequestRef.current, request)) return;
        setEvidenceState("unavailable");
      });
  };
  const displayValue = (value) => value || "数据缺失（未记录）";
  return (
    <div className="simple-page accuracy-page">
      <div className="page-toolbar"><div><h1>预测验证</h1><p>看历史表现，也看每一次判断的依据</p></div><span className="toolbar-button"><IconReportAnalytics size={15} /> 历史验证 · 不保证未来命中</span></div>
      {state === "unavailable" && <div className="account-empty"><IconAlertTriangle size={22} /><strong>准确率数据暂不可用</strong><p>系统不会用模型置信度替代真实验证结果。</p></div>}
      <div className="operations-summary"><span>最近一期冻结 · {acceptance?.pipeline?.tradeDate || "待生成"}</span><strong>{acceptance?.pipeline?.frozenCount ?? 0} 条预测 · 最早到期 {acceptance?.pipeline?.firstMaturityTradeDate || "待确认"}</strong><small>冻结于 {formatShanghaiDateTime(acceptance?.pipeline?.frozenAt || acceptance?.pipeline?.generatedAt)}。与下方历史累计样本不是同一统计范围。</small></div>
      <div className="accuracy-controls"><label>统计版本<select value={version} onChange={(event) => setVersion(event.target.value)}><option value="all">全部历史版本（不是当前策略表现）</option>{versions.map((item) => <option key={item} value={item}>{item === snapshot?.currentFactorVersion ? "当前版本" : "历史版本"} · {item}</option>)}</select></label><span>验证截止 {formatShanghaiDateTime(snapshot?.lastEvaluatedAt)} · 满30条才披露指标</span></div>
      <details className="accuracy-method"><summary>统计范围与数据保护说明</summary>
      <p className="page-data-method">去重股票 {snapshot?.coverage?.stocks ?? "待新统计"} 只 · 预测交易日 {snapshot?.coverage?.tradeDates ?? "待新统计"} 天。周期、期限和老师组可能重叠；记录条数不是独立实验次数。</p>
      <p className="page-data-method">数据保护：盘前只用已确认的上一交易日数据生成新预测；15:10 后按目标交易日收盘验证。未到期、缺数据均不算成功，缺数据也不直接认定为停牌。当前规则为原始收盘价方向比较，持平归入上涨；不代表可成交收益。</p>
      {snapshot?.evaluation && <p className="page-data-method">最近一轮到期验证：新增 {snapshot.evaluation.newlyEvaluated ?? "--"} 条 · 缺数待重试 {snapshot.evaluation.missingCloseQueueCount ?? "待下轮统计"} 条。{snapshot.evaluation.scope || "本轮统计不代表全部历史预测覆盖率。"}</p>}
      </details>
      <div className="accuracy-kpis">
        <section><span>历史成熟样本</span><strong>{overall.sampleCount || 0}</strong><small>当前所选版本 · 非本期完成率</small></section>
        <section><span>方向命中率</span><strong>{metricLabel(overall)}</strong><small>不代表未来收益</small></section>
        <section><span>统计状态</span><strong>{overall.sampleCount >= 30 ? "可查看" : "积累中"}</strong><small>30条只是披露门槛，不代表可靠性证明</small></section>
        <section><span>样本平均收益</span><strong>{hasNumber(overall.averageReturn) ? percent(Number(overall.averageReturn) * 100, 2) : "--"}</strong><small>仅为历史样本统计</small></section>
      </div>
      <details className="panel evidence-method-panel"><summary>基准对比与技术指标（展开查看）</summary><div className="panel-head"><div><h2>与冻结基准比较</h2><span>上证指数 · 同参考日、同到期日 · 仅统计事前已冻结基准的配对样本</span></div></div><div className="accuracy-kpis"><section><span>有效配对样本</span><strong>{overall.pairedSampleCount || 0} / {snapshot?.minimumSample || 30}</strong></section><section><span>基准平均收益</span><strong>{overall.benchmarkAverageReturn == null ? "采集中" : percent(overall.benchmarkAverageReturn * 100, 2)}</strong></section><section><span>平均超额收益</span><strong>{overall.averageExcessReturn == null ? "采集中" : percent(overall.averageExcessReturn * 100, 2)}</strong></section></div><p className="page-data-method">方向评分误差（Brier）：{hasNumber(overall.brierScore) ? Number(overall.brierScore).toFixed(4) : "--"}，仅为未校准评分的探索性误差。旧预测未冻结基准的不补写。老师支持组之间可能重叠，不是独立样本；30条只是披露门槛，不代表统计结论可靠。未扣费、未考虑不可成交，不能视为实盘收益。到期日不利波动不等于持有全程最大回撤。</p></details>
      <div className="accuracy-group-tabs" role="tablist" aria-label="历史统计分组">{breakdowns.map(([title]) => <button role="tab" aria-selected={breakdown === title} key={title} onClick={() => setBreakdown(title)} onKeyDown={(event) => handleTabKeyNavigation(event, breakdowns.map(([name]) => name), breakdown, setBreakdown)}>{title}</button>)}</div>
      <p className="page-data-method">以下分组为全部历史版本统计。策略周期不等于验证期限；例如“中长线 / 1日”只表示中长线策略的次日表现。</p>
      <div className="accuracy-breakdown-grid compact-breakdowns">{breakdowns.filter(([title]) => title === breakdown).map(([title, items]) => <section className="panel" key={title}><div className="panel-head"><div><h2>{title}</h2><span>真实样本数量与历史方向命中率</span></div></div><div className="accuracy-breakdown-list">{!items.length && <p className="page-data-method">暂无该分组的成熟样本。</p>}{items.map(([label, metric]) => <div key={label}><span><strong>{label}</strong><small>{metric?.sampleCount || 0} 条样本</small></span><b>{metricLabel(metric)}</b></div>)}</div></section>)}</div>
      <div className="accuracy-controls"><label>记录策略<select value={cycle} onChange={(event) => setCycle(event.target.value)}>{["all", "超短", "短线", "波段", "中长线"].map((value) => <option key={value} value={value}>{value === "all" ? "全部策略" : value}</option>)}</select></label><label>验证期限<select value={horizon} onChange={(event) => setHorizon(event.target.value)}>{[["all", "全部期限"], ["1d", "1日"], ["5d", "5日"], ["20d", "20日"], ["60d", "60日"]].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label><span>仅筛选最近20条记录，不代表全历史覆盖率</span></div>
      <section className="panel accuracy-evaluation-table"><div className="panel-head"><div><h2>最近验证记录</h2><span>最近 {records.length || 0} 条 · 截止 {snapshot?.lastEvaluatedAt ? new Date(snapshot.lastEvaluatedAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "--"}</span></div></div>{records.length ? <div className="accuracy-table-scroll"><table><thead><tr><th>股票</th><th>周期/期限</th><th>预测</th><th>实际</th><th>收益</th><th>结果</th><th>验证日</th><th>证据</th></tr></thead><tbody>{records.map((item, index) => <tr key={item.id || `${item.code}:${item.evaluatedAt}:${index}`}><td><strong>{item.name || item.code}</strong><small>{item.code}</small></td><td>{item.cycle || "--"} / {item.horizon || "--"}</td><td>{item.predictedDirection === "up" ? "看涨" : "看跌"}{item.probabilityUp == null ? "" : ` · 评分 ${Math.round(item.probabilityUp * 100)}/100`}</td><td>{item.actualDirection === "up" ? "上涨" : item.actualDirection === "down" ? "下跌" : "--"}</td><td className={Number(item.actualReturn) >= 0 ? "price-up" : "price-down"}>{item.actualReturn == null ? "--" : percent(Number(item.actualReturn) * 100, 2)}</td><td><span className={item.hit ? "positive" : "negative"}>{item.hit ? "命中" : "未命中"}</span></td><td>{item.maturityTradeDate || "--"}</td><td><button className="table-action evidence-trigger" disabled={!item.id} onClick={(event) => openEvidence(item, event)}>查看证据</button></td></tr>)}</tbody></table></div> : <div className="account-empty"><IconDatabase size={22} /><strong>当前筛选暂无记录</strong><p>这里仅筛选最近20条记录；清除筛选可查看其他记录。</p></div>}</section>
      {evidenceId && <div className="accuracy-evidence-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEvidence(); }}>
        <section className="accuracy-evidence-dialog" role="dialog" aria-modal="true" aria-labelledby="accuracy-evidence-title" ref={dialogRef} tabIndex="-1">
          <header><div><span>冻结预测证据</span><h2 id="accuracy-evidence-title">{evidence?.prediction?.name || evidence?.prediction?.code || evidenceId}</h2><p>{evidence?.prediction?.code || evidenceId}</p></div><button onClick={closeEvidence} aria-label="关闭证据"><IconX size={17} /></button></header>
          {evidenceState === "loading" && <div className="accuracy-evidence-state">正在读取冻结记录与事件...</div>}
          {evidenceState === "unavailable" && <div className="accuracy-evidence-state"><IconAlertTriangle size={18} /><strong>证据暂不可用</strong><p>未能读取该预测的证据记录；系统没有使用其他股票或静态数据补位。</p></div>}
          {evidenceState === "ready" && evidence && <div className="accuracy-evidence-body">
            <div className="accuracy-evidence-meta"><div><span>冻结时间</span><strong>{formatShanghaiDateTime(evidence.frozenAt)}</strong></div><div><span>数据截止</span><strong>{formatShanghaiDateTime(evidence.dataCutoff)}</strong></div><div><span>来源</span><strong>{displayValue(evidence.source)}</strong></div><div><span>失效规则</span><strong>{displayValue(evidence.invalidationRule)}</strong></div></div>
            <details className="accuracy-evidence-result"><summary>策略版本与基准明细</summary><p>因子版本：{displayValue(evidence.prediction?.factorVersion)} · 市场环境：{({ bull: "偏强", risk_off: "风险收缩", range: "震荡" }[evidence.prediction?.marketRegime] || "未记录")}</p><p>基准：{evidence.prediction?.benchmark ? `${evidence.prediction.benchmark.name} · ${evidence.prediction.benchmark.referenceDate} · ${evidence.prediction.benchmark.referencePrice}` : "当时未冻结基准，不事后补填"}</p><p>老师知识版本：{Object.entries(evidence.prediction?.teacherVersions || {}).map(([name, version]) => `${name}: ${version}`).join("；") || "未记录"}</p></details>
            <section className="accuracy-evidence-result"><h3>验证口径与行情证据</h3><p>事前规则版本：{evidence.prediction?.evaluationRule?.version || "历史记录未单独冻结规则版本，不事后补写"}</p><p>收盘报价来源：{evidence.evaluation?.evaluationEvidence?.provider || "历史记录未保存供应商明细"} · 目标交易日：{evidence.evaluation?.evaluationEvidence?.tradeDate || "未记录"} · 收盘价：{evidence.evaluation?.evaluationEvidence?.close ?? "未记录"}</p><p>采集时间：{evidence.evaluation?.evaluationEvidence?.fetchedAt || "未记录"}。除权除息可能影响原始价格比较，不能视为投资总回报。</p></section>
            {evidence.evaluation && <section className="accuracy-evidence-result"><h3>这次预测是否命中？</h3><p>{evidence.evaluation.actualDirection === "up" ? "上涨" : evidence.evaluation.actualDirection === "down" ? "下跌" : "数据缺失（未记录）"} · {evidence.evaluation.actualReturn == null ? "收益数据缺失" : percent(Number(evidence.evaluation.actualReturn) * 100, 2)} · {evidence.evaluation.hit == null ? "命中结果缺失" : evidence.evaluation.hit ? "命中" : "未命中"}</p></section>}
            <section className="accuracy-evidence-events"><h3>事件时间线</h3>{evidence.events?.length ? <ol>{evidence.events.map((event, index) => <li key={event.eventId || `${event.occurredAt}:${index}`}><strong>{{ evaluation: "收盘验证", evaluation_recorded: "记录验证", invalidation: "记录失效" }[event.type] || "证据事件"}</strong><time>{formatShanghaiDateTime(event.occurredAt)}</time>{event.reason && <p>{event.reason === "maturity_market_data_available" ? "已取得目标交易日收盘数据" : "系统追加证据记录"}</p>}{event.patch && <details><summary>查看原始证据数据</summary><pre>{JSON.stringify(event.patch, null, 2)}</pre></details>}</li>)}</ol> : <p className="accuracy-evidence-empty">暂无追加事件；冻结预测仍保留原始记录。</p>}</section>
          </div>}
        </section>
      </div>}
      <p className="page-data-method"><IconInfoCircle size={15} /> {snapshot?.methodology || "按目标交易日收盘验证方向与概率，不使用模型自评准确率。"}</p>
    </div>
  );
}

function RiskPage({ onOpenStock }) {
  const { snapshot, state } = useSharedSnapshot("/api/risk", 60000);
  const gates = snapshot?.gates || [];
  const alerts = snapshot?.alerts || [];
  return (
    <div className="simple-page">
      <div className="page-toolbar"><div><h1>风险中心</h1><p>{state === "ready" ? `真实快照推导 · 行情截止 ${snapshot?.meta?.marketDataDate || "--"}` : "正在读取真实风险快照"}</p></div><span className="toolbar-button"><IconShieldCheck size={15} /> {snapshot?.meta?.sourceMode === "derived_from_live" ? "可审计规则" : "等待数据"}</span></div>
      {state === "unavailable" && <div className="account-empty"><IconAlertTriangle size={22} /><strong>真实风险数据暂不可用</strong><p>本页不会显示固定风险分数或虚构组合预警。</p></div>}
      <div className="risk-grid">{gates.map((gate) => <section className={`panel risk-card ${gate.tone}`} key={gate.id}><div><span>{gate.title}</span><IconShieldCheck size={20} /></div><strong>{gate.value}</strong><p>{gate.desc}</p><div className="risk-meter"><i style={{ width: `${gate.score}%` }} /></div><small>风险指数 {gate.score}/100 · {gate.evidence}</small></section>)}</div>
      <section className="panel alerts-table"><div className="panel-head"><div><h2>股票风险预警</h2><span>仅来自当前TOP50冻结风险分布；系统故障统一进入运行状态</span></div></div>{alerts.length ? alerts.map((item) => <div className={`alert-row ${item.tone || ""}`} key={item.id}><IconAlertTriangle size={18} /><span><strong>{item.title}</strong><small>{item.detail}</small></span><b>{item.label}</b>{item.action === "stock" ? <button onClick={() => onOpenStock({ code: item.stockCode, name: item.title.split(" 当前")[0], industry: "行业待映射" })}>查看个股</button> : null}</div>) : <div className="account-empty"><IconCircleCheck size={22} /><strong>当前没有股票风险告警</strong><p>系统不会使用静态预警补位。</p></div>}</section>
      {snapshot?.meta?.methodology && <p className="page-data-method"><IconInfoCircle size={15} /> {snapshot.meta.methodology}</p>}
    </div>
  );
}

function OperationsPage() {
  const { snapshot, state } = useSharedSnapshot("/api/operations", 30000);
  const { snapshot: quality } = useSharedSnapshot("/api/source-quality", 30000);
  const labels = { market: "行情数据", news: "定时资讯", ai: "AI研究", scheduler: "定时任务", notification: "通知推送" };
  const statusLabels = { healthy: "正常", degraded: "降级", critical: "严重", unknown: "未知" };
  const components = Object.entries(labels).map(([id, label]) => ({ id, label, ...(snapshot?.components?.[id] || { status: "unknown" }) }));
  return (
    <div className="simple-page operations-page">
      <div className="page-toolbar"><div><h1>运行状态</h1><p>只读运行观测，不展示数据源密钥、原始报错或内部地址</p></div><span className="toolbar-button"><IconActivity size={15} /> 30秒刷新</span></div>
      {state === "unavailable" && <div className="operations-unavailable" role="status"><IconAlertTriangle size={20} /><span><strong>运行状态暂不可用</strong><small>最后已知时间：{formatShanghaiDateTime(snapshot?.generatedAt, true)}</small></span></div>}
      <SourceFeedCards feeds={quality?.feeds} />
      <section className="panel runtime-overview"><div className="panel-head"><h2>运行概览</h2><span>观测于 {formatShanghaiDateTime(snapshot?.generatedAt, true)}</span></div><div className="runtime-overview-grid">{components.map((component) => <div key={component.id}><span>{component.label}</span><strong className={component.status}>{statusLabels[component.status] || "未知"}</strong><small>{component.id === "ai" ? `${snapshot?.aiBudget?.usedCalls ?? "--"} / ${snapshot?.aiBudget?.callLimit ?? "--"} 次/日` : `最后成功 ${formatShanghaiTime(component.lastSuccessAt)}`}</small></div>)}</div></section>
      <SourceQualityPanel hideFeeds />
      <details className="operations-history"><summary>查看采集轮次、AI预算与任务运行明细</summary>
      <div className="operations-summary"><span>AI调用硬上限（当前站点）</span><strong>{snapshot?.aiBudget?.usedCalls ?? "--"} / {snapshot?.aiBudget?.callLimit ?? "--"} 次/日</strong><small>含失败与重试 · 每次最多 {snapshot?.aiBudget?.maxOutputTokensPerCall ?? "--"} 输出 token · 非人民币费用统计</small></div>
      {(snapshot?.delivery || []).map((feed) => <div className="operations-summary" key={feed.name}><span>{feed.name}</span><strong>{feed.label}</strong><small>{feed.count}条 · {feed.origin} · {formatShanghaiDateTime(feed.generatedAt, true)} · {feed.nextTime ? `下轮 ${feed.nextTime}` : "下轮以交易日历为准"}</small></div>)}
      <p className="page-data-method">以下为任务与接口调用历史，和上方共享快照分开核验。备用源或本地同步成功，不会抹去接口失败记录。</p>
      <div className="operations-grid">
        {components.map((component) => <section className={`panel operations-card ${component.status || "unknown"}`} key={component.id}>
          <header><div><span>{component.label}</span><strong>{statusLabels[component.status] || "未知"}</strong></div><IconActivity size={21} /></header>
          <dl>
            <div><dt>最后观测</dt><dd>{formatShanghaiDateTime(component.observedAt, true)}</dd></div>
            <div><dt>最后成功</dt><dd>{formatShanghaiDateTime(component.lastSuccessAt, true)}</dd></div>
            <div><dt>连续失败</dt><dd>{component.consecutiveFailures ?? 0}</dd></div>
            <div><dt>P95耗时</dt><dd>{component.p95DurationMs == null ? "--" : `${component.p95DurationMs} ms`}</dd></div>
            <div><dt>快照年龄</dt><dd>{component.snapshotAgeMs == null ? "--" : formatDurationMs(component.snapshotAgeMs)}</dd></div>
            <div><dt>恢复时间</dt><dd>{formatShanghaiDateTime(component.recovery?.occurredAt, true)}</dd></div>
          </dl>
          {component.id === "ai" && <p>当前队列 {component.queueDepth ?? 0} 个任务</p>}
        </section>)}
      </div>
      </details>
      <p className="page-data-method"><IconInfoCircle size={15} /> 状态由最近成功、失败、恢复事件与快照时间计算；未知不等于正常。</p>
    </div>
  );
}

function NotificationCenter({ platformStatus, items, onClose }) {
  const enableBrowserNotifications = async () => {
    if (!("Notification" in window)) return;
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      new Notification("智策研究通知已启用", {
        body: "当前浏览器打开时，将显示A股盘前、盘中、盘后与全球影响提醒。",
      });
    }
  };
  return (
    <div className="notification-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="notification-center" role="dialog" aria-modal="true" aria-label="通知与定时任务">
        <header>
          <div><span>Asia/Shanghai</span><h2>通知与定时任务</h2><p>严格按A股交易日和上海时间运行</p></div>
          <button onClick={onClose} aria-label="关闭通知中心"><IconX size={17} /></button>
        </header>
        <div className="notification-provider-state">
          <div><span>浏览器通知</span><strong>{typeof Notification !== "undefined" && Notification.permission === "granted" ? "已授权" : "待授权"}</strong><button onClick={enableBrowserNotifications}>启用</button></div>
          <div><span>外部Webhook</span><strong>{platformStatus?.providers?.notification?.configured ? "已连接" : "待配置"}</strong><small>支持企业微信、飞书或自有推送网关</small></div>
        </div>
        <section className="schedule-list">
          <h3>A股任务时间表</h3>
          {(platformStatus?.schedule || []).map((item) => {
            const [time, ...label] = item.split(" ");
            return <div key={item}><time>{time}</time><span>{label.join(" ")}</span></div>;
          })}
        </section>
        <section className="notification-feed">
          <div className="section-line"><h3>最近推送</h3><span>{items.length}条</span></div>
          {items.map((item) => <article key={item.id}><span>{item.createdAt ? new Date(item.createdAt).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }) : "--"}</span><strong>{item.title}{item.repeatCount > 1 ? ` · ${item.repeatCount}次` : ""}</strong><p>{item.body}</p></article>)}
          {!items.length && <div className="notification-empty"><IconBell size={20} /><strong>暂无真实推送记录</strong><p>配置数据源、KV和Webhook后，定时任务结果会出现在这里。</p></div>}
        </section>
      </section>
    </div>
  );
}

export function App() {
  const { snapshot: platformStatus } = useSharedSnapshot("/api/status", 60000);
  const { snapshot: notificationSnapshot } = useSharedSnapshot("/api/notifications", 60000);
  const { snapshot: rootTop50Snapshot, state: rootTop50State } = useSharedSnapshot("/api/top50", 300000);
  const { snapshot: rootMarketSnapshot } = useSharedSnapshot("/api/market", 60000);
  const liveModalUniverse = useMemo(() => {
    const all = Object.values(rootTop50Snapshot?.cycles || {}).flatMap((item) => item.ranking || []).map(hydrateStock);
    return [...new Map(all.map((item) => [item.code, item])).values()];
  }, [rootTop50Snapshot]);
  const [clientId] = useState(() => {
    const stored = window.localStorage.getItem("stock-client-id");
    if (stored) return stored;
    const created = window.crypto?.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    window.localStorage.setItem("stock-client-id", created);
    return created;
  });
  const [active, setActive] = useState(() => {
    const requested = new URLSearchParams(window.location.search).get("view");
    return navItems.some((item) => item.id === requested) ? requested : "overview";
  });
  const [collapsed, setCollapsed] = useState(false);
  const [mobileSidebar, setMobileSidebar] = useState(false);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [stockSearchOpen, setStockSearchOpen] = useState(false);
  const [selected, setSelected] = useState(null);
  const [sectorFilter, setSectorFilter] = useState(null);
  const [selectedTeacher, setSelectedTeacher] = useState("谭琦");
  const [toolMode, setToolMode] = useState("market");
  const [stockModalStock, setStockModalStock] = useState(null);
  const [watchlistedCodes, setWatchlistedCodes] = useState(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem("stock-watchlist") || "null");
      return Array.isArray(stored) ? stored : [];
    } catch {
      return [];
    }
  });
  const [watchlistDetails, setWatchlistDetails] = useState(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem("stock-watchlist-details") || "{}");
      return stored && typeof stored === "object" ? stored : {};
    } catch {
      return {};
    }
  });
  const [followupActions, setFollowupActions] = useState(() => {
    try {
      const stored = JSON.parse(window.localStorage.getItem("stock-followup-actions") || "{}");
      return stored && typeof stored === "object" ? stored : {};
    } catch {
      return {};
    }
  });
  const [preferencesReady, setPreferencesReady] = useState(false);
  useEffect(() => {
    let active = true;
    const hadLocal = window.localStorage.getItem("stock-watchlist") !== null;
    fetch(`/api/preferences?clientId=${encodeURIComponent(clientId)}`, { signal: AbortSignal.timeout(15000) })
      .then((response) => { if (!response.ok) throw new Error("preferences unavailable"); return response.json(); })
      .then(({ preference }) => {
        if (!active || hadLocal || !Array.isArray(preference?.watchlist)) return;
        const rows = preference.watchlist.filter((row) => /^\d{6}$/.test(row.code));
        setWatchlistedCodes(rows.map((row) => row.code));
        setWatchlistDetails(Object.fromEntries(rows.map((row) => [row.code, row])));
      }).finally(() => { if (active) setPreferencesReady(true); }).catch(() => {});
    const syncTabs = (event) => {
      if (event.key !== "stock-watchlist" || event.newValue === null) return;
      try { const rows = JSON.parse(event.newValue); if (Array.isArray(rows)) setWatchlistedCodes(rows.filter((code) => /^\d{6}$/.test(code))); } catch {}
    };
    window.addEventListener("storage", syncTabs);
    return () => { active = false; window.removeEventListener("storage", syncTabs); };
  }, [clientId]);
  useEffect(() => {
    window.localStorage.setItem("stock-watchlist", JSON.stringify(watchlistedCodes));
  }, [watchlistedCodes]);
  useEffect(() => {
    window.localStorage.setItem("stock-watchlist-details", JSON.stringify(watchlistDetails));
  }, [watchlistDetails]);
  useEffect(() => {
    window.localStorage.setItem("stock-followup-actions", JSON.stringify(followupActions));
  }, [followupActions]);
  useEffect(() => {
    if (!preferencesReady || !platformStatus?.providers?.storage?.configured) return;
    const parsePrice = (value) => Number(String(value || "").match(/\d+(?:\.\d+)?/)?.[0]);
    const payload = watchlistedCodes.map((code) => liveModalUniverse.find((item) => item.code === code) || watchlistDetails[code] || { code, name: code }).map((item) => ({
      code: item.code,
      name: item.name,
      triggerPrice: parsePrice(item.trigger),
      riskPrice: parsePrice(item.invalid),
      actions: followupActions[item.code] || {},
    }));
    fetch("/api/preferences", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientId, watchlist: payload }),
    }).catch(() => {});
  }, [clientId, preferencesReady, followupActions, liveModalUniverse, platformStatus?.providers?.storage?.configured, watchlistDetails, watchlistedCodes]);
  useEffect(() => {
    setWatchlistDetails((current) => {
      let changed = false;
      const next = { ...current };
      for (const code of watchlistedCodes) {
        const live = liveModalUniverse.find((item) => item.code === code);
        if (!live || (current[code]?.name === live.name && current[code]?.industry === live.industry)) continue;
        next[code] = { code, name: live.name, industry: live.industry, market: "TOP50" };
        changed = true;
      }
      return changed ? next : current;
    });
  }, [liveModalUniverse, watchlistedCodes]);
  useEffect(() => {
    const missing = watchlistedCodes.filter((code) => {
      const item = watchlistDetails[code];
      return !item?.name || item.name === code || !item?.industry || ["行业待映射", "行情待刷新", "自选跟踪"].includes(item.industry);
    });
    if (!missing.length) return;
    let mounted = true;
    fetch(`/api/stocks/lookup?codes=${encodeURIComponent(missing.join(","))}`, { cache: "no-cache" })
      .then((response) => {
        if (!response.ok) throw new Error(`Lookup request failed: ${response.status}`);
        return response.json();
      })
      .then((result) => {
        if (!mounted || !Array.isArray(result?.items)) return;
        setWatchlistDetails((current) => {
          const next = { ...current };
          for (const item of result.items) next[item.code] = { ...next[item.code], ...item };
          return next;
        });
      })
      .catch(() => {});
    return () => { mounted = false; };
  }, [watchlistedCodes]);
  useEffect(() => {
    const latest = notificationSnapshot?.items?.[0];
    if (!latest?.id) return;
    const previous = window.localStorage.getItem("stock-last-notification");
    window.localStorage.setItem("stock-last-notification", latest.id);
    if (!previous || previous === latest.id || !("Notification" in window) || Notification.permission !== "granted") return;
    new Notification(latest.title, { body: latest.body });
  }, [notificationSnapshot]);
  const watchlistLiveUniverse = useMemo(() => {
    const byCode = new Map(liveModalUniverse.map((item) => [item.code, item]));
    for (const quote of rootMarketSnapshot?.quotes || []) {
      const existing = byCode.get(quote.code) || {};
      const saved = watchlistDetails[quote.code] || {};
      const open = Number(quote.open);
      const price = Number(quote.price);
      byCode.set(quote.code, {
        ...existing,
        ...quote,
        name: existing.name || saved.name || quote.code,
        industry: existing.industry || saved.industry || "自选跟踪",
        price,
        pct: open ? Number(((price / open - 1) * 100).toFixed(2)) : Number(existing.pct || 0),
      });
    }
    return [...byCode.values()];
  }, [liveModalUniverse, rootMarketSnapshot, watchlistDetails]);
  const toggleWatchlist = (input) => {
    const supplied = typeof input === "object" ? input : null;
    const code = supplied?.code || input;
    if (!code) return;
    const removing = watchlistedCodes.includes(code);
    setWatchlistedCodes((codes) => removing ? codes.filter((item) => item !== code) : [...codes, code]);
    setWatchlistDetails((items) => {
      const next = { ...items };
      if (removing) delete next[code];
      else {
        const live = supplied || liveModalUniverse.find((item) => item.code === code) || { code, name: code };
        next[code] = { code, name: live.name || code, industry: live.industry || "行业待映射", market: live.market || "A股" };
      }
      return next;
    });
  };
  const toggleFollowup = (code, type) => setFollowupActions((items) => ({
    ...items,
    [code]: { ...items[code], [type]: !items[code]?.[type] },
  }));
  const goAI = (teacherName) => {
    if (typeof teacherName === "string") setSelectedTeacher(teacherName);
    setActive("ai");
    setMobileSidebar(false);
  };
  const selectAndTop50 = (stock) => { setSelected(stock); setActive("top50"); };
  const goStockAI = (stock) => { setSelected(stock); goAI(); };
  const goSimulation = (stock) => { setSelected(stock); setToolMode("simulation"); setActive("tools"); };
  const openStockModal = (stock) => stock && setStockModalStock(hydrateStock(stock));
  const modalBaseUniverse = liveModalUniverse;
  const stockModalUniverse = stockModalStock && !modalBaseUniverse.some((stock) => stock.code === stockModalStock.code)
    ? [stockModalStock, ...modalBaseUniverse]
    : modalBaseUniverse;
  const stockModalIndex = stockModalStock ? stockModalUniverse.findIndex((stock) => stock.code === stockModalStock.code) : -1;
  const changeModalStock = (offset) => {
    if (!stockModalUniverse.length) return;
    setStockModalStock(stockModalUniverse[(stockModalIndex + offset + stockModalUniverse.length) % stockModalUniverse.length]);
  };
  let content;
  if (active === "overview") content = <OverviewPage onOpenStock={openStockModal} goNews={() => setActive("news")} goTop50={(mapping) => { setSectorFilter(mapping || null); setActive("top50"); }} goIndustries={() => setActive("industries")} watchlistedCodes={watchlistedCodes} watchlistDetails={watchlistDetails} liveStocks={watchlistLiveUniverse} onEditWatchlist={() => setStockSearchOpen(true)} />;
  else if (active === "market") content = <MarketCenterPage onOpenStock={openStockModal} goTop50={() => { setSectorFilter(null); setActive("top50"); }} goNews={() => setActive("news")} watchlistedCodes={watchlistedCodes} watchlistDetails={watchlistDetails} onToggleWatchlist={toggleWatchlist} />;
  else if (active === "top50") content = <Top50Page selected={selected} setSelected={setSelected} sectorFilter={sectorFilter} onClearSectorFilter={() => setSectorFilter(null)} watchlistedCodes={watchlistedCodes} onToggleWatchlist={toggleWatchlist} followupActions={followupActions} onToggleFollowup={toggleFollowup} goStockAI={goStockAI} goSimulation={goSimulation} />;
  else if (active === "news") content = <NewsPage />;
  else if (active === "tools") content = <QuantToolkitPage initialTool={toolMode} initialStock={selected} />;
  else if (active === "industries") content = <IndustriesPage onSelect={openStockModal} />;
  else if (active === "strategies") content = <StrategiesPage selected={selected} setSelected={setSelected} teacher={selectedTeacher} setTeacher={setSelectedTeacher} goAI={goAI} onOpenStock={openStockModal} />;
  else if (active === "ai") content = <AILabPage contextStock={selected} contextTeacher={teachers.find((item) => item.name === selectedTeacher)} clientId={clientId} />;
  else if (active === "portfolio") content = <PortfolioPage onOpenStock={openStockModal} watchlistedCodes={watchlistedCodes} watchlistDetails={watchlistDetails} liveStocks={watchlistLiveUniverse} onToggleWatchlist={toggleWatchlist} onAddStock={() => setStockSearchOpen(true)} />;
  else if (active === "accuracy") content = <AccuracyPage />;
  else if (active === "review") content = <ReviewPage onOpenStock={(item) => openStockModal(liveModalUniverse.find((stock) => stock.code === item.code) || { code: item.code, name: item.name, industry: item.industry })} />;
  else if (active === "risk") content = <RiskPage onOpenStock={openStockModal} />;
  else content = <OperationsPage />;
  return (
    <div className={`app-shell active-${active} ${collapsed ? "sidebar-collapsed" : ""} ${mobileSidebar ? "mobile-sidebar-open" : ""}`}>
      <Sidebar active={active} setActive={(id) => { if (id === "tools") setToolMode("market"); if (id === "top50") setSectorFilter(null); setActive(id); setMobileSidebar(false); }} collapsed={collapsed} setCollapsed={setCollapsed} watchlistedCodes={watchlistedCodes} watchlistDetails={watchlistDetails} onWatchStock={openStockModal} onEditWatchlist={() => setStockSearchOpen(true)} liveStocks={watchlistLiveUniverse} />
      {mobileSidebar && <button className="sidebar-backdrop" onClick={() => setMobileSidebar(false)} aria-label="关闭导航" />}
      <div className="app-content">
        <Header
          active={active}
          onMenu={() => setMobileSidebar(true)}
          onSearch={() => setStockSearchOpen(true)}
          onNotifications={() => setNotificationsOpen(true)}
          platformStatus={{ ...platformStatus, notificationCount: notificationSnapshot?.items?.length || 0 }}
        />
        <div className="page-content">{content}</div>
        <footer>
          <span>A股 · {platformStatus?.session?.label || "上海时间"}</span>
          <span>{platformStatus?.status === "ready" ? "生产链路已验证" : platformStatus?.mode === "live" ? `${platformStatus?.health?.market?.label || "真实数据快照"}；准确率${platformStatus?.health?.accuracy?.sampleCount ? `${platformStatus.health.accuracy.sampleCount}个样本` : "采集中"}；${platformStatus?.health?.scheduler?.status === "observed" ? "调度已观测" : "调度待验证"}` : platformStatus?.providers?.market?.configured && platformStatus?.providers?.news?.configured ? "行情与资讯已配置；其余链路待验证" : "当前为演示数据，禁止用于交易决策"}</span>
          <span>任务时区 Asia/Shanghai</span>
          <span className="footer-spacer" />
          <span>预测按目标交易日收盘验证</span>
          <span>非收益承诺</span>
          <span>隐私政策</span>
        </footer>
      </div>
      <MobilePrimaryNav active={active} setActive={(id) => { if (id === "top50") setSectorFilter(null); setActive(id); setMobileSidebar(false); }} />
      {stockModalStock && (
        <StockDecisionModal
          stock={stockModalStock}
          watchlisted={watchlistedCodes.includes(stockModalStock.code)}
          position={stockModalIndex + 1}
          total={stockModalUniverse.length}
          snapshotMeta={rootTop50Snapshot?.meta}
          snapshotState={rootTop50State}
          followupActions={followupActions[stockModalStock.code] || {}}
          onToggleWatchlist={() => toggleWatchlist(stockModalStock.code)}
          onToggleFollowup={(type) => toggleFollowup(stockModalStock.code, type)}
          onPrevious={() => changeModalStock(-1)}
          onNext={() => changeModalStock(1)}
          onClose={() => setStockModalStock(null)}
          onOpenDetail={() => { setStockModalStock(null); selectAndTop50(stockModalStock); }}
          onSimulation={() => { setStockModalStock(null); goSimulation(stockModalStock); }}
          onAsk={() => { setStockModalStock(null); goStockAI(stockModalStock); }}
        />
      )}
      {notificationsOpen && <NotificationCenter platformStatus={platformStatus} items={notificationSnapshot?.items || []} onClose={() => setNotificationsOpen(false)} />}
      {stockSearchOpen && <StockSearchDialog watchlistedCodes={watchlistedCodes} liveStocks={liveModalUniverse} onToggleWatchlist={toggleWatchlist} onOpenStock={(stock) => { setStockSearchOpen(false); openStockModal(stock); }} onClose={() => setStockSearchOpen(false)} />}
    </div>
  );
}

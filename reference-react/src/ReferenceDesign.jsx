import { IconClock, IconDatabase, IconShieldCheck, IconChartBar } from "@tabler/icons-react";

const banners = {
  overview: "让中国资本市场更透明、更高效",
  top50: "TOP50 · 挖掘市场最强的中国力量",
  market: "行情中心 · 洞察市场脉搏，把握投资先机",
  portfolio: "我的自选 · 关注所选，洞察先机",
  news: "全球财经资讯 · 洞察市场先机",
  industries: "行业主题 · 洞察行业趋势，挖掘投资机会",
  strategies: "老师策略 · 12套策略画像，汇聚智慧，洞察先机",
  ai: "AI研究室 · 让每一次投资决策更有依据",
  accuracy: "预测验证 · 用真实数据验证每一次判断",
  risk: "风险中心 · 理性投资，风险先行",
  operations: "运行状态 · 系统监控，稳定运行，数据驱动",
};

export function ReferenceBanner({ page, children }) {
  if (!banners[page]) return null;
  return <section className={`reference-banner reference-banner-${page}`} aria-label={banners[page]}>
    <img src={`/design-reference/${page}.png`} alt={banners[page]} />
    {children}
  </section>;
}

export function ResearchPromo({ onOpen }) {
  return <button className="research-promo" onClick={onOpen} aria-label="开启AI研究助手"><img src="/design-reference/research-promo.png" alt="AI驱动的专业投研助手，让洞察更聪明" /></button>;
}

export function HomeMetrics({ status, top50 }) {
  const market = status?.health?.market;
  const values = [
    [IconClock, "北京时间", status?.session?.date || "等待观测", status?.session?.label || "Asia/Shanghai"],
    [IconShieldCheck, "行情状态", market?.label?.includes("收盘") ? "收盘快照" : market?.status === "degraded" ? "行情降级" : market?.label ? "行情快照" : "等待观测", market?.label || "按轮次采集 · 非实时行情"],
    [IconDatabase, "数据更新", top50?.meta?.marketDataDate || "待更新", "TOP50 行情基准日"],
    [IconChartBar, "研究覆盖", `${Object.keys(top50?.cycles || {}).length} 个周期`, "超短 / 短线 / 波段 / 中长线"],
  ];
  return <div className="reference-home-metrics">{values.map(([Icon, label, value, detail]) => <section key={label}><Icon size={29} stroke={1.4} /><div><span>{label}</span><strong>{value}</strong><small>{detail}</small></div></section>)}</div>;
}

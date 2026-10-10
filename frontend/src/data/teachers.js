// ⚠️ 文件名有点误导：这里**不再有**任何老师数据。
//
// 原先这里镜像了 reference-react 的 12 位静态老师画像，作为后端不可用时的兜底。
// 那 12 位是原版原型的 mock 人设，已按「只体现创建的老师」的口径从产品里去掉：
// 角色列表现在唯一来源是 `GET /api/agents`（只返回用户自建角色），前端不再做静态兜底。
// 因此 `teachers` 数组已删除，文件里只剩资讯分类那几个 helper（NewsPage 在用）。

export const newsCategories = ['主要', '普通', '观察']

export function newsTierLabel(tier) {
  if (tier === 'primary') return '主要'
  if (tier === 'standard') return '普通'
  return '观察'
}

export function newsCategoryMatches(item, category) {
  const tier = typeof item === 'string' ? item : item?.tier
  if (category === '主要') return tier === 'primary'
  if (category === '普通') return tier === 'standard'
  return tier === 'watch'
}

export function describeNewsClassification(item) {
  const reason = item?.classificationReason || item?.marketScope?.classificationReason
  if (reason === 'explicit_global_marker') return '含海外市场关键词，归入全球观察'
  if (reason === 'explicit_hong_kong_marker') return '含港股/港交所标记，归入港股'
  if (reason === 'domestic_source') return '来自国内披露源，归入A股/中国'
  if (reason === 'default_a_share') return '按A股上下文归类'
  return '分类原因待补充'
}

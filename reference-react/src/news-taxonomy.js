export const newsCategories = ["主要", "普通", "观察"];

function getNewsTier(itemOrTier) {
  return typeof itemOrTier === "string" ? itemOrTier : itemOrTier?.tier;
}

export function newsTierLabel(itemOrTier) {
  const tier = getNewsTier(itemOrTier);
  if (tier === "primary") return "主要";
  if (tier === "standard") return "普通";
  return "观察";
}

export function newsCategoryMatches(itemOrTier, category) {
  const tier = getNewsTier(itemOrTier);
  if (category === "主要") return tier === "primary";
  if (category === "普通") return tier === "standard";
  return tier === "watch";
}

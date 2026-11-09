export function paginationTokens(current, total) {
  const pageCount = Math.max(1, Number(total) || 1);
  const active = Math.max(1, Math.min(pageCount, Number(current) || 1));
  if (pageCount <= 7) return Array.from({ length: pageCount }, (_value, index) => index + 1);
  const tokens = [1];
  const start = Math.max(2, active - 1);
  const end = Math.min(pageCount - 1, active + 1);
  if (start > 2) tokens.push("…");
  for (let page = start; page <= end; page += 1) tokens.push(page);
  if (end < pageCount - 1) tokens.push("…");
  tokens.push(pageCount);
  return tokens;
}

export function itemRange(page, pageSize, total) {
  const count = Math.max(0, Number(total) || 0);
  if (!count) return { start: 0, end: 0 };
  const active = Math.max(1, Number(page) || 1);
  const size = Math.max(1, Number(pageSize) || 1);
  return {
    start: ((active - 1) * size) + 1,
    end: Math.min(count, active * size),
  };
}

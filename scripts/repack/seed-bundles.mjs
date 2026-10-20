/**
 * seed 的 `dsh.profile.bundles` 条目筛选规则（可入库、可测试的单一事实源）。
 *
 * 为什么单独成模块
 * ----------------
 * 这条规则原本只存在于 `EAC-Full-Build-20261004/prepare-composition.mjs` ——
 * 一个**未入库的构建工作区脚本**。它的关键一行是：
 *
 *     // 只排 compat，不要用 defaultEnabled 过滤
 *     if (cat.compat) continue;
 *
 * 为什么不能用 `defaultEnabled`：那个表达式还排除了 `skins` 与 `community` 包，
 * 而皮肤恰恰需要「装着但默认 disabled」（皮肤开关/社区皮肤都这个模式）。
 * 实测按 defaultEnabled 过滤会一次把 63 个 bundle 砍到 43，移掉 20 个，
 * 包括 dsh-pet / dsh-theme-endfield / dsh-image-paste 与全部 15 个皮肤。
 *
 * 为什么必须排除 compat：`compat: 'eac-fork'` 的包依赖 EAC 分叉内核专有服务，
 * 官方 0.2.x 上激活期永久挂起；而 web boot 对「entry 未激活」是 fail-loud 的 ——
 * 一个挂起就整体拒绝渲染（`Failed to load plugins`）。实测 2026-10-21：seed 里
 * 留着 2 个 compat 条目时，全新 full 实例宿主侧 RPC 全绿但 GUI 完全起不来。
 *
 * 现在把规则放在这里（受版本控制、有单测），生成端 import 即可 ——
 * 脚本重写或迁移都不会把规则弄丢。
 */

/** 永远进入 bundles 的三个基座条目（与官方 web profile 出厂模板一致）。 */
export const SEED_BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'eac-plugin-suite'];

/**
 * 判断某个 catalog 条目是否应进入 seed 的 `dsh.profile.bundles`。
 *
 * 规则（务必保持单一判据）：
 *   · `status !== 'preinstalled'` → 不进（desktop-core-precedence / kernel-provided
 *     的包已由别处提供，进 bundles 会重复挂载）
 *   · `catalog.compat` 为真     → 不进（官方内核上激活即挂起，fail-loud 拖垮 GUI）
 *   · 其余                       → 进
 *
 * **不要**额外加 `defaultEnabled` 判据 —— 见文件头注释。
 *
 * @param {{status?: string}} entry        composition entry（含 status）
 * @param {{compat?: string, packs?: string[], defaultEnabled?: boolean}} catalog catalog 条目
 * @returns {boolean}
 */
export function shouldSeedBundle(entry, catalog) {
  if (!entry || typeof entry !== 'object') return false;
  if (entry.status !== 'preinstalled') return false;
  if (catalog && typeof catalog === 'object' && catalog.compat) return false;
  return true;
}

/**
 * 从 composition 的 entries 算出完整的 seed bundles 数组。
 *
 * @param {Array<{name?: string, status?: string, catalog?: object}>} entries composition.entries
 * @returns {string[]} bundles（去重、保持 entries 顺序，基座条目在前）
 */
export function computeSeedBundles(entries) {
  const out = [...SEED_BASE_BUNDLES];
  const seen = new Set(out);
  for (const e of entries ?? []) {
    if (!e || typeof e.name !== 'string') continue;
    if (seen.has(e.name)) continue;
    if (!shouldSeedBundle(e, e.catalog)) continue;
    seen.add(e.name);
    out.push(e.name);
  }
  return out;
}

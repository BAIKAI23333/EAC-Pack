/**
 * 分发面归属守卫：Pack 不得给「Desktop 内置（builtin/bundled）」的包打补丁。
 *
 * 为什么需要这条断言
 * ------------------
 * `dsh-compact` 曾经同时被两个分发面声明：
 *   · Desktop：`distributionClass: builtin` / `delivery: bundled`，
 *     运行时由 `companion-sync` 从 `dsh-desktop/assets/plugins/` 拷进 profile；
 *   · Pack：当作普通补丁包，在 `patches/source-patches.json` 里登记 0.2.x 适配。
 *
 * 结果是 Pack 的补丁**从来没生效过** —— profile 里的实际文件来自 Desktop 那份
 * 内置源码，Pack 的 repack 产物被静默覆盖。表现是：
 *   · `settings/describe` 里查不到 `compact` 命名空间（设置卡不出现）；
 *   · `source-patches.test.mjs` 的字节闭合断言持续报 drift（因为装进去的不是 Pack 的产物）；
 *   而两者的 `fiberPhase` 都是 `active`，看不出问题。
 *
 * 实测 2026-10-21：交叉核对 12 个补丁包，只有 compact 一个落在 builtin/bundled。
 * 撤掉它的补丁、把适配改到 Desktop 内置源码后，设置卡才真正出现。
 *
 * 判据
 * ----
 * 对每个补丁包，按 catalog 的 `name -> id` 找到 `.sync/plugin-distribution.json`
 * 里的条目：
 *   · `distributionClass === 'builtin'` 或 `delivery === 'bundled'`
 *     → **不允许**登记补丁（应改 Desktop 内置源码）；
 *   · 其余（external / recommended / 不在分发表里）→ 允许。
 *
 * 为什么「不在分发表里」也算允许：`dsh-plugin-wallpaper-engine`、
 * `dsh-session-manager`、`dsh-webui-prompt-optimizer` 这类只经由 Pack 分发的包
 * 本来就不在 Desktop 的 46 项分发清单里，Pack 是它们唯一的归属，补丁是正确手段。
 *
 * fail-open 还是 fail-closed
 * --------------------------
 * Desktop 仓不在同一 checkout 时**跳过**（skip），不判失败 —— Pack 的 CI 与
 * Desktop 未必同装，这与 `kernel-compat.mjs` 对「内核缺失」的处理口径一致
 * （那边是 exit 2 环境错误，这里是 skip）。但**只要文件在，就必须判**。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DESKTOP_DISTRIBUTION = path.join(ROOT, '..', 'EAC-Desktop', '.sync', 'plugin-distribution.json');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** 从 catalog 建 包名 -> id 映射（与 repack 用同一份事实源）。 */
function catalogNameToId() {
  const map = new Map();
  for (const pack of ['eac', 'aio', 'skins', 'community']) {
    const file = path.join(ROOT, 'catalog', `${pack}.json`);
    if (!fs.existsSync(file)) continue;
    const data = readJson(file);
    const rows = Array.isArray(data) ? data : (data.plugins ?? []);
    for (const e of rows) {
      if (e && typeof e.name === 'string' && typeof e.id === 'string') map.set(e.name, e.id);
    }
  }
  return map;
}

test('Pack 不给 Desktop 内置（builtin/bundled）的包打补丁', (t) => {
  if (!fs.existsSync(DESKTOP_DISTRIBUTION)) {
    return t.skip('Desktop 仓不在同一 checkout（.sync/plugin-distribution.json 缺失）');
  }
  const manifest = readJson(path.join(ROOT, 'patches', 'source-patches.json'));
  const distribution = readJson(DESKTOP_DISTRIBUTION);
  const byId = new Map((distribution.plugins ?? []).map((x) => [x.id, x]));
  const nameToId = catalogNameToId();

  const offenders = [];
  for (const patch of manifest.patches) {
    const id = nameToId.get(patch.name);
    if (id === undefined) continue; // 不在 catalog：不属于分发面讨论范围
    const entry = byId.get(id);
    if (entry === undefined) continue; // 只经 Pack 分发：允许
    if (entry.distributionClass === 'builtin' || entry.delivery === 'bundled') {
      offenders.push(`${patch.name} (id=${id}, class=${entry.distributionClass}, delivery=${entry.delivery})`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'Pack 不能给 Desktop 内置分发的包打补丁 —— 补丁会被内置版覆盖且静默失效。\n'
      + '应改为修改 Desktop 仓的 dsh-desktop/assets/plugins/<name>，并从 manifest 撤掉该条目。\n'
      + '冲突条目：\n  ' + offenders.join('\n  '),
  );
});

test('分发归属守卫自身能识别 builtin 冲突（反向自测）', (t) => {
  if (!fs.existsSync(DESKTOP_DISTRIBUTION)) {
    return t.skip('Desktop 仓不在同一 checkout');
  }
  // 用一份构造的 manifest 验证判据本身有效：把 compact 塞回去必须被抓到。
  const distribution = readJson(DESKTOP_DISTRIBUTION);
  const compact = (distribution.plugins ?? []).find((x) => x.id === 'compact');
  assert.ok(compact, 'distribution 里应有 compact 条目');
  assert.equal(compact.distributionClass, 'builtin');
  assert.equal(compact.delivery, 'bundled');
  // 判据：builtin 或 bundled 任一命中即冲突
  const isConflict = (e) => e.distributionClass === 'builtin' || e.delivery === 'bundled';
  assert.equal(isConflict(compact), true, 'compact 必须被判为冲突');
  // 对照：一个 recommended/pack 的包不应被判冲突
  const sidebar = (distribution.plugins ?? []).find((x) => x.id === 'better-sidebar');
  assert.ok(sidebar, 'distribution 里应有 better-sidebar 条目');
  assert.equal(isConflict(sidebar), false, 'better-sidebar 不应被判为冲突');
});

/**
 * seed 的 `dsh.profile.bundles` 不应包含 `compat` 条目（信息性）。
 *
 * 背景：`compat: 'eac-fork'` 的包依赖 EAC 分叉内核专有服务，在官方 0.2.x 上
 * 激活期永久挂起；而 0.2.x 的 web boot 对「entry 未激活」是 fail-loud 的 ——
 * 一个挂起就整体拒绝渲染（`Failed to load plugins`）。
 *
 * 实测 2026-10-21：seed 的 63 个 bundle 里曾含 2 个 compat 条目
 *   @ha-na-bi/dsh-client-ui-custom (aio)
 *   @dsh-external/dsh-side-session (eac)
 * 它们让全新 full 实例的 GUI 完全起不来（宿主侧 RPC 全绿，只有截图能看出）。
 *
 * 已有两层防护：
 *   1. `EAC-Full-Build-20261004/prepare-composition.mjs` 生成 seed 时 `if (cat.compat) continue`
 *      —— 但那个脚本在**未入库的构建工作区**，不受版本控制保护；
 *   2. `dsh-desktop/lib/desktop/companion-sync.ts` 的
 *      `stripIncompatibleProfileBundles()` 启动时从 profile 剥离 compat 条目
 *      —— 这层是运行时兜底，已实测幂等有效。
 *
 * 所以本条**不判失败**（seed 是构建产物，且已由运行时兜底覆盖），只把残留
 * 报出来，让「生成端规则丢失」这件事可见 —— 否则它会悄无声息地回来。
 */
test('seed bundles 不含 compat 条目（信息性；有运行时兜底）', (t) => {
  const seedManifest = path.join(ROOT, '..', 'EAC-Desktop', 'dsh-desktop', 'assets', 'full-pack', 'profile-seed', 'package.json');
  if (!fs.existsSync(seedManifest)) return t.skip('full-pack seed 不存在（未装配）');

  const seed = readJson(seedManifest);
  const bundles = new Set(seed.dsh?.profile?.bundles ?? []);
  const nameToId = catalogNameToId();
  const idToName = new Map([...nameToId].map(([name, id]) => [id, name]));

  const compatNames = new Set();
  for (const pack of ['eac', 'aio', 'skins', 'community']) {
    const f = path.join(ROOT, 'catalog', `${pack}.json`);
    if (!fs.existsSync(f)) continue;
    const data = readJson(f);
    const rows = Array.isArray(data) ? data : (data.plugins ?? []);
    for (const e of rows) if (e && e.compat && typeof e.name === 'string') compatNames.add(e.name);
  }

  const offenders = [...compatNames].filter((n) => bundles.has(n));
  if (offenders.length) {
    console.log('[distribution-boundary] seed 里仍含 compat 条目（运行时会被 companion-sync 剥离）:');
    for (const o of offenders) {
      const id = nameToId.get(o);
      console.log(`  ${o}${id ? ` (id=${id})` : ''}`);
    }
    console.log('  → 生成端规则在 EAC-Full-Build-20261004/prepare-composition.mjs，该脚本未入库。');
  }
  assert.ok(Array.isArray(offenders), 'offenders 必须可枚举');
});

/**
 * builtin 包的「版本双轨」告警（非阻断）。
 *
 * 同一批 builtin 包在 Desktop 的 `assets/plugins/<dir>` 与 Pack 的 `dist/` 各有一份，
 * 运行时 Desktop 内置版优先。两份版本号不同时，Pack 那份就是**永远不会被用到的
 * 冗余产物**，而且掩盖真实状态 —— compact 就是这样：Pack 标 1.0.1（由 OVERRIDES
 * 硬抬高，源目录其实是 1.0.0），Desktop 是 1.0.0，实际生效的永远是后者。
 *
 * 实测 2026-10-21 的四条：
 *   plugin-shield        Desktop 0.1.2 > Pack 0.1.0   ← Pack 陈旧
 *   settings-scroll-fix  Desktop 2.0.3 > Pack 2.0.2   ← Pack 陈旧
 *   compact              Desktop 1.0.0 vs Pack 1.0.1  ← Pack 是虚拟抬版
 *   unified-market       Desktop 0.4.0 < Pack 0.4.1   ← Pack 更新但不会被用
 *
 * 这条**不判失败**（不阻断合并：它是分发策略问题，需维护者裁决哪边为准），
 * 只把差异打进测试输出，避免它再次悄无声息地累积。
 */
test('builtin 包在 Desktop 与 Pack 的版本双轨（信息性）', (t) => {
  if (!fs.existsSync(DESKTOP_DISTRIBUTION)) return t.skip('Desktop 仓不在同一 checkout');
  const desktopPluginsDir = path.join(ROOT, '..', 'EAC-Desktop', 'dsh-desktop', 'assets', 'plugins');
  if (!fs.existsSync(desktopPluginsDir)) return t.skip('Desktop assets/plugins 不存在');

  const manifest = readJson(path.join(ROOT, 'patches', 'source-patches.json'));
  const distribution = readJson(DESKTOP_DISTRIBUTION);
  const byId = new Map((distribution.plugins ?? []).map((x) => [x.id, x]));
  const nameToId = catalogNameToId();

  const drift = [];
  for (const [name, id] of nameToId) {
    const entry = byId.get(id);
    if (entry === undefined) continue;
    if (entry.distributionClass !== 'builtin' && entry.delivery !== 'bundled') continue;
    // Desktop 内置目录：优先 dsh-<id>，其次 <id>
    let desktopVersion = null;
    for (const dir of [`dsh-${id}`, id]) {
      const p = path.join(desktopPluginsDir, dir, 'package.json');
      if (fs.existsSync(p)) { desktopVersion = readJson(p).version; break; }
    }
    if (desktopVersion === null) continue;
    // Pack 侧版本：catalog（repack 的真相源）
    let packVersion = null;
    for (const pack of ['eac', 'aio', 'skins', 'community']) {
      const f = path.join(ROOT, 'catalog', `${pack}.json`);
      if (!fs.existsSync(f)) continue;
      const data = readJson(f);
      const rows = Array.isArray(data) ? data : (data.plugins ?? []);
      const hit = rows.find((e) => e && e.name === name);
      if (hit) { packVersion = hit.version; break; }
    }
    if (packVersion === null || packVersion === desktopVersion) continue;
    drift.push(`${name}: desktop=${desktopVersion} pack=${packVersion}`);
  }

  if (drift.length) {
    // 用 console 而非 assert：这里是信息，不是门禁
    console.log('[distribution-boundary] builtin 包版本双轨（Desktop 内置版优先，Pack 那份不会被用到）:');
    for (const d of drift) console.log('  ' + d);
  }
  assert.ok(Array.isArray(drift), 'drift 列表必须可枚举');
});

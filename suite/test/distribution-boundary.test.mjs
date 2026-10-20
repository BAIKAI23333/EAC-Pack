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

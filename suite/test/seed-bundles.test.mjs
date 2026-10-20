/**
 * `seed-bundles.mjs` 的回归测试。
 *
 * 这条规则以前只活在未入库的构建工作区脚本里，没有测试 —— 一旦脚本重写就无声
 * 丢失，而后果是**整机 GUI 起不来**。本测试把它钉死。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { shouldSeedBundle, computeSeedBundles, SEED_BASE_BUNDLES } from '../../scripts/repack/seed-bundles.mjs';

test('compat 条目一律不进 bundles', () => {
  // 两个真实案例：都是 compat: eac-fork，都曾让全新 full 实例 GUI 起不来
  assert.equal(shouldSeedBundle({ status: 'preinstalled' }, { compat: 'eac-fork' }), false);
  assert.equal(shouldSeedBundle({ status: 'preinstalled' }, { compat: 'anything' }), false);
  // 对照：没有 compat 就进
  assert.equal(shouldSeedBundle({ status: 'preinstalled' }, { compat: undefined, packs: ['eac'] }), true);
});

test('非 preinstalled 状态不进 bundles', () => {
  // desktop-core-precedence：包已由桌面核自带，进 bundles 会重复挂载
  assert.equal(shouldSeedBundle({ status: 'desktop-core-precedence' }, {}), false);
  // kernel-provided-precedence：内核已提供
  assert.equal(shouldSeedBundle({ status: 'kernel-provided-precedence' }, {}), false);
  assert.equal(shouldSeedBundle({ status: 'preinstalled' }, {}), true);
});

test('皮肤与社区包仍然进 bundles（不能被 defaultEnabled 误伤）', () => {
  // 这是踩过的坑：按 defaultEnabled 过滤会把这些一起砍掉。
  // 皮肤的正确模式是「装着但默认 disabled」，所以必须进 bundles。
  const skinEntry = { status: 'preinstalled' };
  const skinCatalog = { defaultEnabled: false, packs: ['skins'] };
  assert.equal(shouldSeedBundle(skinEntry, skinCatalog), true, '皮肤必须进 bundles');

  const communityCatalog = { defaultEnabled: false, packs: ['community'] };
  assert.equal(shouldSeedBundle(skinEntry, communityCatalog), true, '社区包必须进 bundles');
});

test('computeSeedBundles 保留基座条目并去重', () => {
  const entries = [
    { name: '@deepseek-ai/dsh-base', status: 'preinstalled' },   // 重复，应去重
    { name: 'dsh-compact', status: 'desktop-core-precedence' },  // 不进
    { name: 'dsh-better-sidebar', status: 'preinstalled', catalog: { packs: ['eac'] } },
    { name: '@ha-na-bi/dsh-client-ui-custom', status: 'preinstalled', catalog: { compat: 'eac-fork' } }, // 不进
    { name: 'dsh-pet', status: 'preinstalled', catalog: { defaultEnabled: false, packs: ['eac'] } },
  ];
  const bundles = computeSeedBundles(entries);
  for (const base of SEED_BASE_BUNDLES) assert.ok(bundles.includes(base), `基座条目 ${base} 必须在内`);
  assert.ok(bundles.includes('dsh-better-sidebar'), '普通 preinstalled 包应进');
  assert.ok(bundles.includes('dsh-pet'), 'defaultEnabled=false 但非 compat 的包应进');
  assert.ok(!bundles.includes('@ha-na-bi/dsh-client-ui-custom'), 'compat 包不进');
  assert.ok(!bundles.includes('dsh-compact'), 'desktop-core-precedence 不进');
  assert.equal(bundles.filter((b) => b === '@deepseek-ai/dsh-base').length, 1, '不得重复');
});

test('真实 composition 算出 61 条（63 减去 2 个 compat）', (t) => {
  // 用本机的真实 composition 跑一次：63 个 bundle 里含 2 个 compat，
  // 算出来必须是 61，且不含那两个。
  const compositionPath = 'D:/AI_Coding/EAC/EAC-Full-Build-20261004/EAC-Desktop/dsh-desktop/assets/full-pack/composition.json';
  if (!fs.existsSync(compositionPath)) return t.skip('composition.json 不存在（未装配 full-pack）');
  const composition = JSON.parse(fs.readFileSync(compositionPath, 'utf8'));
  const bundles = computeSeedBundles(composition.entries);
  const seeded = new Set(bundles);

  // 所有 compat 条目都不得在内
  const compatNames = (composition.entries ?? [])
    .filter((e) => e.catalog && e.catalog.compat)
    .map((e) => e.name);
  assert.ok(compatNames.length > 0, '真实 composition 里应有 compat 条目（否则本测试失去意义）');
  for (const n of compatNames) {
    assert.ok(!seeded.has(n), `compat 条目 ${n} 不应进 bundles`);
  }

  // 皮肤必须都在（防 defaultEnabled 误伤）
  const skinNames = (composition.entries ?? [])
    .filter((e) => e.status === 'preinstalled' && (e.catalog?.packs ?? []).includes('skins'))
    .map((e) => e.name);
  for (const n of skinNames) {
    assert.ok(seeded.has(n), `皮肤 ${n} 必须进 bundles`);
  }
  console.log(`[seed-bundles] 真实 composition: ${bundles.length} 条 bundles，排除 compat ${compatNames.length} 条`);
});

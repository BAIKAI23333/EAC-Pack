/**
 * 产物可加载性守卫：seed 的 `dsh.profile.bundles` 里每个包，其产物 tgz 必须自带
 * `dsh.bundle` 声明。
 *
 * 为什么需要这条
 * --------------
 * 内核按 bundle 行加载插件时要求包自带 `dsh.bundle` 声明，缺失就**静默跳过**：
 *
 *   dsh: skipping profile bundle "@deepseek-ai/dsh-balance":
 *     Error: profile bundle ... declares no dsh.bundle in its package.json
 *   dsh: warning: 1 entry did not activate
 *
 * 后果是设置面与功能整块消失，而启动审计只在最后给一行「1 entry did not activate」，
 * 极难归因到具体包。
 *
 * 实测 2026-10-21：清空 dist 全量重建后，62 个 seed bundle 里 **16 个**缺这个声明
 * （balance / conversation-tweaks / prompt-custom / openclaw-bridge /
 * settings-groups / float-window / skin-switch / file-changes 系列…）。
 * 根因是 `dsh.bundle` 由 `ensure-bundles.mjs` 事后补写，而 repack 当时不会自动调它。
 *
 * 为什么「补丁字节闭合」挡不住
 * ----------------------------
 * `source-patches.test.mjs` 验的是「补丁文件内容 == manifest 声明的 outputSha256」。
 * 这证明**补丁被正确应用**，但完全不涉及 `package.json` 里的 `dsh.bundle` ——
 * 那一步由 ensure-bundles 重打 tgz 时补。所以「字节全绿」与「能被内核加载」
 * 是两个不同的断言，必须分别守。
 *
 * fail 条件
 * ---------
 * · dist 不存在 → skip（未装配）
 * · full-pack seed 不存在 → skip（Desktop 仓不在同一 checkout）
 * · 否则任何缺失都判失败
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const DIST_INDEX = path.join(ROOT, 'dist', 'index.json');
const SEED = path.join(ROOT, '..', 'EAC-Desktop', 'dsh-desktop', 'assets', 'full-pack', 'profile-seed', 'package.json');

/** 读取 tgz 内某个文件的文本内容。 */
function readFromTgz(tgzPath, innerPath) {
  return cp.execFileSync('tar', ['-xOf', tgzPath, innerPath], {
    maxBuffer: 64 * 1024 * 1024,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test('seed bundles 里的每个产物都自带 dsh.bundle 声明', (t) => {
  if (!fs.existsSync(DIST_INDEX)) return t.skip('dist/index.json 不存在（未装配）');
  if (!fs.existsSync(SEED)) return t.skip('full-pack seed 不存在（Desktop 仓不在同一 checkout）');

  const index = JSON.parse(fs.readFileSync(DIST_INDEX, 'utf8'));
  const seed = JSON.parse(fs.readFileSync(SEED, 'utf8'));
  const bundles = seed.dsh?.profile?.bundles ?? [];
  assert.ok(bundles.length > 0, 'seed 应包含 profile.bundles');

  const byName = new Map(index.map((e) => [e.name, e]));
  const missing = [];
  const notInDist = [];

  for (const name of bundles) {
    const entry = byName.get(name);
    if (!entry) { notInDist.push(name); continue; }
    const tgz = path.join(ROOT, 'dist', entry.file);
    if (!fs.existsSync(tgz)) { notInDist.push(name); continue; }
    try {
      const pkg = JSON.parse(readFromTgz(tgz, 'package/package.json'));
      if (!pkg.dsh?.bundle) missing.push(name);
    } catch (err) {
      missing.push(`${name}（tgz 读取失败: ${err.message.split('\n')[0]}）`);
    }
  }

  // 不在 dist 里的包不算失败：kernelProvided / desktop-core-precedence 的包
  // 由内核或桌面壳自带，seed 里列它们是为了启停状态，不需要 Pack 产物。
  assert.deepEqual(
    missing,
    [],
    'seed bundles 里的包必须自带 dsh.bundle，否则内核会静默跳过它、功能整块消失。\n'
      + '修复：node scripts/repack/ensure-bundles.mjs（repack 全量跑完已自动调用）。\n'
      + '缺失：\n  ' + missing.join('\n  '),
  );

  console.log(`[artifact-loadable] seed bundles ${bundles.length} 个，dist 覆盖 ${bundles.length - notInDist.length} 个，全部自带 dsh.bundle`);
  if (notInDist.length) {
    console.log(`[artifact-loadable] 其中 ${notInDist.length} 个不在 dist（由内核/桌面壳提供，正常）：${notInDist.slice(0, 6).join(', ')}${notInDist.length > 6 ? ' …' : ''}`);
  }
});

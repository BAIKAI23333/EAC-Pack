// 把 dist/index.json 的补丁包结果同步进 suite/assets/bootstrap.json。
//
// 为什么必须有这一步
// ------------------
// `repack.mjs` 会改变补丁包 tgz 的字节与 sha256，但不会自动回写
// `suite/assets/bootstrap.json`。而 `full-package.test.mjs` 有一条断言
// 「manifest hash must match dist」—— 不同步就会红。
//
// 这里提供两种用法：
//   · 作为**函数**被 `repack.mjs` 在收尾时调用（自动，避免"人忘了跑"）；
//   · 作为**CLI** 单独跑（`node scripts/repack/sync-bootstrap.mjs`）。
//
// 只动 `patches/source-patches.json` 里登记过的包：其它包的 dist 可能带跨分支
// 污染，不做无谓的"顺手同步"。`parts` 目前只有单文件形态，按 dist 的
// file/bytes/sha256 重写。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ROOT 是仓库根：本文件位于 scripts/repack/。
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * 同步 bootstrap.json 里与补丁包相关的条目（原地写回文件）。
 *
 * @param {object} [options]
 * @param {string[]} [options.names]  只同步这些包名；省略 = 同步全部已登记补丁包
 * @param {(msg: string) => void} [options.log]  日志函数；默认 console.log
 * @param {boolean} [options.dryRun]  只计算不写文件（测试用）
 * @returns {number} 实际变更的条目数
 */
export function syncBootstrapEntries(options = {}) {
  const log = typeof options.log === 'function' ? options.log : console.log;
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'patches', 'source-patches.json'), 'utf8'));
  const distPath = path.join(ROOT, 'dist', 'index.json');
  if (!fs.existsSync(distPath)) throw new Error(`dist/index.json 不存在：${distPath}`);
  const dist = JSON.parse(fs.readFileSync(distPath, 'utf8'));
  const bootstrapPath = path.join(ROOT, 'suite', 'assets', 'bootstrap.json');
  const bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));

  const only = Array.isArray(options.names) ? new Set(options.names) : null;
  const distByName = new Map(dist.map((e) => [e.name, e]));
  const bootByName = new Map((bootstrap.items ?? []).map((i) => [i.name, i]));

  let changed = 0;
  for (const patch of manifest.patches) {
    if (only && !only.has(patch.name)) continue;
    const d = distByName.get(patch.name);
    if (!d) throw new Error(`dist missing ${patch.name}`);
    const item = bootByName.get(patch.name);
    if (!item) throw new Error(`bootstrap missing ${patch.name}`);

    const before = JSON.stringify(item);
    item.version = d.version;
    item.file = d.file;
    item.sha256 = d.sha256;
    item.bytes = d.bytes;
    if (d.locallyRepacked) {
      item.locallyRepacked = true;
      item.repackNote = d.repackNote;
    }
    if (Array.isArray(item.parts) && item.parts.length === 1) {
      item.parts = [{ file: d.file, bytes: d.bytes, sha256: d.sha256 }];
    }
    if (JSON.stringify(item) !== before) {
      changed += 1;
      log(`sync ${patch.name}: ${d.bytes}B ${d.sha256.slice(0, 12)}`);
    }
  }

  if (options.dryRun) return changed;
  fs.writeFileSync(bootstrapPath, JSON.stringify(bootstrap, null, 2) + '\n');
  return changed;
}

// CLI 入口：只有「被直接执行」时才跑，被 import 时不自动执行。
const invokedDirectly = (() => {
  try {
    return process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
  } catch { return false; }
})();

if (invokedDirectly) {
  const changed = syncBootstrapEntries();
  console.log(`bootstrap items updated: ${changed}`);
}

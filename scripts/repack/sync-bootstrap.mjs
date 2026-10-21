// 把 dist/index.json 的补丁包结果同步进 suite/assets/bootstrap.json。
//
// 为什么必须显式存在这个步骤
// --------------------------
// `repack.mjs --only <pkg>` 会改变该包的 tgz 字节与 sha256，但**不会**回头改
// `suite/assets/bootstrap.json`。而 `full-package.test.mjs` 有一条断言
// 「manifest hash must match dist」—— 忘了同步就会红。
//
// 这个脚本原先只存在于 `.cache/`（gitignored），等于「只有本机作者知道的一步」，
// 别人重打包后必然踩红，还会以为是自己改坏了。搬到 `scripts/repack/` 使之可被发现。
//
// 用法：`node scripts/repack/sync-bootstrap.mjs`（repack 全量跑完也应调用一次）
//
// 只动 manifest.patches 里登记过的包：其它包的 dist 存在跨分支污染的可能，
// 不做无谓的"顺手同步"。parts 只有单文件形态，按 dist 的 file/bytes/sha256 重写。
import fs from 'node:fs';
import path from 'node:path';

// ROOT 是仓库根：本文件位于 scripts/repack/，所以向上两级。
const ROOT = path.resolve(import.meta.dirname, '..', '..');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'patches', 'source-patches.json'), 'utf8'));
const dist = JSON.parse(fs.readFileSync(path.join(ROOT, 'dist', 'index.json'), 'utf8'));
const bootstrapPath = path.join(ROOT, 'suite', 'assets', 'bootstrap.json');
const bootstrap = JSON.parse(fs.readFileSync(bootstrapPath, 'utf8'));

let changed = 0;
for (const patch of manifest.patches) {
  const d = dist.find((e) => e.name === patch.name);
  if (!d) throw new Error(`dist missing ${patch.name}`);
  const item = bootstrap.items.find((i) => i.name === patch.name);
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
    console.log(`sync ${patch.name}: ${d.bytes}B ${d.sha256.slice(0, 12)}`);
  }
}

fs.writeFileSync(bootstrapPath, JSON.stringify(bootstrap, null, 2) + '\n');
console.log(`bootstrap items updated: ${changed}`);


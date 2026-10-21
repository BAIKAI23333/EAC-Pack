/**
 * Tracked source-patch replay for the repack pipeline.
 *
 * Why this exists
 * ---------------
 * Some shipped plugins need a local fix that upstream does not carry yet (see
 * patches/README.md). Those fixes MUST survive a rebuild: if they only live in
 * dist/*.tgz — which is gitignored — anyone re-running the pipeline silently
 * reverts them. This module replays them from the tracked fact source
 * patches/source-patches.json.
 *
 * Contract (fail-closed)
 * ----------------------
 * For every patch file, in order:
 *   1. the materialized staging file MUST hash to `inputSha256`, else throw;
 *   2. the tracked unified diff is applied with `git apply -p1` and
 *      core.autocrlf disabled (byte-exact);
 *   3. the result MUST hash to `outputSha256`, else throw.
 * A drifted upstream therefore fails the build loudly instead of shipping a
 * half-applied fix.
 *
 * Create mode (new files)
 * -----------------------
 * A file entry with `"create": true` adds a file the upstream package does not
 * ship (e.g. a self-contained compat shim). Its contract is still fail-closed:
 *   1. the target MUST NOT exist, and `inputSha256` MUST be absent — supplying
 *      one means “patch an existing file”, which contradicts `create`;
 *   2. the tracked diff (`--- /dev/null` → `+++ b/<path>`) is applied with the
 *      same byte-exact `git apply` in the same scratch directory;
 *   3. the produced bytes MUST hash to `outputSha256`, else throw — only then is
 *      the file written into staging (parent directories created as needed).
 * Entries without `create: true` keep the byte-for-byte replay described above.
 *
 * Why the patch is applied in a scratch directory
 * ----------------------------------------------
 * repack.mjs stages inside `<repo>/.cache/...`, which .gitignore excludes.
 * `git apply` run from inside that repository treats such paths as ignored and
 * exits 0 while changing nothing — a silent no-op that would look like success.
 * The diff is therefore applied in a scratch directory outside any repository
 * and the verified result is copied back.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const MANIFEST = path.join(ROOT, 'patches', 'source-patches.json');

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/**
 * 递归列出目录下所有文件的相对路径（正斜杠），用于比对 `git apply` 前后的
 * 文件集合、发现 diff 里夹带的未登记文件。
 *
 * @param {string} dir
 * @returns {Set<string>}
 */
function listFilesRecursive(dir) {
  const out = new Set();
  const walk = (abs, rel) => {
    let entries;
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childAbs = path.join(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(childAbs, childRel);
      else out.add(childRel);
    }
  };
  walk(dir, '');
  return out;
}

export function loadPatchManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  if (manifest.schemaVersion !== 1) {
    throw new Error(`unsupported source-patches schemaVersion: ${manifest.schemaVersion}`);
  }
  if (!Array.isArray(manifest.patches)) throw new Error('source-patches.json: patches[] missing');
  return manifest;
}

/**
 * @param {object} entry        catalog entry ({name, version, ...})
 * @param {string} staging      materialized package root that patches are applied to
 * @param {Function} [log]      logger; defaults to console.log
 * @param {object} [manifestOverride]  in-memory manifest, for tests that must not
 *                               depend on the tracked patches/source-patches.json
 * @returns {Array<{path:string, sha256:string, note:string}>} applied files (empty when none apply)
 */
export function applySourcePatches(entry, staging, log = console.log, manifestOverride = null) {
  const manifest = manifestOverride ?? loadPatchManifest();
  const patch = manifest.patches.find((p) => p.name === entry.name);
  if (!patch) return [];
  if (patch.version !== entry.version) {
    throw new Error(
      `source patch version mismatch for ${entry.name}: manifest=${patch.version} catalog=${entry.version}`,
    );
  }

  const applied = [];
  const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eac-src-patch-'));
  try {
    for (const file of patch.files) {
      if (!file.path || file.path.includes('..') || path.isAbsolute(file.path)) {
        throw new Error(`unsafe patch path: ${String(file.path)}`);
      }
      const target = path.join(staging, ...file.path.split('/'));
      const isCreate = file.create === true;
      if (isCreate) {
        // Create mode: the file must NOT exist yet, and a pinned input hash would
        // contradict that. Both are authoring mistakes, so fail loudly.
        if (fs.existsSync(target)) {
          throw new Error(
            `source patch create target already exists: ${entry.name} ${file.path}\n` +
              '  drop "create" and pin inputSha256 if the file is meant to be patched in place',
          );
        }
        if (file.inputSha256 !== undefined) {
          throw new Error(
            `source patch create entry must not pin inputSha256: ${entry.name} ${file.path}`,
          );
        }
      } else {
        if (!fs.existsSync(target)) {
          throw new Error(`source patch target missing: ${entry.name} ${file.path}`);
        }

        const beforeSha = sha256(fs.readFileSync(target));
        if (beforeSha !== file.inputSha256) {
          throw new Error(
            `source patch input mismatch for ${entry.name} ${file.path}\n` +
              `  expected ${file.inputSha256}\n  actual   ${beforeSha}\n` +
              '  upstream source drifted -> regenerate patches/ or re-pin the base',
          );
        }
      }

      const diffPath = path.join(ROOT, 'patches', ...file.diff.split('/'));
      if (!fs.existsSync(diffPath)) throw new Error(`source patch diff missing: ${file.diff}`);

      // Apply outside the repository (see the header note), then copy the verified result back.
      const scratchFile = path.join(scratchRoot, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(scratchFile), { recursive: true });
      if (!isCreate) fs.copyFileSync(target, scratchFile);
      // apply 前记下 scratch 里已有的文件，apply 后多出来的必须**恰好**是 manifest
      // 声明的这一个。否则说明 diff 里夹带了未登记的文件 —— 那些文件会在这里被
      // 创建、却永远不会被回读到 staging（本函数只读 scratchFile），表现为
      // 「repack 全绿、运行期缺文件」。
      //
      // 实测过这种情形：一份 diff 声明 2 个新文件时，applied 只返回 1 个，
      // 另一个凭空消失，而函数正常返回 success。
      const beforeFiles = listFilesRecursive(scratchRoot);
      let applyStderr = '';
      try {
        // 捕获 stderr：`git apply` 对**路径不匹配**的补丁会 **exit 0 但什么都不做**，
        // 只在 stderr 里留一句 `Skipped patch '<path>'.`。只看退出码会把
        // 「补丁静默未应用」当成成功。
        //
        // 实测触发条件：diff 带了 `diff --git a/x b/x` 头、而 `-p1` 剥前缀后路径
        // 与工作区不符时，git 就跳过。真正的 create diff 格式是**没有 diff --git 头**、
        // 直接从 `--- /dev/null` 起（见 patches/files/*/lib/settings-compat.js.diff），
        // 那种写法才匹配得上。
        //
        // 目前还有 outputSha256 兜底（文件内容不对会 hash 不匹配而报错），所以这条
        // 缝不会真的把坏补丁放过去；但把 stderr 也纳入判定能让失败信息**指向真因**
        // （"Skipped" 而非 "hash mismatch"），省掉一次误判排查。
        const out = execFileSync(
          'git',
          ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
            'apply', '--whitespace=nowarn', '-p1', diffPath],
          { cwd: scratchRoot, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
        );
        applyStderr = String(out ?? '');
      } catch (err) {
        const stderr = err && err.stderr ? String(err.stderr) : '';
        throw new Error(`git apply failed for ${entry.name} ${file.path}: ${stderr.trim() || err.message}`);
      }
      const skipped = /Skipped patch/.test(applyStderr);
      if (skipped) {
        throw new Error(
          `git apply 静默跳过了补丁（exit 0 但未应用）：${entry.name} ${file.path}\n`
          + `  git stderr: ${applyStderr.trim()}\n`
          + '  最常见原因：diff 带了 `diff --git a/<p> b/<p>` 头，而 -p1 剥一层前缀后\n'
          + '  路径与目标不符。本仓的 create diff 约定是**不带 diff --git 头**、\n'
          + '  直接从 `--- /dev/null` 起（参考 patches/files/*/lib/settings-compat.js.diff）。',
        );
      }
      const afterFiles = listFilesRecursive(scratchRoot);
      const expectedRel = file.path.split('/').join('/');
      const extra = [...afterFiles].filter((rel) => !beforeFiles.has(rel) && rel !== expectedRel);
      if (extra.length) {
        throw new Error(
          `source patch diff 夹带了未登记的文件：${entry.name} ${file.diff}\n`
          + `  manifest 只登记了 ${file.path}\n`
          + `  但 diff 额外创建了：${extra.join(', ')}\n`
          + '  → 这些文件不会被回读到 staging，必须拆成独立的 manifest 条目（或从 diff 里移除）',
        );
      }

      const after = fs.readFileSync(scratchFile);
      const afterSha = sha256(after);
      if (afterSha !== file.outputSha256) {
        throw new Error(
          `source patch output mismatch for ${entry.name} ${file.path}\n` +
            `  expected ${file.outputSha256}\n  actual   ${afterSha}`,
        );
      }
      if (isCreate) {
        // The staging package has no such directory yet, unlike the in-place case
        // where it was created by materialization.
        fs.mkdirSync(path.dirname(target), { recursive: true });
      }
      fs.writeFileSync(target, after);

      // `summary` 是包级字段（patch.summary），不是 per-file；带在每条 applied
      // 记录上，让调用方（repack.mjs 的 repackNote）能优先取它。多文件补丁的
      // per-file note 拼起来可达上千字符，会把 dist/index.json 撑大。
      applied.push({ path: file.path, sha256: afterSha, note: file.note, summary: patch.summary });
      log(`  source-patch ${entry.name}: ${file.path} -> ${afterSha.slice(0, 12)}`);
    }
  } finally {
    fs.rmSync(scratchRoot, { recursive: true, force: true });
  }
  return applied;
}

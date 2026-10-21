/**
 * `files` 白名单补齐 —— npm pack 的第二个关卡。
 *
 * 为什么单独成模块
 * ----------------
 * 这段逻辑是「补丁重建出的文件能否活到 tgz 里」的唯一保障，却极难在整条
 * repack 管线里单独断言（repack.mjs 是顶层即执行的脚本）。抽出来之后
 * suite/test/ 可以直接 import 做单元测试，不必跑一遍 300 MB 的打包。
 *
 * 背景
 * ----
 * `source-patches.mjs` 的 create 模式能让补丁**新增**文件，但 npm pack 还会
 * 按 `package.json` 的 `files` 白名单再筛一遍：不在白名单的新文件会被
 * **静默丢弃** —— tgz 打包全绿，运行期才炸。`dsh-better-sidebar` 的 `files`
 * 逐条列了 15 项，正踩这个坑。
 */

/**
 * 单条 `files` 条目是否覆盖给定路径。
 *
 * 只做保守判断：宁可在白名单里多加一条精确路径（无害），也不要把未覆盖的
 * 路径误判成已覆盖（那会让文件被 npm 静默丢掉）。
 *
 * @param {string} filePath 相对包根的路径，例如 `lib/settings-compat.js`
 * @param {string} entry    `files` 数组里的一条，例如 `lib/`、`lib/index.js`、`lib/types/**\/*.d.ts`
 * @returns {boolean}
 */
export function isCoveredByFilesEntry(filePath, entry) {
  if (typeof filePath !== 'string' || !filePath) return false;
  if (typeof entry !== 'string' || !entry) return false;
  if (entry === filePath) return true;
  // 目录形式（"lib/" 或 "lib"）覆盖其下全部内容（含更深层级）。
  const dir = entry.replace(/\/+$/, '');
  if (dir && filePath.startsWith(`${dir}/`)) return true;
  // 含通配时走 glob 判定。**单星与双星语义必须区分**：
  //   `*`  只匹配**一个**路径段，不得跨 `/`
  //   `**` 可跨任意层级
  // npm（11.6.2 实测）就是这个语义：files=['lib/*.js'] 只收 `lib/top.js`，
  // 不收 `lib/a/top.js`；files=['lib/*/index.js'] 不收 `lib/a/b/index.js`。
  if (!entry.includes('*')) return false;
  return globMatch(filePath, entry);
}

/**
 * 按 npm/packlist 的语义做通配匹配：`*` 单段、`**` 跨段。
 *
 * 用「段数组 + 动态规划」实现，避免正则转义带来的隐蔽错误。
 * 每个模式段要么是：
 *   - `**`  → 吃掉 0..n 个路径段（含 0，即可以匹配「目录自身」）
 *   - 含 `*` 的字面段 → 在该段内做单星匹配（`*` 只吃段内字符，不吃 `/`）
 *   - 纯字面段 → 精确比较
 *
 * @param {string} filePath 相对包根路径（正斜杠）
 * @param {string} pattern  files 条目（正斜杠）
 * @returns {boolean}
 */
function globMatch(filePath, pattern) {
  const F = filePath.split('/');
  const P = pattern.replace(/^\.\//, '').split('/');
  // dp[j] = 「前 i 个文件段」能否被「前 j 个模式段」匹配
  const memo = new Map();
  const go = (i, j) => {
    const key = `${i},${j}`;
    if (memo.has(key)) return memo.get(key);
    let ok;
    if (j === P.length) {
      ok = i === F.length;
    } else if (P[j] === '**') {
      // 吃掉 0 段，或吃掉 1 段后继续用 `**`
      ok = go(i, j + 1) || (i < F.length && go(i + 1, j));
    } else if (i === F.length) {
      ok = false;
    } else if (P[j].includes('*')) {
      // 段内单星：把该段编译成只在本段内生效的正则（`*` → `[^/]*`）
      const re = new RegExp('^' + P[j].split('*').map(escapeRe).join('[^/]*') + '$');
      ok = re.test(F[i]) && go(i + 1, j + 1);
    } else {
      ok = P[j] === F[i] && go(i + 1, j + 1);
    }
    memo.set(key, ok);
    return ok;
  };
  return go(0, 0);
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 把补丁实际写过的路径补进 `pkg.files`（原地修改）。
 *
 * - 无 `files` 字段 → npm 会收全部内容，无需补，直接返回空数组。
 * - 已被某条覆盖 → 跳过，避免重复。
 * - 否则 push **精确路径**（不用 glob，失败模式更可预测）。
 *
 * @param {{files?: string[]}} pkg  staging 里的 package.json 对象
 * @param {Array<{path: string}>} appliedSourcePatches  applySourcePatches 的返回值
 * @returns {string[]} 实际新增的条目
 */
export function ensurePatchedFiles(pkg, appliedSourcePatches) {
  if (!Array.isArray(pkg.files)) return [];
  const added = [];
  for (const applied of appliedSourcePatches ?? []) {
    const patchedPath = applied?.path;
    if (!patchedPath) continue;
    if (pkg.files.some((entry) => isCoveredByFilesEntry(patchedPath, entry))) continue;
    pkg.files.push(patchedPath);
    added.push(patchedPath);
  }
  return added;
}

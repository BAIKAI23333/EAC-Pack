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
  // 目录形式（"lib/" 或 "lib"）覆盖其下全部内容。
  const dir = entry.replace(/\/+$/, '');
  if (dir && filePath.startsWith(`${dir}/`)) return true;
  // glob：**必须校验后缀**，不能只看前缀。
  //
  // 曾经只判前缀（`filePath.startsWith(entry.slice(0, star))`），于是
  //   entry = 'lib/types/**/*.d.ts'
  //   filePath = 'lib/types/foo.js'
  // 被判为「已覆盖」—— 但 npm 的 glob 不会匹配 .js，文件会被**静默丢弃**。
  // 这正是本模块要防的失败模式，却在自己的判据里复现了一次。
  //
  // 现在：把 glob 拆成「首个 `*` 之前的前缀」+「最后一个 `*` 之后的后缀」，
  // 两者都必须成立；后缀里的通配只允许 `*.ext` 这种单星形态。
  const star = entry.indexOf('*');
  if (star <= 0) return false;
  const prefix = entry.slice(0, star);
  if (!filePath.startsWith(prefix)) return false;
  // 取最后一个 `*` 之后的部分作为后缀要求（如 '/**/*.d.ts' -> '.d.ts'）。
  const lastStar = entry.lastIndexOf('*');
  const suffix = entry.slice(lastStar + 1);
  if (!suffix) return true; // 形如 'lib/**' —— 前缀之后全都算覆盖
  // 后缀必须是纯字面（不含通配），否则无法保守判定，按"未覆盖"处理。
  if (suffix.includes('*')) return false;
  return filePath.endsWith(suffix);
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

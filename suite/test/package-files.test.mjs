/**
 * `files` 白名单补齐的回归测试（scripts/repack/package-files.mjs）。
 *
 * 为什么这个测试重要
 * ------------------
 * npm pack 会按 `package.json` 的 `files` 白名单过滤产物。补丁新建的文件
 * （例如 `lib/settings-compat.js`）如果没被补进白名单，`npm pack` 会**静默
 * 丢弃**它 —— repack 全绿、tgz 里却没有该文件，直到插件在运行期 import
 * 失败才暴露。这类缺陷没法靠"跑一遍打包看有没有报错"发现，必须专门断言。
 *
 * 用例覆盖三种判断：精确路径、目录前缀、glob 前缀；以及最容易出错的两个
 * 反例 —— 标题相同但不在同一目录的路径、以及没有 files 字段的包。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isCoveredByFilesEntry, ensurePatchedFiles } from '../../scripts/repack/package-files.mjs';

test('精确路径只匹配自身', () => {
  assert.equal(isCoveredByFilesEntry('lib/index.js', 'lib/index.js'), true);
  assert.equal(isCoveredByFilesEntry('lib/client.js', 'lib/index.js'), false);
  // 前缀相同但不是同一文件 —— 不能被误判为覆盖
  assert.equal(isCoveredByFilesEntry('lib/index.js.map', 'lib/index.js'), false);
});

test('目录条目（带或不带斜杠）覆盖其下全部内容', () => {
  for (const entry of ['lib/', 'lib']) {
    assert.equal(isCoveredByFilesEntry('lib/settings-compat.js', entry), true);
    assert.equal(isCoveredByFilesEntry('lib/deep/nested.js', entry), true);
  }
  // 不在该目录下的同名文件不算覆盖
  assert.equal(isCoveredByFilesEntry('src/settings-compat.js', 'lib/'), false);
  // 兄弟目录不能被前缀误吞（'library/...' 不是 'lib/' 的内容）
  assert.equal(isCoveredByFilesEntry('library/x.js', 'lib/'), false);
});

test('glob 条目按「前缀 + 后缀」覆盖，不能只看前缀', () => {
  assert.equal(isCoveredByFilesEntry('lib/types/index.d.ts', 'lib/types/**/*.d.ts'), true);
  assert.equal(isCoveredByFilesEntry('lib/types/client/api.d.ts', 'lib/types/**/*.d.ts'), true);
  // 同目录但不在 glob 子树下
  assert.equal(isCoveredByFilesEntry('lib/settings-compat.js', 'lib/types/**/*.d.ts'), false);

  // 回归：**同目录、但后缀不符** —— 曾经被判为已覆盖，导致文件被 npm 静默丢弃。
  // 这正是本模块要防的失败模式（create 模式补丁漏文件），却在判据里复现过一次。
  assert.equal(
    isCoveredByFilesEntry('lib/types/helper.js', 'lib/types/**/*.d.ts'),
    false,
    'lib/types/**/*.d.ts 不应覆盖 .js —— 否则该文件不会补进白名单，npm pack 静默丢弃',
  );
  assert.equal(isCoveredByFilesEntry('lib/types/helper.mjs', 'lib/types/**/*.d.ts'), false);
  assert.equal(isCoveredByFilesEntry('lib/types/helper.d.ts', 'lib/types/**/*.d.ts'), true);

  // 尾缀纯通配（'lib/**'）时，前缀之后全都覆盖
  assert.equal(isCoveredByFilesEntry('lib/deep/nested/x.js', 'lib/**'), true);
  assert.equal(isCoveredByFilesEntry('other/x.js', 'lib/**'), false);

  // 目的目录不应误覆盖同名前缀的兄弟目录
  assert.equal(isCoveredByFilesEntry('library/x.js', 'lib/**'), false);
});

test('无 files 字段时不动 pkg（npm 会收全部内容）', () => {
  const pkg = { name: 'x' };
  const added = ensurePatchedFiles(pkg, [{ path: 'lib/new.js' }]);
  assert.deepEqual(added, []);
  assert.equal('files' in pkg, false);
});

test('未覆盖的补丁文件被补进白名单，且只补一次', () => {
  // 模拟 dsh-better-sidebar 的真实 files 形态：逐条列 lib/*.js，不含新建的 compat
  const pkg = {
    files: ['lib/index.js', 'lib/invariant.js', 'lib/client.js', 'cordis.patch.yml', 'LICENSE'],
  };
  const added = ensurePatchedFiles(pkg, [
    { path: 'lib/settings-compat.js' },
    { path: 'lib/index.js' }, // 已被精确条目覆盖 → 不重复添加
  ]);
  assert.deepEqual(added, ['lib/settings-compat.js']);
  assert.equal(pkg.files.filter((f) => f === 'lib/settings-compat.js').length, 1);
  assert.equal(pkg.files.filter((f) => f === 'lib/index.js').length, 1);
});

test('已覆盖的补丁文件不会被重复添加', () => {
  const dirPkg = { files: ['lib/'] };
  assert.deepEqual(ensurePatchedFiles(dirPkg, [{ path: 'lib/settings-compat.js' }]), []);
  const globPkg = { files: ['lib/types/**/*.d.ts'] };
  assert.deepEqual(ensurePatchedFiles(globPkg, [{ path: 'lib/types/x.d.ts' }]), []);
});

test('多个补丁文件按顺序补齐', () => {
  const pkg = { files: ['LICENSE'] };
  const added = ensurePatchedFiles(pkg, [
    { path: 'lib/a.js' },
    { path: 'lib/b.js' },
    { path: 'lib/a.js' }, // 重复输入 → 第二次应命中已 push 的条目
  ]);
  assert.deepEqual(added, ['lib/a.js', 'lib/b.js']);
});

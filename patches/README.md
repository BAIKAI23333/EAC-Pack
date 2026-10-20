# patches/ — tracked source patches replayed by the repack pipeline

This directory is the **fact source** for local fixes we ship on top of upstream
plugin sources. It exists so a rebuild cannot silently drop them: without it the
fixes live only inside `dist/*.tgz`, which is gitignored, and the next
`repack.mjs` run would re-emit the unfixed upstream code.

## Layout

```
patches/
  source-patches.json                       manifest: base pin + per-file hashes
  files/<package>/<relative path>.diff      unified diff, `git apply -p1` compatible
  README.md
```

`source-patches.json` shape:

```jsonc
{
  "schemaVersion": 1,
  "applicator": "git-apply -p1 (core.autocrlf=false)",
  "base": { "eac": { "repo": "...", "tag": "v5.3.6", "subdir": "dsh-desktop/assets/plugins" } },
  "patches": [
    {
      "name": "@deepseek-ai/dsh-balance",   // must equal the catalog package name
      "version": "0.1.0",                   // must equal the catalog version
      "source": "eac-tag",
      "files": [
        {
          "path": "lib/client.js",          // relative to the extracted package root
          "diff": "files/@deepseek-ai_dsh-balance/lib/client.js.diff",
          "inputSha256":  "<hash of the unpatched file>",
          "outputSha256": "<hash after the patch>",
          "note": "why this fix exists (copied into dist/index.json repackNote)"
        }
      ]
    }
  ]
}
```

## How it runs

`scripts/repack/repack.mjs` calls `applySourcePatches()` immediately after a
package is materialized and before `npm pack`. For every entry listed for that
package, the replay is **fail-closed**:

1. the materialized file must hash to `inputSha256` — otherwise the build stops
   (upstream drifted; regenerate the patch or re-pin the base);
2. the tracked diff is applied with `git apply -p1` and `core.autocrlf=false`
   so bytes are not line-ending translated;
3. the result must hash to `outputSha256` — otherwise the build stops.

Packages without an entry are untouched. When a patch is applied,
`dist/index.json` records `locallyRepacked: true` plus `repackNote`, which
propagates into `suite/assets/bootstrap.json`.

For packages with several patched files, set an optional package-level
`summary` on the patch entry. `repackNote` then uses that one string instead of
concatenating every per-file `note`. Keep the long explanations in the per-file
`note` fields (they are the maintainer-facing record); a manifest is read by the
installer and should not carry a thousand characters of rationale.

### `.gitattributes` pins diff line endings — do not remove

`.gitattributes` carries exactly one rule beyond the baseline comment:

```
patches/**/*.diff -text
```

It looks cosmetic and is not. The diffs are **data**, not source: `git apply -p1`
matches their context lines byte-for-byte against the materialized upstream
files, which are LF. With `core.autocrlf=true` (the Windows default) a normal
text checkout rewrites every diff to CRLF, and the replay then fails with:

```
error: patch failed: lib/client.js:121
error: lib/client.js: patch does not apply
```

Measured on a clean `main` worktree without the rule: the three tracked diffs
came out with 304 / 23 / 109 CR bytes and `git apply` rejected them outright.
With the rule they are byte-identical to their blobs.

Keep the file to that one rule line. Several branches independently added this
rule with different wording, which turns a trivial change into a merge conflict;
the explanation belongs here, not in every branch's copy of the file.

### The `eac-tag` base pin

`repack.mjs` reads `source: "eac-tag"` packages from
`.cache/eac-src/dsh-desktop/assets/plugins`, which nothing else creates. Populate it with:

```bash
# offline (recommended, uses a local clone that has the tag)
EAC_SRC_LOCAL=/path/to/DSH-Desktop-EAC node scripts/repack/fetch-eac-src.mjs --force
# or over the network
node scripts/repack/fetch-eac-src.mjs --force
```

`fetch-eac-src.mjs` uses a temporary Git index (`read-tree --prefix` and
`checkout-index`, with `core.autocrlf=false`; no CRLF translation) and then
prints whether each pinned file still matches the `inputSha256` the patches expect.

This pin matters: the EAC main repository **deliberately deleted**
`dsh-desktop/assets/plugins` at HEAD (ADR 0006 v4, commit `6687b40`
"剥离文件连同源码删除"), so these sources now exist only at the recorded tag.
Do not re-add them to the main repository — that contradicts that decision; the
fixes belong to the distribution layer, i.e. here.

## Current patches

| Package | Source | File | Fix |
| --- | --- | --- | --- |
| `dsh-settings-groups@0.1.0` | `eac-tag` | `lib/client.js` | General-settings collapser: real rows are the slot wrapper's children, not the wrapper itself (previously the whole page was hidden as a single "advanced" row). |
| `@deepseek-ai/dsh-balance@0.1.0` | `eac-tag` | `lib/client.js` | Drops the 价格设置 settings section. Its `balancePrices` / `balanceModels` / `refreshBalance` bridge is retired by ADR 0006 (`docs/adr/0006-minimal-core-scope.md:373-376`, locked by `bridge-preload-parity.test.ts`), so the section could only ever render a misleading "bridge unavailable" error. The composer dock is unchanged. |
| `dsh-plugin-wallpaper-engine@0.6.7` | `npm` | `lib/client.js` | Update-notice button contrast. `.we-picker__btn` inherits light-theme tokens that render near-black on the dark glass notice card (outline 1.10:1, label 1.06:1). Pin light values → outline 3.11:1, label 4.95:1 (WCAG 4.5 text / 3.0 non-text). |
| `computer-user@0.3.7` | `npm` | `src/index.js` | Re-export the settings schema. DSH 0.1.7-rc.2 derives settings forms from the entry's exported `Config` (`SettingsForms.schema(entry)` reads `entry.fiber.runtime.Config`), but upstream keeps `Config` module-private. Without the export the namespace never appears in `describe()`, so the browser `configForms.get()` answers `unavailable` and the card is blank. |
| `computer-user@0.3.7` | `npm` | `src/config.js` | Mark every `Config` field `volatile()`. `volatileForm()` keeps only fields under a volatile ancestor, so the unmarked upstream schema still projects to `undefined` — no form even once `Config` is exported. |
| `computer-user@0.3.7` | `npm` | `client.js` | Drop the retired `settingsScope` inject and probe both transport generations. Declaring a service no kernel provides parks the client fiber in `waitingFor` forever, so the whole card vanishes with no error. Now: `configForms.get(entryId)` on 0.2.x, `settingsScope.bind()` on 0.1.x, and no section at all when neither exists. Upstream 0.3.7's `client.js` is byte-identical to 0.3.6 — the browser half was never adapted. |

### Why `computer-user` needs three patches

They are independent defects, and fixing any one alone still leaves the plugin
dead. 0.3.7 fixed the *host* import (`settingsNamespace` moved to an inlined
`src/settings-compat.js` shim) but not the schema export or the client half.

## Kernel export gate

`scripts/repack/kernel-compat.mjs` verifies that the **shipped artifacts** never
import a named export the kernel no longer provides. This is a different check
from the Desktop repository's `scripts/plugin-kernel-compat.mjs`:

| | Desktop gate | Pack gate (this one) |
| --- | --- | --- |
| Scans | `dsh-desktop/assets/plugins` (11 EAC-owned plugins) | `dist/*.tgz` (all 72 shipped packages) |
| Judges | built-in plugin **source** | what users actually **receive** |

The gap was real: `computer-user`, `picturereader`, `dsh-conversation-tweaks`,
`dsh-openclaw-bridge` and `dsh-prompt-custom` all shipped with imports of
removed kernel exports while the Desktop gate stayed green, because none of them
live in `assets/plugins`.

```bash
node scripts/repack/kernel-compat.mjs                 # exit 1 on any hit
node scripts/repack/kernel-compat.mjs --json           # machine-readable
node scripts/repack/kernel-compat.mjs --kernel <dir>   # override kernel root
node scripts/repack/kernel-compat.mjs --allowlist      # print known waivers
```

The kernel root defaults to a sibling `../EAC-Desktop/dsh-desktop/node_modules/@deepseek-ai`,
then `$DSH_KERNEL_ROOT`. Missing kernel = exit 2 (environment), never a silent pass.
`verify.mjs` runs this gate as step (f); it degrades to a warning when the kernel
is absent, since Pack CI and Desktop need not be installed together.

`DEFAULT_ALLOWLIST` in that module is deliberately empty. Adding an entry requires
that the plugin is disabled by default *and* a written reason plus a tracking note —
otherwise the gate turns red, which is the point.

Regenerate nothing here; the gate reads `dist/` only. Rebuild first:

```bash
node scripts/repack/repack.mjs && node scripts/repack/kernel-compat.mjs
```

Its own correctness is pinned by `suite/test/kernel-compat.test.mjs` (fixture
tgz + fake kernel), which asserts both directions: a missing export fails the
build, and a present export does not. That suite is what caught a real bug in the
gate itself — the `client/**` excluder originally missed `*.client.js` spellings,
so front-end bundles could be misreported as server-side imports.

## Replaying a clean build

Two environment quirks bite on a fresh clone and are **not** patch problems:

1. **`core.autocrlf=true`** rewrites `patches/**/*.diff` to CRLF on checkout, so
   `git apply` can never match the LF context lines. `.gitattributes` pins
   `patches/**/*.diff -text` to prevent it — do not remove that rule.
2. **`dist/` is gitignored and shared across branches.** Switching branches
   leaves another branch's tarballs in place, so `dist/index.json` and the files
   on disk disagree. Always rebuild before trusting `verify.mjs` or the gate.


## Adding or regenerating a patch

1. Edit the extracted package source until it behaves correctly.
2. Produce the patch from the **unpatched** and **patched** file so
   `inputSha256`/`outputSha256` are both recorded:

   ```bash
   git diff --no-index --src-prefix=a/ --dst-prefix=b/ unpatched/lib/client.js patched/lib/client.js
   ```

   Then rewrite the two header paths to `a/lib/client.js` / `b/lib/client.js`
   (they must be relative to the extracted package root so `-p1` works).
3. Add the entry to `source-patches.json` with both hashes and a `note`.
4. Prove the round trip: unpatched + diff must equal patched. A rebuild is the
   real test — `repack.mjs` fails loudly if the hashes do not line up.

Keep patches minimal and surgical. Do not use this mechanism to fork a package's
behaviour wholesale; if a package needs a real fork, publish it as its own
package instead.

## Provenance and licensing

Upstream origins are recorded per package in `catalog/*.json` (`upstream` field)
and remain the property of their authors; these diffs are our local fixes to
byte-identical upstream sources and carry the same license as the package they
patch (`MIT` for all three above, and `SEE LICENSE IN ASSET_LICENSE.md` where the
package declares assets — not applicable to the files patched here).

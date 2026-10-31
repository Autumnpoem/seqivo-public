# Third-party notices / 第三方许可说明

Seqivo-owned code uses the PolyForm Noncommercial 1.0.0 terms in the repository's root `LICENSE`. Those terms apply only to code the Seqivo licensors own. Components listed below retain their own licenses and may grant rights, including commercial-use rights, that the Seqivo license does not restrict. The English license texts are controlling; this Chinese introduction is a guide.

序程自有代码采用仓库根目录 `LICENSE` 中的 PolyForm Noncommercial 1.0.0 条款。该条款只适用于序程许可人拥有的代码。下列第三方组件保留各自许可，序程的非商业限制不限制这些组件原许可授予的权利。以下中文说明仅作索引，以各英文许可原文为准。

## Bundled runtime / 随应用附带的运行时

The macOS app stores these files under `序程.app/Contents/Resources/resources/`:

| Component / 组件 | License and notice location / 许可原文位置 |
|---|---|
| Node.js 24.19.0 and its included components | `licenses/Node.js-LICENSE.txt` |
| CPython 3.12.15, its libraries, pip, and pip vendors | `preview-python/licenses/` and license files under `preview-python/python/lib/python3.12/site-packages/` |
| tmux 3.8 | `terminal/licenses/tmux-COPYING.txt` |
| libevent | `terminal/licenses/libevent-LICENSE.txt` |
| jemalloc | `terminal/licenses/libjemalloc.2.dylib-LICENSE.txt` |
| utf8proc | `terminal/licenses/libutf8proc.3.dylib-LICENSE.txt` |
| macOS Node modules: `node-pty`, `node-addon-api`, `ws`, `ssh2`, `asn1`, `bcrypt-pbkdf`, `safer-buffer`, `tweetnacl` | Each package's `node_modules/<package>/LICENSE*` file. `ssh2` has an MIT license file even though its package manifest has no `license` field; `tweetnacl` uses the Unlicense. |
| Patched Tao 0.35.3 | `licenses/Tao-LICENSE.txt`, `licenses/Tao-LICENSE.spdx`, and `licenses/Tao-Seqivo-modifications.md`; source and patch description: `src-tauri/vendor/tao-0.35.3/` and `src-tauri/vendor/README.md` (Apache-2.0). |
| Vendored Codex auto-continue plugin | `plugins/codex-autocontinue/vendor/LICENSE` and `plugins/codex-autocontinue/PROVENANCE.md` (MIT). The corrected license retains the Autumnpoem and codex-charge contributors copyright notices; provenance records the upstream holder's authorization of the public pseudonym. The MIT grant and conditions remain unchanged. |

The app bundles the eight Node packages listed above. The Python environment also includes license files for its vendored pip packages; the directory index above is part of the distributed application.

## Frontend and preview tools / 前端及预览工具

The shipped frontend is built from `react` 19.3.0, `react-dom` 19.3.0, `scheduler` 0.28.0 (MIT), `lucide-react` 1.48.0 (ISC), `@xterm/xterm` 6.0.0, and `@xterm/addon-fit` 0.11.0 (MIT). Their exact installed license files are collected in [frontend-license-texts.txt](docs/licenses/frontend-license-texts.txt). The bundled `preview-toolchain/node_modules/` contains 15 packages; 14 carry a license file in the bundle and those originals are collected in the same file. `@rolldown/binding-darwin-arm64` 1.2.10 declares MIT in `package.json` but has no separate license file; the bundled parent `rolldown` 1.2.10 package carries its MIT `LICENSE`. `lightningcss` and `lightningcss-darwin-arm64` 1.33.0 declare MPL-2.0; their exact-version source is available at https://www.npmjs.com/package/lightningcss/v/1.33.0 and https://www.npmjs.com/package/lightningcss-darwin-arm64/v/1.33.0. Their bundled `LICENSE` files and the MPL text below preserve recipients' MPL rights.

## macOS Rust dependencies / macOS Rust 依赖

[The Mac target dependency index](docs/licenses/mac-rust-dependencies.csv) records the exact versions, declared license expressions, and source links for 242 external normal Rust dependencies resolved for `aarch64-apple-darwin`. [Collected package LICENSE, LICENCE, NOTICE, and COPYING files](docs/licenses/mac-rust-license-texts.txt) preserve 403 available files from 224 package archives. The other 18 package archives lack standalone license files. Their exact-version metadata and source headers were checked: [missing-file attribution findings](docs/licenses/mac-rust-missing-attribution.md) and [license texts from their pinned upstream commits](docs/licenses/mac-rust-upstream-license-texts.txt) record the results. This inventory is scoped to the macOS normal-dependency graph; build-only and other-platform dependencies are outside it.

Five resolved crates declare MPL-2.0. Their exact source archives are available here, and the [MPL 2.0 license text](docs/licenses/MPL-2.0.txt) is included in this repository:

| Crate | Exact source |
|---|---|
| `cssparser` 0.36.0 | https://crates.io/crates/cssparser/0.36.0 |
| `cssparser-macros` 0.6.1 | https://crates.io/crates/cssparser-macros/0.6.1 |
| `dtoa-short` 0.3.5 | https://crates.io/crates/dtoa-short/0.3.5 |
| `option-ext` 0.2.0 | https://crates.io/crates/option-ext/0.2.0 |
| `selectors` 0.36.1 | https://crates.io/crates/selectors/0.36.1 |

Recipients may use these MPL-covered portions under MPL-2.0, including their source-code rights. The Seqivo noncommercial terms do not narrow those rights. The source repository for Seqivo's own code and Tao patch is `https://github.com/Autumnpoem/seqivo-public`; the older `seqivo` repository is not the public source location.

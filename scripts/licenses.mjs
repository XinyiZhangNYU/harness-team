#!/usr/bin/env node
// Builds a third-party license record from package-lock.json and the packages that are
// actually installed in node_modules. Prints Markdown; with --write it saves
// docs/THIRD_PARTY_LICENSES.md. It reads local files only and makes no network calls.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));

// Licenses that need a human look before anything is redistributed.
const PERMISSIVE = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'BlueOak-1.0.0', 'CC0-1.0']);

const rows = [];
for (const [path, entry] of Object.entries(lock.packages ?? {})) {
  if (!path) continue;
  const name = entry.name ?? path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
  const installed = existsSync(join(root, path, 'package.json'));
  let license = entry.license;
  if (installed) {
    const meta = JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8'));
    license = typeof meta.license === 'string' ? meta.license : (meta.license?.type ?? license);
  }
  rows.push({
    name,
    version: entry.version ?? '?',
    license: license ?? 'UNKNOWN',
    scope: entry.dev ? 'dev' : 'runtime',
    installed,
    direct: Boolean(pkg.dependencies?.[name] || pkg.devDependencies?.[name]) && path === `node_modules/${name}`,
  });
}
rows.sort((a, b) => a.name.localeCompare(b.name));

const lines = [];
const out = (s = '') => lines.push(s);
const table = (list) => {
  out('| 包 | 版本 | 许可证 | 范围 |');
  out('|---|---|---|---|');
  for (const r of list) out(`| ${r.name} | ${r.version} | ${r.license} | ${r.scope === 'dev' ? '开发' : '运行时'} |`);
};

out('# 第三方依赖许可证记录');
out();
out('由 `npm run licenses -- --write` 根据 `package-lock.json` 与本机 `node_modules` 中各包的 `package.json` 生成；');
out('许可证取自包元数据声明，未逐一审阅各包附带的 LICENSE 全文。');
out();
out('## 直接依赖');
out();
table(rows.filter((r) => r.direct));
out();

const installed = rows.filter((r) => r.installed);
const counts = (list) => {
  const by = new Map();
  for (const r of list) by.set(r.license, (by.get(r.license) ?? 0) + 1);
  return [...by].sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ×${n}`).join('，');
};
out('## 已安装包汇总（含传递依赖）');
out();
out(`- 运行时：${installed.filter((r) => r.scope === 'runtime').length} 个 —— ${counts(installed.filter((r) => r.scope === 'runtime'))}`);
out(`- 开发：${installed.filter((r) => r.scope === 'dev').length} 个 —— ${counts(installed.filter((r) => r.scope === 'dev'))}`);
const skipped = rows.filter((r) => !r.installed);
out(`- 锁文件中另有 ${skipped.length} 个未安装的可选平台包（其他操作系统/CPU 的原生二进制），未计入。`);
out();

const review = installed.filter((r) => !PERMISSIVE.has(r.license));
out('## 需要关注的许可证');
out();
if (review.length === 0) {
  out('无：已安装包全部为宽松许可证（MIT / ISC / Apache-2.0 / BSD 等）。');
} else {
  table(review);
  if (review.every((r) => r.scope === 'dev')) {
    out();
    out('以上均为开发期构建工具（例如 Vite 的 CSS 处理），只在构建时运行，其代码不进入 `web/dist` 产物或服务端运行时。');
    out('MPL-2.0 为文件级弱 copyleft：若将来修改并分发这些包本身，需要公开被修改的文件。');
  }
}
out();
out('## 未纳入的组件');
out();
out('- Node.js 内置 `node:sqlite`（SQLite 为公有领域）随 Node 运行时提供，不是 npm 依赖。');
out('- **Windows 桌面安装包（可选）**：`electron`、`electron-builder` 在上表中记为开发依赖，但安装包会**分发 Electron 运行时**（MIT，安装目录 `LICENSE.electron.txt`），其中包含 Chromium、Node.js、V8 等组件，各自许可证汇总于安装目录 `LICENSES.chromium.html`（Electron 随附生成）；其中 `ffmpeg.dll` 为 FFmpeg（LGPL-2.1-or-later，动态链接，可替换）。安装包内的 npm 运行时依赖只有 `ws`、`zod`；前端以构建后的 `web/dist` 形式分发（React 等，MIT）。见根目录 `NOTICE`。');
out('- Codex CLI（`codex app-server`）与 Claude Code CLI（`claude`）均为用户本机自行安装的外部程序，本项目只以子进程调用，不作为 npm 依赖、不随本项目分发或打包、不修改。Claude Code 为 Anthropic 专有软件（受 Anthropic 条款约束）；Claude Agent SDK（专有许可）未引入。');
out();
out('## 全部已安装包');
out();
table(installed);

const md = lines.join('\n') + '\n';
if (process.argv.includes('--write')) {
  writeFileSync(join(root, 'docs', 'THIRD_PARTY_LICENSES.md'), md);
  console.log(`wrote docs/THIRD_PARTY_LICENSES.md (${installed.length} installed packages, ${review.length} to review)`);
} else {
  process.stdout.write(md);
}

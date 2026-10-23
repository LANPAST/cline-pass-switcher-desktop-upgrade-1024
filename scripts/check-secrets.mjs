// 提交前密钥扫描：在仓库内发现疑似 API Key / 私钥就失败。
// 只扫源码与文档（跳过 node_modules / dist / .git），不依赖 git 是否已初始化。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'dist-new', 'release', '.git']);
const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.json', '.md', '.txt', '.yml', '.yaml',
  '.sh', '.bat', '.ps1', '.html', '.css', '.env', '.ini', '.toml',
]);
const PATTERNS = [
  { name: 'Cline / generic sk_ key', re: /sk_[A-Za-z0-9]{16,}/g },
  { name: 'OpenAI-style sk- key', re: /sk-[A-Za-z0-9_-]{20,}/g },
  { name: 'private key block', re: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g },
];
// 测试里用的假 key（sk_test 等）太短，不会被上面的长度规则命中。
// 以后若要放更长的假 key，把相对路径加到这里，并写清原因。
const ALLOW = [];
const mask = (s) => (s.length <= 10 ? s : s.slice(0, 6) + '…' + s.slice(-4));
const hits = [];

function walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
      continue;
    }
    if (!e.isFile()) continue;
    const full = path.join(dir, e.name);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (ALLOW.includes(rel)) continue;
    const ext = path.extname(e.name).toLowerCase();
    if (!TEXT_EXT.has(ext) && !['.gitignore', '.gitattributes'].includes(e.name)) continue;
    let text;
    try {
      if (fs.statSync(full).size > 2 * 1024 * 1024) continue;
      text = fs.readFileSync(full, 'utf8');
    } catch { continue; }
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      for (const m of text.matchAll(p.re)) hits.push({ rel, name: p.name, sample: mask(m[0]) });
    }
  }
}

walk(ROOT);
if (hits.length) {
  console.error('✗ 发现疑似密钥，不要提交：');
  for (const h of hits) console.error(`  ${h.rel}  ${h.name}  ${h.sample}`);
  console.error('\n如果这是测试用的假密钥，请改成明显无效的短值，或在 scripts/check-secrets.mjs 的 ALLOW 里注明原因。');
  process.exit(1);
}
console.log('✓ 未发现疑似 API Key / 私钥');
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, '..');
const srcPath = path.join(pkgRoot, 'src', 'client', 'index.js');
const distPath = path.join(pkgRoot, 'dist', 'client.js');

const code = fs.readFileSync(srcPath, 'utf8');
new vm.Script(code, { filename: 'dist/client.js' });

if (!code.includes('window.__ModuleLoader__.load') || !code.includes('"dsh-plugin-visual-browser"')) {
  throw new Error('src/client/index.js is missing required window.__ModuleLoader__.load module registration');
}

fs.mkdirSync(path.dirname(distPath), { recursive: true });
fs.writeFileSync(distPath, code, 'utf8');
console.log(`[build-client] Built and syntax-verified ${path.relative(pkgRoot, distPath)} (${Buffer.byteLength(code)} bytes)`);

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.join(__dirname, '..');
let checked = 0;
function check(source, file) {
  const result = spawnSync(process.execPath, ['--check'], { input: source, encoding: 'utf8' });
  if (result.status) throw new Error(`${file}: ${result.stderr}`);
  checked++;
}
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '.git'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (file.endsWith('.js')) check(fs.readFileSync(file, 'utf8'), file);
    else if (file.endsWith('.html')) {
      for (const match of fs.readFileSync(file, 'utf8').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
        if (!/\bsrc\s*=|application\//i.test(match[1]) && match[2].trim()) check(match[2], file);
      }
    }
  }
}
walk(root);
console.log(`${checked} arquivos/blocos JavaScript verificados`);

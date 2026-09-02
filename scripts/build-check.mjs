import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';

const files = [
  'server.mjs',
  'public/tracker.js',
  'public/admin.js',
];

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `${file} falhou na checagem de sintaxe.`);
  }
}

for (const file of ['public/index.html', 'public/admin.html', 'public/styles.css']) {
  const content = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  if (!content.trim()) throw new Error(`${file} esta vazio.`);
}

console.log('Build check concluido.');

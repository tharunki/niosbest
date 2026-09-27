import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = resolve(fileURLToPath(new URL('..', import.meta.url)));
const output = resolve(here, '..');
const [deskAssistant, studentApp, appCss] = await Promise.all([
  readFile(resolve(output, 'student-assistant.js'), 'utf8'),
  readFile(resolve(output, 'student-app.js'), 'utf8'),
  readFile(resolve(output, 'student-app.css'), 'utf8')
]);

for (const script of [deskAssistant, studentApp]) {
  assert.match(script, /\/api\/counselor/);
  assert.match(script, /containsSensitive(?:Assistant)?Value/);
  assert.match(script, /Private information was not sent/);
  assert.match(script, /A private detail was removed and was not sent/);
  assert.match(script, /safeOfficialSource/);
  assert.match(script, /nios\.ac\.in/);
  assert.match(script, /sdmis\.nios\.ac\.in/);
  assert.doesNotMatch(script, /endsWith\('\.nios\.ac\.in'\)/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /\.innerHTML\s*\+=/);
}
assert.match(appCss, /\.assistant-sources/);

console.log('Mira client checks passed: private-value preflight, allowlisted official sources, safe rendering, and mobile source styling.');

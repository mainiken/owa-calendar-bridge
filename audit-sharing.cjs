const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const RELEASE_FILES = [
  'owa-google-sync.user.js', 'GoogleCalendarBridge.gs', 'INSTALL.html',
  'README.md', 'SECURITY.md', 'LICENSE', 'CHANGELOG.md', 'docs/SHARING.md'
];
const REPOSITORY_FILES = [...RELEASE_FILES,
  '.gitignore', '.gitattributes', '.github/workflows/checks.yml',
  'package.json', 'package-lock.json', 'build-install.cjs',
  'tests.cjs', 'ui-tests.cjs', 'audit-sharing.cjs'
];

// Patterns identify accidental personal connections, never print matched values.
const PATTERNS = [
  ['personal Google deployment URL', /https?:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{40,}\/(?:exec|dev)/i],
  ['connection link containing a literal key', /\/(?:exec|dev)#[a-f0-9]{32,}/i],
  ['published calendar bearer URL', /\/owa\/calendar\/[^\s"'<>]+\/[a-f0-9]{24,}\/calendar\.(?:ics|html)/i],
  ['private key material', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['personal Windows home path', /[A-Z]:[\\/](?:Users|Documents and Settings)[\\/]/i],
  ['literal connection or authorization secret', /\b(?:BRIDGE_TOKEN|token|canary|authorization)\s*[:=]\s*["'][A-Za-z0-9+/_=-]{24,}["']/i]
];

function scanText(name, text) {
  const findings = [];
  for (const [label, pattern] of PATTERNS) {
    const match = pattern.exec(text);
    if (match) findings.push({ file: name, line: text.slice(0, match.index).split('\n').length, reason: label });
  }
  if (name.endsWith('INSTALL.html')) {
    const embedded = [...text.matchAll(/(?:userscript|receiver):'([A-Za-z0-9+/=]+)'/g)];
    if (embedded.length !== 2) findings.push({ file: name, line: 1, reason: 'missing expected embedded scripts' });
    for (const [index, match] of embedded.entries()) {
      findings.push(...scanText(`${name}:embedded-${index + 1}`, Buffer.from(match[1], 'base64').toString('utf8')));
    }
  }
  return findings;
}

function audit(directory = __dirname) {
  const findings = [];
  const allowed = new Set(REPOSITORY_FILES);
  for (const name of REPOSITORY_FILES) {
    const fullPath = path.join(directory, name);
    if (!fs.existsSync(fullPath)) { findings.push({ file: name, line: 1, reason: 'required file missing' }); continue; }
    findings.push(...scanText(name, fs.readFileSync(fullPath, 'utf8')));
  }
  if (fs.existsSync(path.join(directory, '.git'))) {
    const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: directory, encoding: 'utf8' }).split('\0').filter(Boolean);
    for (const name of tracked) {
      if (!allowed.has(name)) findings.push({ file: name, line: 1, reason: 'tracked file outside the reviewed allowlist' });
    }
  }
  return findings;
}

module.exports = { RELEASE_FILES, REPOSITORY_FILES, scanText, audit };
if (require.main === module) {
  const findings = audit();
  if (findings.length) {
    for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.reason}`);
    process.exitCode = 1;
  } else console.log(`Sharing audit passed: ${REPOSITORY_FILES.length} reviewed files and both embedded scripts.`);
}

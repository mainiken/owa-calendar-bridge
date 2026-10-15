const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/\r\n/g, '\n');
const encode = text => Buffer.from(text).toString('base64');
const template = read('installer.template.html');
const html = template
  .replace('{{USERSCRIPT_BASE64}}', encode(read('owa-google-sync.user.js')))
  .replace('{{RECEIVER_BASE64}}', encode(read('GoogleCalendarBridge.gs')));
if (/\{\{[A-Z_]+\}\}/.test(html)) throw new Error('Unresolved installer template placeholder');
fs.writeFileSync(path.join(__dirname, 'INSTALL.html'), html);
console.log('Built INSTALL.html with both scripts embedded.');
const version = JSON.parse(read('package.json')).version;
const asset = name => `${name}?build=${createHash('sha256').update(read(name)).digest('hex').slice(0, 16)}`;
const connect = read('connect.html')
  .replace(/src="connect\.js(?:\?[^"<>]*)?"/, `src="${asset('connect.js')}"`)
  .replace(/href="connect\.css(?:\?[^"<>]*)?"/, `href="${asset('connect.css')}"`)
  .replace(/(<span id="page-version">)[^<]*(<\/span>)/, (_, before, after) => before + version + after);
fs.writeFileSync(path.join(__dirname, 'connect.html'), connect);
const index = read('index.html').replace(/(url=|href=")INSTALL\.html(?:\?v=[\d.]+)?(?=")/g, (_, prefix) => `${prefix}INSTALL.html?v=${version}`);
fs.writeFileSync(path.join(__dirname, 'index.html'), index);
console.log('Versioned authorization assets and installer entry point.');

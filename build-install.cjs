const fs = require('node:fs');
const path = require('node:path');
const read = name => fs.readFileSync(path.join(__dirname, name), 'utf8').replace(/\r\n/g, '\n');
const encode = text => Buffer.from(text).toString('base64');
const template = read('installer.template.html');
const html = template
  .replace('{{USERSCRIPT_BASE64}}', encode(read('owa-google-sync.user.js')))
  .replace('{{RECEIVER_BASE64}}', encode(read('GoogleCalendarBridge.gs')));
if (/\{\{[A-Z_]+\}\}/.test(html)) throw new Error('Unresolved installer template placeholder');
fs.writeFileSync(path.join(__dirname, 'INSTALL.html'), html);
console.log('Built INSTALL.html with both scripts embedded.');

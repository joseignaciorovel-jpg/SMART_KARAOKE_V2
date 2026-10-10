const fs = require('node:fs');
const vm = require('node:vm');
for (const file of ['server.js', 'public/js/audio-engine.js', 'public/js/mobile.js', 'public/js/show-party.js', 'lib/party.js', 'lib/session-store.js']) {
    new vm.Script(fs.readFileSync(file, 'utf8'), { filename: file });
}
const html = fs.readFileSync('public/index.html', 'utf8');
for (const [, body] of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (body.trim()) new vm.Script(body, { filename: 'public/index.html' });
}
console.log('Server, mobile scripts and inline screen JavaScript parse successfully.');

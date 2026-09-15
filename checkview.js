const fs = require('fs');
const src = fs.readFileSync('/opt/data/mct2/views/user.handlebars', 'utf8');
const scripts = src.match(/<script[^>]*>([\s\S]*?)<\/script>/g);
if (!scripts) { console.log('NO SCRIPTS'); process.exit(0); }
scripts.forEach((s, i) => {
    const body = s.replace(/<script[^>]*>/, '').replace(/<\/script>/, '');
    if (body.includes('src=') && body.length < 100) return;
    try {
        new Function(body.replace('{{{scriptTree}}}', 'null'));
        console.log('script', i, 'OK');
    } catch (e) {
        console.log('script', i, 'SYNTAX ERROR:', e.message);
    }
});
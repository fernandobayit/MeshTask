// Unit tests for targeting.js — node test_targeting.js
"use strict";
let pass = 0, fail = 0;
function t(name, cond) { if (cond) { pass++; console.log('  ✓ ' + name); } else { fail++; console.log('  ✗ FALHOU: ' + name); } }
function section(s) { console.log('\n=== ' + s + ' ==='); }

const T = require('./targeting.js');

// fleet fixture
const FLEET = [
    { _id: 'n1', name: 'SRV-LIN-01', rname: 'srv-lin-01', osdesc: 'Debian GNU/Linux 13 (trixie)', meshid: 'm1', tags: ['prod', 'datacenter'], agent: { id: 6 }, ip: '10.0.1.5', desc: 'servidor de arquivos' },
    { _id: 'n2', name: 'SRV-WIN-01', osdesc: 'Microsoft Windows 11 Pro', meshid: 'm1', tags: ['prod'], agent: { id: 4, tag: 'financeiro' }, ip: '10.0.1.6', wsc: { antiVirus: 'OK', autoUpdate: 'OK', firewall: 'OK' } },
    { _id: 'n3', name: 'LAP-FIN-05', osdesc: 'Microsoft Windows 10', meshid: 'm2', tags: [], agent: { id: 4 }, usersc: ['jose.silva'], upnusers: ['jose.silva@corp.local'] },
    { _id: 'n4', name: 'LAP-FIN-06', osdesc: 'Ubuntu 24.04.2 LTS', meshid: 'm2', tags: ['homolog'], agent: { id: 6 }, usersc: ['maria' ] },
    { _id: 'n5', name: 'pfsense-edge', osdesc: 'FreeBSD 14.0-CURRENT', meshid: 'm3', agent: { id: 32 } },
];
const CTX = {
    meshes: { m1: { name: 'Gobah! - Servers' }, m2: { name: 'Gobah! - Notebooks' }, m3: { name: 'Gobah! - Rede' } },
    connectivity: { n1: 1, n2: 1, n5: 1 },  // n3/n4 offline
    stars: { n2: 1 }
};

section('parser');
t('termo simples', T.parse('linux').value == 'linux' && T.parse('linux').prefix == null);
t('os:linux', T.parse('os:linux').prefix == 'os:' && T.parse('os:linux').value == 'linux');
t('u: vira user:', T.parse('u:jose').prefix == 'user:');
t('g: vira group:', T.parse('g:servers').prefix == 'group:');
t('t: vira tag:', T.parse('t:prod').prefix == 'tag:');
t('a: vira atag:', T.parse('a:financeiro').prefix == 'atag:');
t('negação', T.parse('!t:prod').negate === true && T.parse('!t:prod').prefix == 'tag:');
t('and/precedência', T.parse('os:linux and g:servers').op == 'and');
t('or', T.parse('os:linux or g:notebooks').op == 'or');
t('or > and', T.parse('os:linux or os:windows and t:prod').op == 'or');
t('and interno no or', T.parse('os:linux or os:windows and t:prod').terms[1].op == 'and');
t('expressão vazia → null', T.parse('   ') == null);

section('match: nome e os');
t('nome contém SRV', JSON.stringify(T.matchNodes(FLEET, 'SRV', CTX)) == JSON.stringify(['n1', 'n2']));
t('case-insensitive', JSON.stringify(T.matchNodes(FLEET, 'srv', CTX)) == JSON.stringify(['n1', 'n2']));
t('os:linux casa Debian/Ubuntu', T.matchNodes(FLEET, 'os:linux', CTX).length == 2 && T.matchNodes(FLEET, 'os:linux', CTX).indexOf('n1') >= 0);
t('os:linux inclui Ubuntu do n4', T.matchNodes(FLEET, 'os:linux', CTX).indexOf('n4') >= 0);
t('os:windows', T.matchNodes(FLEET, 'os:windows', CTX).length == 2);
t('nome por mesh também (n1..n5 todos em Gobah!)', T.matchNodes(FLEET, 'gobah', CTX).length == 5);

section('match: grupos, tags, users, agent tag');
t('g:notebooks', JSON.stringify(T.matchNodes(FLEET, 'g:notebooks', CTX)) == JSON.stringify(['n3', 'n4']));
t('t:prod', JSON.stringify(T.matchNodes(FLEET, 't:prod', CTX)) == JSON.stringify(['n1', 'n2']));
t('t: (sem tag): n3 e n5', JSON.stringify(T.matchNodes(FLEET, 't:', CTX)) == JSON.stringify(['n3', 'n5']));
t('u:jose', JSON.stringify(T.matchNodes(FLEET, 'u:jose', CTX)) == JSON.stringify(['n3']));
t('u:maria', T.matchNodes(FLEET, 'u:maria', CTX).indexOf('n4') >= 0);
t('a:financeiro', T.matchNodes(FLEET, 'a:financeiro', CTX).length == 1 && T.matchNodes(FLEET, 'a:financeiro', CTX)[0] == 'n2');
t('desc:arquivos', T.matchNodes(FLEET, 'desc:arquivos', CTX).length == 1 && T.matchNodes(FLEET, 'desc:arquivos', CTX)[0] == 'n1');
t('ip:10.0.1.5', T.matchNodes(FLEET, 'ip:10.0.1.5', CTX)[0] == 'n1');

section('match: conectividade, wsc, estrela');
t('c:agent (online)', JSON.stringify(T.matchNodes(FLEET, 'c:agent', CTX)) == JSON.stringify(['n1', 'n2', 'n5']));
t('c:offline', JSON.stringify(T.matchNodes(FLEET, 'c:offline', CTX)) == JSON.stringify(['n3', 'n4']));
t('wsc:ok', T.matchNodes(FLEET, 'wsc:ok', CTX).length == 1 && T.matchNodes(FLEET, 'wsc:ok', CTX)[0] == 'n2');
t('estrela *', T.matchNodes(FLEET, '*', CTX).length == 1 && T.matchNodes(FLEET, '*', CTX)[0] == 'n2');

section('negação e combinadores');
t('!t:prod (exclui prod)', JSON.stringify(T.matchNodes(FLEET, '!t:prod', CTX)) == JSON.stringify(['n3', 'n4', 'n5']));
t('os:linux and !t:homolog', JSON.stringify(T.matchNodes(FLEET, 'os:linux and !t:homolog', CTX)) == JSON.stringify(['n1']));
t('os:linux or g:notebooks', T.matchNodes(FLEET, 'os:linux or g:notebooks', CTX).length == 3);
t('g:servers and os:windows', JSON.stringify(T.matchNodes(FLEET, 'g:servers and os:windows', CTX)) == JSON.stringify(['n2']));
t('composto: (todos linux online)', JSON.stringify(T.matchNodes(FLEET, 'os:linux and c:agent', CTX)) == JSON.stringify(['n1']));
t('3 termos and', JSON.stringify(T.matchNodes(FLEET, 'os:linux and c:agent and !t:homolog', CTX)) == JSON.stringify(['n1']));

section('validate/describe');
t('validate ok', T.validate('os:linux and !t:homolog').ok === true);
t('validate prefixo inválido', T.validate('xyz:foo').ok === false);
t('describe legível', T.describe('os:linux and !t:homolog') == 'os:linux E NÃO tag:homolog');
t('describe todos', T.describe('') == '');

section('edge cases');
t('regex chars no nome esc (ponto é literal)', T.matchNodes(FLEET, 'pfsense.edge', CTX).length == 0);
t('nome com escape correto casa substring', T.matchNodes(FLEET, 'pfsense', CTX).length == 1);
t('expressão só espaços → todos', T.matchNodes(FLEET, '  ', CTX).length == 5);
t('filtro nulo → todos', T.matchNodes(FLEET, null, null).length == 5);
t('negação de grupo', T.matchNodes(FLEET, '!g:notebooks', CTX).length == 3);
t('and com termo vazio no meio', T.parse('os:linux and and os:win') !== null);

console.log('\n' + pass + ' passaram, ' + fail + ' falharam');
process.exit(fail ? 1 : 0);
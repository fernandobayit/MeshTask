/**
* @description ScriptTask device-targeting: MeshCentral search vocabulary (server-side)
* @author Fernando Lima
* @license Apache-2.0
*
* Implements the same device-filter syntax as the MeshCentral web UI search box
* (webserver/default.handlebars getDevicesThatMatchFilter), server-side:
*
*   plain text      → device NAME substring/regex match
*   u:TERM user:TERM → usersc/upnusers of the node doc
*   g:TERM group:TERM → mesh (device group) name
*   os:TERM          → node.osdesc
*   t:TERM tag:TERM  → node.tags[]
*   a:TERM atag:TERM → node.agent.tag
*   desc:TERM        → node.desc
*   ip:TERM          → node.ip
*   c:TERM connectivity: → agent connectivity (agent/cira/amt/relay/mqtt/local)
*   wsc:ok|noav|noupdate|nofirewall|any → Windows Security Center state
*   *                → starred nodes (uses stars map)
*   !X               → negation of filter X
*   X and Y          → intersection
*   X or Y           → union
*
* The resolver works on a live snapshot of the fleet provided by the caller
* (the plugin passes webserver.meshes + node docs + connectivity map), so a
* scheduled job always targets the CURRENT fleet state at dispatch time.
*/

"use strict";

var TARGETING = {};

// OS family expansion for os: filters — 'os:linux' matches any distro, 'os:windows'
// matches all Windows variants. Values are lowercase substrings tested against osdesc.
var OS_FAMILIES = {
    'linux': ['linux', 'debian', 'ubuntu', 'centos', 'rocky', 'almalinux', 'oracle linux', 'fedora', 'red hat', 'rhel', 'opensuse', 'suse', 'arch', 'alpine', 'gentoo', 'nixos', 'manjaro', 'mint', 'elementary', 'kali', 'amzn', 'amazon linux'],
    'windows': ['windows', 'win10', 'win11', 'win 10', 'win 11', 'microsoft windows'],
    'bsd': ['freebsd', 'openbsd', 'netbsd'],
    'macos': ['macos', 'os x', 'mac os'],
    'unix': ['linux', 'freebsd', 'openbsd', 'netbsd', 'solaris', 'aix']
};

// ---------- parsing ----------

/**
* Parse a filter expression into an AST-ish token list.
* Precedence: or < and (same as MC UI: 'and' binds tighter than 'or').
*/
TARGETING.parse = function (expr) {
    if (typeof expr != 'string') return null;
    var orParts = splitKeyword(expr, 'or');
    var orNodes = [];
    for (var i in orParts) {
        var andParts = splitKeyword(orParts[i], 'and');
        var andNodes = [];
        for (var j in andParts) {
            var term = andParts[j].trim();
            if (term == '') continue;
            andNodes.push(parseTerm(term));
        }
        if (andNodes.length == 0) continue;
        orNodes.push(andNodes.length == 1 ? andNodes[0] : { op: 'and', terms: andNodes });
    }
    if (orNodes.length == 0) return null;
    return orNodes.length == 1 ? orNodes[0] : { op: 'or', terms: orNodes };
};

function splitKeyword(str, kw) {
    // split on ' and '/' or ' (spaces required, case-insensitive) — like MC UI
    var parts = [];
    var lower = str.toLowerCase();
    var kw = ' ' + kw + ' ';
    var start = 0, idx;
    while ((idx = lower.indexOf(kw, start)) >= 0) {
        parts.push(str.substring(start, idx));
        start = idx + kw.length;
    }
    parts.push(str.substring(start));
    return parts;
}

function parseTerm(term) {
    var negate = false;
    if (term.charAt(0) == '!') { negate = true; term = term.substring(1); }
    var prefix = null, value = term;
    var prefixes = ['user:', 'u:', 'ip:', 'group:', 'g:', 'tag:', 't:', 'atag:', 'a:', 'os:', 'amt:', 'desc:', 'connectivity:', 'c:', 'wsc:'];
    var low = term.toLowerCase();
    for (var p in prefixes) {
        if (low.indexOf(prefixes[p]) == 0) {
            prefix = prefixes[p];
            value = term.substring(prefix.length);
            // normalize short to canonical
            if (prefix == 'u:') prefix = 'user:';
            else if (prefix == 'g:') prefix = 'group:';
            else if (prefix == 't:') prefix = 'tag:';
            else if (prefix == 'a:') prefix = 'atag:';
            else if (prefix == 'c:') prefix = 'connectivity:';
            break;
        }
    }
    return { negate: negate, prefix: prefix, value: value };
}

// ---------- matching ----------

/**
* matchNodes(nodeDocs, filterExpr, context) -> array of node ids that match
* nodeDocs: [{ _id, name, rname, osdesc, os, tags, desc, ip, agent: {id, ver, tag}, usersc|users, upnusers, meshid, mtype, intelamt, wsc }]
* context: {
*   meshes: { meshid -> { name } },
*   connectivity: { nodeid -> connFlags },   // 1=agent, 2=cira, 4=amt, 8=relay, 16=mqtt
*   onlineAgents: [nodeid...],               // convenience: connectivity&1
*   stars: { nodeid: 1 }                     // optional
* }
*/
TARGETING.matchNodes = function (nodeDocs, filterExpr, context) {
    var ast = TARGETING.parse(filterExpr);
    if (ast == null) return nodeDocs.map(function (d) { return d._id; });
    var ctx = context || {};
    var result = [];
    for (var i in nodeDocs) {
        if (matchNode(nodeDocs[i], ast, ctx)) result.push(nodeDocs[i]._id);
    }
    return result;
};

function matchNode(node, ast, ctx) {
    if (ast.op == 'and') {
        for (var i in ast.terms) { if (!matchNode(node, ast.terms[i], ctx)) return false; }
        return true;
    }
    if (ast.op == 'or') {
        for (var i in ast.terms) { if (matchNode(node, ast.terms[i], ctx)) return true; }
        return false;
    }
    // leaf
    var m = matchLeaf(node, ast, ctx);
    return ast.negate ? !m : m;
}

function contains(hay, needle) {
    if (hay == null) return false;
    hay = String(hay).toLowerCase();
    needle = String(needle).toLowerCase();
    // same as MC UI: regex-escaped substring test
    try {
        var rs = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(rs).test(hay);
    } catch (e) { return hay.indexOf(needle) >= 0; }
}

function matchLeaf(node, term, ctx) {
    var v = term.value;
    var lower = String(term.value == null ? '' : term.value).toLowerCase();
    switch (term.prefix) {
        case 'user:': {
            var users = node.usersc || node.users || [];
            if (typeof users == 'string') users = [users];
            for (var i in users) {
                if (contains(users[i], v)) return true;
            }
            if (node.upnusers) for (var j in node.upnusers) { if (contains(node.upnusers[j], v)) return true; }
            return false;
        }
        case 'ip:': return contains(node.ip, v);
        case 'group:': {
            var mesh = (ctx.meshes && ctx.meshes[node.meshid]) || null;
            return mesh ? contains(mesh.name, v) : false;
        }
        case 'tag:': {
            var tags = node.tags || [];
            if (lower == '' && tags.length == 0) return true; // 't:' = untagged, like MC
            if (lower == '') return false; // node has tags → not untagged
            for (var k in tags) { if (contains(tags[k], v)) return true; }
            return false;
        }
        case 'atag:': {
            var atag = (node.agent && node.agent.tag) || null;
            if (lower == '' && atag == null) return true;
            return atag != null && contains(atag, v);
        }
        case 'os:': {
            // Family expansion: 'os:linux' matches any Linux distro even when the
            // osdesc string lacks the word 'linux' (e.g. 'Ubuntu 24.04.2 LTS').
            var fam = OS_FAMILIES[lower];
            if (fam) {
                var hay = String(node.osdesc || node.os || '').toLowerCase();
                for (var f in fam) { if (hay.indexOf(fam[f]) >= 0) return true; }
                return contains(node.osdesc || node.os, v);
            }
            return contains(node.osdesc || node.os, v);
        }
        case 'amt:': {
            if (node.intelamt == null) return false;
            return (lower == '') || (String(node.intelamt.state || '').toLowerCase() == lower);
        }
        case 'desc:': return node.desc != null && node.desc != '' && contains(node.desc, v);
        case 'connectivity:': {
            var flags = (ctx.connectivity && ctx.connectivity[node._id]) || 0;
            lower = lower.toLowerCase();
            if (lower == 'agent') return (flags & 1) != 0;
            if (lower == 'cira') return (flags & 2) != 0;
            if (lower == 'amt') return (flags & 4) != 0;
            if (lower == 'relay') return (flags & 8) != 0;
            if (lower == 'mqtt') return (flags & 16) != 0;
            if (lower == 'local') return (node.mtype == 3);
            if (lower == 'online') return (flags & 1) != 0;
            if (lower == 'offline') return (flags & 1) == 0;
            return false;
        }
        case 'wsc:': {
            var w = node.wsc;
            if (!w) return false;
            if (v == 'ok') return w.antiVirus == 'OK' && w.autoUpdate == 'OK' && w.firewall == 'OK';
            if (v == 'noav') return w.antiVirus != 'OK';
            if (v == 'noupdate') return w.autoUpdate != 'OK';
            if (v == 'nofirewall') return w.firewall != 'OK';
            if (v == 'any') return (w.antiVirus != 'OK') || (w.autoUpdate != 'OK') || (w.firewall != 'OK');
            return false;
        }
        case null: {
            // plain text: device name (and mesh name, like MC with 'show mesh in name')
            if (term.value == '*') {
                return !!(ctx.stars && ctx.stars[node._id] == 1);
            }
            if (term.value == '') return true; // empty term matches all (like MC)
            if (contains(node.name, v)) return true;
            if (node.rname && contains(node.rname, v)) return true;
            var mesh = (ctx.meshes && ctx.meshes[node.meshid]) || null;
            if (mesh && contains(mesh.name, v)) return true;
            return false;
        }
    }
    return false;
}

// ---------- validation ----------
TARGETING.validate = function (expr) {
    var ast = TARGETING.parse(expr);
    if (ast == null) return { ok: false, error: 'expressão vazia' };
    // walk leaves checking prefixes known
    var knownPrefixes = ['user:', 'ip:', 'group:', 'tag:', 'atag:', 'os:', 'amt:', 'desc:', 'connectivity:', 'wsc:'];
    function walk(n) {
        if (n.op) { return n.terms.every(walk); }
        var known = ['user:', 'ip:', 'group:', 'tag:', 'atag:', 'os:', 'amt:', 'desc:', 'connectivity:', 'wsc:', null];
        if (known.indexOf(n.prefix) < 0) return false;
        // prefix null mas contém ':' no valor → prefixo desconhecido (ex.: xyz:foo)
        // D10: a checagem vale TAMBÉM com '!' — '!xyz:foo' passava e casava com nada.
        if (n.prefix == null && n.value.indexOf(':') >= 0) {
            var maybePrefix = n.value.split(':')[0] + ':';
            // D9/D10: prefixos de conectividade aceitam apenas valores definidos
            if (maybePrefix == 'connectivity:' || maybePrefix == 'c:') {
                var cv = n.value.split(':')[1] || '';
                var okVals = ['agent', 'cira', 'amt', 'relay', 'mqtt', 'local', 'online', 'offline'];
                if (cv == '' || okVals.indexOf(cv) < 0) return false; // c: desconhecido → rejeita (antes: false silencioso)
            }
            return knownPrefixes.indexOf(maybePrefix) >= 0;
        }
        // D9: 'c:'/'connectivity:' direto (com prefixo) também valida o valor
        if ((n.prefix == 'connectivity:') && (n.value == '' || ['agent', 'cira', 'amt', 'mqtt', 'local', 'online', 'offline'].indexOf(n.value) < 0)) return false;
        return true;
    }
    if (!walk(ast)) return { ok: false, error: 'prefixo desconhecido' };
    return { ok: true, ast: ast };
};

TARGETING.describe = function (expr) {
    // human-readable one-liner for the UI
    var ast = TARGETING.parse(expr);
    if (ast == null) return '';
    function d(n) {
        if (n.op == 'and') return n.terms.map(d).join(' E ');
        if (n.op == 'or') return n.terms.map(d).join(' OU ');
        var base = n.prefix ? (n.prefix + n.value) : (n.value == '' ? 'todos' : ('nome ~ ' + n.value));
        return n.negate ? ('NÃO ' + base) : base;
    }
    return d(ast);
};

module.exports = TARGETING;
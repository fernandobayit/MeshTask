/** 
* @description MeshCentral ScriptTask plugin
* @author Fernando Lima (based on Ryan Blenis' original module)
* @copyright 
* @license Apache-2.0
*/

"use strict";
var mesh;
var obj = this;
var _sessionid;
var isWsconnection = false;
var wscon = null;
var db = require('SimpleDataStore').Shared();
var pendingDownload = [];
var debug_flag = false;
var runningJobs = [];
var runningJobPIDs = {};

var dbg = function(str) {
    if (debug_flag !== true) return;
    var fs = require('fs');
    var logStream = fs.createWriteStream('scripttask.txt', {'flags': 'a'});
    // use {'flags': 'a'} to append and {'flags': 'w'} to erase and write a new file
    logStream.write('\n'+new Date().toLocaleString()+': '+ str);
    logStream.end('\n');
}

Array.prototype.remove = function(from, to) {
  var rest = this.slice((to || from) + 1 || this.length);
  this.length = from < 0 ? this.length + from : from;
  return this.push.apply(this, rest);
};

function consoleaction(args, rights, sessionid, parent) {
    isWsconnection = false;
    wscon = parent;
    // A1: sem 'var' — a atribuição precisa ir para a GLOBAL _sessionid;
    // o var local sombreava e jobComplete saía sem sessionid (A1).
    _sessionid = sessionid;
    if (typeof args['_'] == 'undefined') {
      args['_'] = [];
      args['_'][1] = args.pluginaction;
      args['_'][2] = null;
      args['_'][3] = null;
      args['_'][4] = null;
      isWsconnection = true;
    }
    
    var fnname = args['_'][1];
    mesh = parent;
    
    switch (fnname) {
        case 'triggerJob':
            var jObj = { 
                jobId: args.jobId,
                scriptId: args.scriptId,
                replaceVars: args.replaceVars,
                scriptHash: args.scriptHash,
                dispatchTime: args.dispatchTime
            };
            //dbg('jObj args is ' + JSON.stringify(jObj));
            var sObj = getScriptFromCache(jObj.scriptId);
            //dbg('sobj = ' + JSON.stringify(sObj) + ', shash = ' + jObj.scriptHash);
            if (sObj == null || sObj.contentHash != jObj.scriptHash) {
                // get from the server, then run
                //dbg('Getting and caching script '+ jObj.scriptId);
                mesh.SendCommand({ 
                    "action": "plugin", 
                    "plugin": "scripttask",
                    "pluginaction": "getScript",
                    "scriptId": jObj.scriptId, 
                    "sessionid": _sessionid,
                    "tag": "console"
                });
                pendingDownload.push(jObj);
            } else {
                // ready to run
                runScript(sObj, jObj);
            }
        break;
        case 'cacheScript':
            var sObj = args.script;
            cacheScript(sObj);
            // A3: filtrar em NOVO array — remover com remove(k) durante o
            // forEach pulava o elemento seguinte; hash divergente (script
            // editado no meio do voo) ficou órfão para sempre.
            var runNow = [];
            pendingDownload = pendingDownload.filter(function(pd) {
                if (pd.scriptId != sObj._id) return true;
                if (pd.scriptHash != sObj.contentHash) { finalizeJob(pd, null, 'Script changed during job (hash mismatch)'); return false; }
                runNow.push(pd);
                return false;
            });
            runNow.forEach(function(pd) { runScript(sObj, pd); });
        break;
        case 'clearAll':
            clearCache();
            // A10: clearAll também precisa limpar pendências locais de download
            pendingDownload = [];
            mesh.SendCommand({ 
                "action": "plugin", 
                "plugin": "scripttask",
                "pluginaction": "clearAllPendingJobs",
                "sessionid": _sessionid,
                "tag": "console"
            });
            return 'Cache cleared. All pending jobs cleared.';
        break;
        case 'clearCache':
            clearCache();
            return 'The script cache has been cleared';
        break;
        case 'debug':
            debug_flag = (debug_flag) ? false : true;
            var str = (debug_flag) ? 'on' : 'off';
            return 'Debugging is now ' + str;
        break;
        case 'getPendingJobs':
            var ret = '';
            if (pendingDownload.length == 0) return "No jobs pending script download";
            pendingDownload.forEach(function(pd, k) {     
                ret += 'Job ' + k + ': ' + 'JobID: ' + pd.jobId + ' ScriptID: ' + pd.scriptId;
            });
            return ret;
        break;
        default:
            dbg('Unknown action: '+ fnname + ' with data ' + JSON.stringify(args));
        break;
    }
}

function finalizeJob(job, retVal, errVal) {
    // A8: errVal robusto — objeto de error sem stack serializava '{}' no
    // histórico (erro silencioso); objetos viram JSON, valores não-string
    // viram String().
    if (errVal != null && typeof errVal == 'object') {
        errVal = (errVal.stack != null) ? String(errVal.stack) : JSON.stringify(errVal);
    } else if (errVal != null && typeof errVal != 'string') {
        errVal = String(errVal);
    }
    runningJobs.remove(runningJobs.indexOf(job.jobId));
    if (typeof runningJobPIDs[job.jobId] != 'undefined') delete runningJobPIDs[job.jobId];
    mesh.SendCommand({ 
        "action": "plugin", 
        "plugin": "scripttask",
        "pluginaction": "jobComplete",
        "jobId": job.jobId,
        "scriptId": job.scriptId,
        "retVal": retVal,
        "errVal": errVal,
        "dispatchTime": job.dispatchTime, // include original run time (long running tasks could have tried a re-send)
        "sessionid": _sessionid,
        "tag": "console"
    });
}
//@TODO Test powershell on *nix devices with and without powershell installed
function runPowerShell(sObj, jObj) {
    if (process.platform != 'win32') return runPowerShellNonWin(sObj, jObj);
    const fs = require('fs');
    var rand =  Math.random().toString(32).replace('0.', '');
    
    var oName = 'st' + rand + '.txt';
    var pName = 'st' + rand + '.ps1';
    var pwshout = '', pwsherr = '', cancontinue = false;
    try {
        // A6: PS 5.1 lê .ps1 sem BOM como ANSI — acentos (PT-BR) corrompidos;
        // gravar com BOM quando houver caracteres não-ASCII.
        var hasNonAscii = /[^\x00-\x7F]/.test(sObj.content);
        var psBuf = hasNonAscii ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(sObj.content, 'utf8')]) : Buffer.from(sObj.content, 'utf8');
        fs.writeFileSync(pName, psBuf);
        var outstr = '', errstr = '';
        // A6: '-ExecutionPolicy Bypass' era UM argumento com espaço — execFile
        // não divide tokens; o PowerShell recebia um parâmetro inválido.
        var child = require('child_process').execFile(process.env['windir'] + '\\system32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass'] );
        child.stderr.on('data', function (chunk) { errstr += chunk; });
        child.stdout.on('data', function (chunk) { });
        runningJobPIDs[jObj.jobId] = child.pid;
        child.stdin.write('.\\' + pName + ' | Out-File ' + oName + ' -Encoding UTF8\r\n');
        child.on('exit', function(procRetVal, procRetSignal) {
            dbg('Exiting with '+procRetVal + ', Signal: ' + procRetSignal); 
            // A7: exit code REAL — stderr com exit 0 é warning, não falha.
            if (procRetVal != 0) {
                try { 
                    fs.unlinkSync(oName);
                    fs.unlinkSync(pName);
                } catch (e) { dbg('Could not unlink files, error was: ' + e); }
                finalizeJob(jObj, null, 'exit=' + procRetVal + (errstr ? (': ' + errstr) : ''));
                return;
            }
            try { 
                outstr = fs.readFileSync(oName, 'utf8').toString();
            } catch (e) { outstr = 'Success'; }
            if (outstr) {
                try { outstr = outstr.trim(); } catch (e) { }
            } else {
                outstr = (errstr != '') ? ('Warnings:\n' + errstr) : 'Success';
            }
            dbg('Output is: ' + outstr);
            finalizeJob(jObj, outstr);
            try { 
                fs.unlinkSync(oName);
                fs.unlinkSync(pName);
            } catch (e) { }
        });
        child.stdin.write('exit\r\n');
        //child.waitExit(); // this was causing the event loop to stall on long-running scripts, switched to '.on exit'

    } catch (e) { 
        dbg('Error block was (PowerShell): ' + e);
        finalizeJob(jObj, null, e);
    }
}

function runPowerShellNonWin(sObj, jObj) {
    const fs = require('fs');
    var rand =  Math.random().toString(32).replace('0.', '');
    
    var path = '';
    var pathTests = [
        '/usr/local/mesh',
        '/tmp',
        '/usr/local/mesh_services/meshagent', 
        '/var/tmp'
    ];
    pathTests.forEach(function(p) {
        if (path == '' && fs.existsSync(p)) { path = p; }
    });
    dbg('Path chosen is: ' + path);
    path = path + '/';
    
    var oName = 'st' + rand + '.txt';
    var pName = 'st' + rand + '.ps1';
    var pwshout = '', pwsherr = '', cancontinue = false;
    try {
        var childp = require('child_process').execFile('/bin/sh', ['sh']);
        childp.stderr.on('data', function (chunk) { pwsherr += chunk; });
        childp.stdout.on('data', function (chunk) { pwshout += chunk; });
        childp.stdin.write('which pwsh' + '\n');
        childp.stdin.write('exit\n');
        childp.waitExit();
    } catch (e) { finalizeJob(jObj, null, "Couldn't determine pwsh in env: " + e); }
    if (pwsherr != '') {
        finalizeJob(jObj, null, "PowerShell env determination error: " + pwsherr);
        return;
    }
    if (pwshout.trim() != '') {
        cancontinue = true;
    }
    if (cancontinue === false) { finalizeJob(jObj, null, "PowerShell is not installed"); return; }
    try {
        fs.writeFileSync(path + pName, '#!' + pwshout + '\n' + sObj.content.split('\r\n').join('\n').split('\r').join('\n'));
        var outstr = '', errstr = '';
        var child = require('child_process').execFile('/bin/sh', ['sh']);
        child.stderr.on('data', function (chunk) { errstr += chunk; });
        child.stdout.on('data', function (chunk) { });
        runningJobPIDs[jObj.jobId] = child.pid;
        
        child.stdin.write('cd ' + path + '\n');                                                                                                                                                
        child.stdin.write('chmod a+x ' + pName + '\n');                                                                                                                                        
        child.stdin.write('./' + pName + ' > ' + oName + '\n');
        child.on('exit', function(procRetVal, procRetSignal) {
            // A7: exit code REAL — stderr com exit 0 é warning; exit != 0 é erro.
            if (procRetVal != 0) {
                try {
                    fs.unlinkSync(path + oName);
                    fs.unlinkSync(path + pName);
                } catch (e) { dbg('Could not unlink files1, error was: ' + e + ' for path ' + path); }
                finalizeJob(jObj, null, 'exit=' + procRetVal + (errstr ? (': ' + errstr) : ''));
                return;
            }
            try { 
                outstr = fs.readFileSync(path + oName, 'utf8').toString();
            } catch (e) { outstr = 'Success'; }
            if (outstr) {
                try { outstr = outstr.trim(); } catch (e) { }
            } else {
                outstr = (errstr != '') ? ('Warnings:\n' + errstr) : 'Success';
            }
            dbg('Output is: ' + outstr);
            finalizeJob(jObj, outstr);
            try {
                fs.unlinkSync(path + oName);
                fs.unlinkSync(path + pName);
            } catch (e) { dbg('Could not unlink files2, error was: ' + e + ' for path ' + path); }
        });
        child.stdin.write('exit\n');
    } catch (e) { 
        dbg('Error block was (PowerShellNonWin): ' + e);
        finalizeJob(jObj, null, e);
    }
}

function runBat(sObj, jObj) {
    if (process.platform != 'win32') {
        finalizeJob(jObj, null, 'Platform not supported.');
        return;
    }
    const fs = require('fs');
    var rand =  Math.random().toString(32).replace('0.', '');
    var oName = 'st' + rand + '.txt';
    var pName = 'st' + rand + '.bat';
    try {
        fs.writeFileSync(pName, sObj.content);
        var outstr = '', errstr = '';
        var child = require('child_process').execFile(process.env['windir'] + '\\system32\\cmd.exe');
        child.stderr.on('data', function (chunk) { errstr += chunk; });
        child.stdout.on('data', function (chunk) { });
        runningJobPIDs[jObj.jobId] = child.pid;
        child.stdin.write(pName + ' > ' + oName + '\r\n');
        child.stdin.write('exit\r\n');

        child.on('exit', function(procRetVal, procRetSignal) {
            // A7: exit code REAL decide — stderr com exit 0 é warning.
            if (procRetVal != 0) {
                try { 
                    fs.unlinkSync(oName);
                    fs.unlinkSync(pName);
                } catch (e) { dbg('Could not unlink files, error was: ' + e); }
                finalizeJob(jObj, null, 'exit=' + procRetVal + (errstr ? (': ' + errstr) : ''));
                return;
            }
            try { 
                outstr = fs.readFileSync(oName, 'utf8').toString();
            } catch (e) { outstr = 'Success'; }
            if (outstr) {
                try { outstr = outstr.trim(); } catch (e) { }
            } else {
                outstr = (errstr != '') ? ('Warnings:\n' + errstr) : 'Success';
            }
            dbg('Output is: ' + outstr);
            try {
                fs.unlinkSync(oName);
                fs.unlinkSync(pName);
            } catch (e) { dbg('Could not unlink files, error was: ' + e); }
            finalizeJob(jObj, outstr);
        });
    } catch (e) { 
        dbg('Error block was (BAT): ' + e);
        finalizeJob(jObj, null, e);
    }
}

function runBash(sObj, jObj) {
    if (process.platform == 'win32') {
        finalizeJob(jObj, null, 'Platform not supported.');
        return;
    }
    //dbg('proc is ' + JSON.stringify(process));
    const fs = require('fs');
    var path = '';
    var pathTests = [
        '/usr/local/mesh',
        '/tmp',
        '/usr/local/mesh_services/meshagent', 
        '/var/tmp'
    ];
    pathTests.forEach(function(p) {
        if (path == '' && fs.existsSync(p)) { path = p; }
    });
    dbg('Path chosen is: ' + path);
    path = path + '/';
    //var child = require('child_process');
    //child.execFile(process.env['windir'] + '\\system32\\cmd.exe', ['/c', 'RunDll32.exe user32.dll,LockWorkStation'], { type: 1 });
    
    var rand =  Math.random().toString(32).replace('0.', '');
    var oName = 'st' + rand + '.txt';
    var pName = 'st' + rand + '.sh';
    try {
        // A7: CRLF corrompia script .sh (shebang com \r → bad interpreter);
        // normalizar CR→LF antes de gravar.
        fs.writeFileSync(path + pName, String(sObj.content).split('\r\n').join('\n').split('\r').join('\n'));
        var outstr = '', errstr = '';
        var child = require('child_process').execFile('/bin/sh', ['sh']);
        child.stderr.on('data', function (chunk) { errstr += chunk; });
        child.stdout.on('data', function (chunk) { });
        runningJobPIDs[jObj.jobId] = child.pid;
        child.stdin.write('cd ' + path + '\n');
        child.stdin.write('chmod a+x ' + pName + '\n');
        child.stdin.write('./' + pName + ' > ' + oName + '\n');
        child.stdin.write('exit\n');
        
        child.on('exit', function(procRetVal, procRetSignal) {
            // A7: exit code REAL decide o resultado — stderr com exit 0 é
            // warning (não erro); exit ≠ 1 também é erro com código no texto.
            if (procRetVal != 0) {
                var errmsg = (errstr != '') ? errstr : ('Script falhou com exit code ' + procRetVal);
                try {
                    fs.unlinkSync(path + oName);
                    fs.unlinkSync(path + pName);
                } catch (e) { dbg('Could not unlink files, error was: ' + e + ' for path ' + path); }
                finalizeJob(jObj, null, 'exit=' + procRetVal + (errstr ? (': ' + errstr) : ''));
                return;
            }
            try { 
                outstr = fs.readFileSync(path + oName, 'utf8').toString();
            } catch (e) { outstr = 'Success'; }
            if (outstr) {
                try { outstr = outstr.trim(); } catch (e) { }
            } else {
                outstr = (errstr != '') ? ('Warnings:\n' + errstr) : 'Success';
            }
            dbg('Output is: ' + outstr);
            try {
                fs.unlinkSync(path + oName);
                fs.unlinkSync(path + pName);
            } catch (e) { dbg('Could not unlink files2, error was: ' + e + ' for path ' + path); }
            finalizeJob(jObj, outstr);
        });
    } catch (e) { 
        dbg('Error block was (bash): ' + e);
        finalizeJob(jObj, null, e);
    }
}

function jobIsRunning(jObj) {
    if (runningJobs.indexOf(jObj.jobId) === -1) return false;
    return true;
}

function runScript(sObj, jObj) {
    // get current processes and clean running jobs if they are no longer running (computer fell asleep, user caused process to stop, etc.)
    if (process.platform != 'linux' && runningJobs.length) { // linux throws errors here in the meshagent for some reason
        require('process-manager').getProcesses(function (plist) {
            dbg('Got process list');
            dbg('There are currently ' + runningJobs.length + ' running jobs.');
            // A2: iterar DE trás para frente e remover por jobId (não por índice);
            // antes, indexOf(idx) era -1 e remove(-1) apagava o ÚLTIMO elemento.
            for (var i = runningJobs.length - 1; i >= 0; i--) {
                var jobId = runningJobs[i];
                dbg('Checking for running job: ' + jobId + ' with PID ' + runningJobPIDs[jobId]);
                if (typeof plist[runningJobPIDs[jobId]] == 'undefined' || typeof plist[runningJobPIDs[jobId]].cmd != 'string') {
                    dbg('Found job with no process. Removing running status.');
                    delete runningJobPIDs[jobId];
                    runningJobs.splice(i, 1);
                }
            }
        });
    }
    if (jobIsRunning(jObj)) { dbg('Job already running job id [' + jObj.jobId + ']. Skipping.'); return; }
    // A14: clonar o script — a interpolação de variáveis NÃO PODE mutar o
    // objeto em cache, senão o 2º job do lote roda com interpolado do 1º nó.
    // A12 no processo: key com escape de regex e val passado como função
    // (evita que $&, $1, etc. no VALOR sejam interpretados como padrões).
    var doc = (jObj.replaceVars != null) ? JSON.parse(JSON.stringify(sObj)) : sObj;
    if (jObj.replaceVars != null) {
        Object.getOwnPropertyNames(jObj.replaceVars).forEach(function(key) {
          var val = jObj.replaceVars[key];
          doc.content = doc.content.replace(new RegExp('#' + key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '#', 'g'), function() { return val; });
          dbg('replacing var '+ key + ' with ' + val);
        });
        doc.content = doc.content.replace(new RegExp('#(.*?)#', 'g'), 'VAR_NOT_FOUND');
    }
    runningJobs.push(jObj.jobId);
    dbg('Running Script '+ doc._id);
    switch (doc.filetype) {
        case 'ps1':
            runPowerShell(doc, jObj);
        break;
        case 'bat':
            runBat(doc, jObj);
        break;
        case 'bash':
            runBash(doc, jObj);
        break;
        default:
            // A5: filetype desconhecido NÃO pode deixar job zumbi (runningJobs
            // sem resposta ao server — timeout do server seria enganoso).
            dbg('Unknown filetype: ' + doc.filetype);
            runningJobs.splice(runningJobs.indexOf(jObj.jobId), 1);
            finalizeJob(jObj, null, 'Unsupported script type: ' + doc.filetype);
        break;
    }
}
function getScriptFromCache(id) {
    var script = db.Get('pluginScriptTask_script_' + id);
    if (script == '' || script == null) return null;
    try {
        script = JSON.parse(script);
    } catch (e) { return null; }
    return script;
}
function cacheScript(sObj) {
    db.Put('pluginScriptTask_script_' + sObj._id, sObj);
}
function clearCache() {
    db.Keys.forEach(function(k) {
        if (k.indexOf('pluginScriptTask_script_') === 0) {
            db.Put(k, null);
            db.Delete(k);
        }
    });
}

function sendConsoleText(text, sessionid) {
    if (typeof text == 'object') { text = JSON.stringify(text); }
    mesh.SendCommand({ "action": "msg", "type": "console", "value": text, "sessionid": sessionid });
}

module.exports = { consoleaction : consoleaction };

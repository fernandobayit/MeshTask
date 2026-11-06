# Changelog — MeshTask (MeshCentral ScriptTask Runner)

## v1.0.2 (2026-10-14) — code review fixes

### Server core
- R1: deleteElement usava `deleteSchedulesForScript` (inexistente em db2.js) — TypeError silencioso impedia a limpeza de agendamentos ao deletar um script; agora chama `deleteJobSchedulesForScript`
- R2: weekly sem interval (NaN) deletava o schedule silenciosamente — validação no addScheduledJob (default 1 semana) + guard defensivo em determineNextJobTime

### Agente (modules_meshcore/scripttask.js)
- A16: writeFileSync do runBash com objeto options ({ mode: 0o600 }) travava a execução no meshagent — o agente (Duktape, duk_api_stack.c) não aceita objeto options no writeFileSync ('number required, found undefined'); gravar em 2 args + chmodSync(0600) best-effort; chmod 700 no shell no lugar do a+x (intenção A11 owner-only preservada, janela write→exec fechada)

### Targeting (targeting.js)
- R3: matchNodes com parse inválido (expressão vazia/nula) devolvia a FROTA INTEIRA (fail-open) — agora fail-closed: array vazio

### Testes
- test_db2.js / test_serveraction.js: mock e chamadas alinhados à API real do db2.js (`deleteJobSchedulesForScript`)
- test_targeting.js: checks do comportamento fail-open atualizados para fail-closed
- test_fixes.js: 3 checks novos de regressão A16 (96 checks na suíte)
- suíte: 96 checks verdes

## v1.0.1 (2026-09-30) — release GBH-S004

Versão de estabilidade: ~45 correções de bugs mapeadas na revisão completa de 2026-09-30.

### Server core
- S1: script efêmero (comando ad-hoc) só é apagado quando o ÚLTIMO job dele conclui — comando por filtro executa em todos os targets
- S2: jobs despachados não são mais reenviados a cada ciclo (despachado = aguardando conclusão); reenvio é rota do timeout
- S3: interval <= 0 / ausente não trava mais o scheduler (loop infinito) — validação na criação + guard defensivo
- S4: índice único parcial impede jobs duplicados do mesmo slot (tick vs jobComplete)
- S5: PRAGMA busy_timeout=5000 (acesso externo ao sqlite)
- S6: eventos do plugin entregues APENAS a admins conectados (sem '*' broadcast)
- S7: runCommand valida o filtro antes de resolver targets (fail-closed)
- S8: schedule weekly com nextRun antigo (>7d) re-ancorado no presente — sem deleção silenciosa
- S9: weekly DST-safe (hora local do startAt recomposta por ocorrência)
- S10: serveraction com guard de db não-pronto
- S11: GC de scripts efêmeros órfãos no cleanHistory
- A15: jobComplete valida posse do job (só o nó próprio) e tipo do dispatchTime; jobComplete tardio não sobrescreve o Timeout

### Banco de dados (db2.js)
- D1/D2: migração NeDB retomável (sem exigência de banco vazio; rename só com zero falhas)
- D3: update() com SELECT dentro da fila serial (sem lost update)
- D4: parsing defensivo em rowDoc/getDBVersion/update (docs corrompidos não quebram leitura)
- D5: busy_timeout 5000
- D6: resolução do sqlite3 inclui o node_modules do próprio plugin; symlink quebrado removido do repo
- D8: getPendingJobs fatiado em chunks de 900 nodes (SQLITE_MAX_VARIABLE_NUMBER)
- D12: timestamps string-ISO normalizados na migração (completeTime/dispatchTime/queueTime/nextRun)
- D14: código morto (esc()/lim) removido
- D15: getVariables com names vazio devolve []; checkDefaults trata promessa
- rowDoc corrompido: linha pulada com log (todas as leituras com .filter(Boolean))

### Agente (modules_meshcore/scripttask.js)
- A1: _sessionid global (jobComplete sai com sessionid)
- A2: cleanup de runningJobs itera em ordem reversa e remove por jobId
- A3: cacheScript filtra pendências em novo array (sem pular itens; hash divergente finaliza com erro)
- A5: filetype desconhecido finaliza o job com erro (sem zumbi)
- A6: .ps1 gravado com BOM (PS5.1 não corrompe acentos); -ExecutionPolicy separado em 2 tokens
- A7: exit code REAL decide o resultado em todos os runners (bash/bat/ps1); stderr com exit 0 = warning; bash normaliza CRLF
- A8: errVal não-string/objeto serializado de forma legível
- A9: Array.prototype deixou de ser poluído (helper local)
- A10: clearAll também limpa pendingDownload
- A11: arquivos temporários com PID no nome + mode 0600 (conteúdo interpolado pode ter credenciais)
- A13: checagem do pwsh sem waitExit (não congela o event loop)
- A14: variáveis interpoladas em CÓPIA do script (fim do vazamento entre nós) + key escapado + val como função (sem interpretação de $)

### Targeting (targeting.js)
- D9: c:/connectivity valida o valor (agent|cira|amt|relay|mqtt|local|online|offline)
- D10: '!prefixo:desconhecido' agora REJEITADO no validate (não mais casar com nada)

### UI (views/user.handlebars)
- U1: scriptTree escapado no servidor ({'<' → Unicode escape) — fim do XSS via nome de script/pasta
- U2: árvore com esc(); goRename/goDelete leem textContent (sem duplo-escape)
- U3: preview com reqId (respostas fora de ordem descartadas); erro com esc()
- U9: dropMove exige alvo pasta

### Testes
- novo test_fixes.js (17 checks);
suíte: 46 targeting + 11 schedule + 20 serveraction + 17 fixes = 94 checks verdes

### Higiene
- 11 checkview*.js (~430KB de snapshots de dev) removidos; .gitignore criado

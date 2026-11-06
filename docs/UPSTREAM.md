# MeshTask 2 — contratos upstream críticos

> **Integração em 2026-11-06:** executor ES5 e scheduler/UI agora implementados; recomendações históricas abaixo devem ser lidas com RUNTIME-CONTRACTS e o contrato vigente em README/PROTOCOL. Autenticação escolhida: identidade positiva do singleton + rejeição de rotas de usuário/console e schema fechado, modo direct-control-v1 servidor único/TLS; não assinatura RSA. Nenhuma compatibilidade com binário instalado foi homologada.

## Complemento utilizado pelo executor: relógio e captura

No mesmo SHA MeshAgent fixado abaixo, [ILibDuktape_ScriptContainer.c L2552–2565](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_ScriptContainer.c#L2552-L2565) implementa `os.uptime()`: Windows via GetTickCount64 dividido por 1000, Linux por /proc/uptime inteiro. O módulo `os` é registrado em L2597. O executor aceita somente Linux/Windows, recusa relógio inválido e usa corte conservador aos 9 s para TTL nominal de 10 s, além de timer e proteção contra retrocesso de relógio civil. Não presume process.hrtime do Node.

Captura preserva até 8192 bytes de cada stream em representação hexadecimal limitada, juntando chunks antes da decodificação UTF-8; usa Buffer.slice/toString/from presentes nos contratos de Buffer, sem StringDecoder/Buffer.concat presumidos. O fim POSIX é observado pelo binding ChildProcess L372–375 e ProcessPipe L570–575, que verifica término e lê pipes antes do exit callback. A ordenação/drenagem efetiva, especialmente Windows, permanece gate E2E, não garantia derivada de mocks.

Pesquisa de fonte oficial em 2026-11-04; destinada à implementação, não certificação de compatibilidade. Nenhum serviço, instalação, comando em dispositivo ou acesso à produção foi realizado. Snapshots em `upstream-evidence/`; testes Node e leitura offline **não provam E2E MeshAgent**. As versões efetivamente instaladas não foram consultadas.

## 1. Referências fixadas

- **MeshCentral:** `2e7ec138cf45b09204bf036b500e5e2cf37aaba4`.
- **MeshAgent:** `0e6b4f7fea6c88ad1978206550d202a7f33741c5`.
- Todos os links abaixo apontam a esses commits. Evidência local usa o formato `REPOSITÓRIO--caminho__arquivo`; os JSON de commit/tree registram a coleta. Não inferir que o binário em produção corresponde a esses SHAs.

## 2. Filesystem: causa possível do erro e temporários

**Contrato observado:** em `writeFileSync(dest, data, options)`, a implementação faz:

```javascript
var fd = this.openSync(dest, options ? options.flags : 'wb');
this.writeSync(fd, data);
this.closeSync(fd);
if (options && options.mode != null && process.platform != 'win32') {
    this.chmodSync(dest, options.mode);
}
```

Fonte: [ILibDuktape_fs.c, L2706–2712](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_fs.c#L2706-L2712).

- `{mode: 384}` sozinho é truthy, mas não contém `flags`: passa `undefined` a `openSync`. Quando o segundo argumento não é string, `openSync` executa `duk_require_int(ctx, 1)`. Isso fundamenta o caminho para **“number required, found undefined”**, não uma rejeição genérica de `mode`. **É explicação compatível com o relato V1, não diagnóstico confirmado do binário/stack trace da V1.**
- `{flags: 'wb', mode: 384}` corresponde ao wrapper observado, mas o chmod acontece **depois de escrever e fechar** e só fora do Windows. Não torna um arquivo sensível privado desde a criação.
- Sem options, usa `'wb'`; não há garantia de permissões privadas. O nome é `flags` neste wrapper, não assumir o `flag` singular da API Node.
- String flags seguem `fopen` em POSIX e `_wfopen_s` no Windows (com adição de `b` se não houver `b`/`t`). `rb`, `wb`, `ab` seguem modos da biblioteca C; suporte a exclusividade como `wx` depende da implementação C/build, **não foi comprovado como contrato portátil MeshAgent**.
- O terceiro argumento `mode` de `openSync` não é aplicado no caminho string. O caminho numérico POSIX chama literalmente `open(path, flags)` **sem argumento mode**: não usar com `O_CREAT` para criação segura. No Windows, o caminho numérico escolhe `OPEN_ALWAYS`/`OPEN_EXISTING`; não equivale ao conjunto de flags POSIX/Node nem demonstra criação exclusiva ou ACL privada.

Fontes: [fs L300–388](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_fs.c#L300-L388), [fs L408–420](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_fs.c#L408-L420).

**Decisão recomendada:** executor sem arquivos temporários para o script, alimentado por stdin. Se um caso exigir arquivo, bloquear até existir criação privada/exclusiva validada na plataforma; “escrever e depois chmod” não atende ao requisito de segurança.

## 3. execFile: argv, stdin e resultado real

**Não é o contrato de child_process do Node.** O array fornecido é repassado integralmente, limitado a 255 elementos, sem inserir automaticamente o nome do executável. As opções examinadas incluem `type`, `uid`, `detached` e `env`; não assumir `timeout`, `cwd`, `shell` ou `maxBuffer` só porque existem em Node. O callback opcional é registrado no evento `exit`, não como callback Node `(err, stdout, stderr)`.

Fontes: [ChildProcess L499–614](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_ChildProcess.c#L499-L614), [L433–474](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_ChildProcess.c#L433-L474).

- **Linux/POSIX:** chama `execv(target, parameters)` ou `execve`; incluir `argv[0]`, por exemplo `execFile('/bin/bash', ['bash', '--noprofile', '--norc', '-s'], {})`, somente após verificar disponibilidade do executável. Falha no exec do filho termina com `_exit(1)`; nem toda falha vira exceção síncrona no pai. [ProcessPipe L1019–1027](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microstack/ILibProcessPipe.c#L1019-L1027).
- **Windows:** concatena elementos com espaço, **sem quoting/escaping automático**, e passa essa linha a `CreateProcessW`/`CreateProcessAsUserW` com o executável separado. Usar argumentos fixos e mandar conteúdo por stdin, não interpolar script/path/identificadores na linha. [ProcessPipe L715–738](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microstack/ILibProcessPipe.c#L715-L738), [L804–805](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microstack/ILibProcessPipe.c#L804-L805).
- **stdin suportado:** há WritableStream; seu end handler chama `ILibProcessPipe_Process_CloseStdIn`. A combinação `stdin.write(...)` + `stdin.end()` é sustentada pelo wiring nativo, mas flush/backpressure e scripts grandes exigem E2E. Registrar listeners antes da escrita. Manter referência forte ao filho: o finalizer pode matá-lo se for coletado ainda vivo. [ChildProcess L132–145](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_ChildProcess.c#L132-L145), [L433–453](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_ChildProcess.c#L433-L453).
- **PowerShell por stdin:** o próprio meshcore usa `['powershell', '-noprofile', '-nologo', '-command', '-']`, registra stdout/stderr e escreve comandos por stdin. Isso demonstra uso upstream, não garante semântica de erro de todo script. [meshcore L1992–2029](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/agents/meshcore.js#L1992-L2029).
- **Resultado:** o evento nativo é `exit(exitCode, null)`; POSIX converte término por sinal para `128 + sinal` e erro de wait para `-1`. Não inferir sinal separado do segundo argumento. [ChildProcess L156–188](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_ChildProcess.c#L156-L188), [ProcessPipe L570–611](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microstack/ILibProcessPipe.c#L570-L611).

**Política sugerida:** Bash não interativo lendo stdin até EOF, sem acrescentar `exit 0`; definir se vale status da última instrução ou política explícita de falha, sem impor `set -e` silenciosamente. PowerShell precisa wrapper/política documentada para exceções, erros não terminantes e `$LASTEXITCODE`; não confundir código real do processo PowerShell com sucesso de todos os comandos internos. Capturar stdout/stderr com limites, código numérico e erro de spawn separadamente. Não declarar conclusão por ACK, stdout, timeout ou desconexão. Drenagem completa dos streams antes de finalizar, Unicode, EOF, backpressure, sinais e encerramento da árvore são gates de E2E, não garantias desta pesquisa.

## 4. Plugin, distribuição e transporte

### Servidor/lifecycle

- Loader: `require(<plugins>/<nome>/<nome>.js)[nome](pluginHandler)`. O argumento da factory é **pluginHandler**; `pluginHandler.parent` é o servidor raiz. Não confundir esse parent com o terceiro argumento de `serveraction`. [pluginHandler L24–67](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/pluginHandler.js#L24-L67).
- `server_startup()` é chamado sem argumentos; `callHook` captura exceções síncronas e não faz await de promises. Factory/import devem evitar iniciar timers. [pluginHandler L143–153](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/pluginHandler.js#L143-L153), [meshcentral L2135–2136](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/meshcentral.js#L2135-L2136).
- Reload instancia novamente e chama startup; disable remove referências e atualiza core. Esses caminhos não invocam cleanup/shutdown do plugin. Implementar inicialização idempotente e mecanismo próprio de parada; não supor que um hook de shutdown será chamado. [pluginHandler L566–629](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/pluginHandler.js#L566-L629).
- Hook confirmado: `hook_agentCoreIsStable(agentConnection, webserver)`; usar para handshake de versão/capabilities, não como prova de instalação/saúde do executor. Há também `hook_processAgentData(command, agentConnection, webserver)`. [meshagent L1191–1194](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/meshagent.js#L1191-L1194), [L1865–1866](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/meshagent.js#L1865-L1866).

### Distribuição e contrato do módulo agente

`modules_meshcore/*.js` vira módulo `addModule(nomeDoArquivoSemExtensão, código)`. Prefixos `win-`, `linux-`, `amt-` e nome `smbios` têm distribuição especial; demais módulos vão para todos os cores previstos. Usar nome único e evitar colisões. Não é download dinâmico de um script de tarefa; é distribuição de código privilegiado com o core. A inclusão tem catch silencioso, portanto exigir handshake explícito do módulo. [pluginHandler L155–185](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/pluginHandler.js#L155-L185).

Exportar objeto CommonJS com `consoleaction(args, rights, sessionid, parent)`; o nome “consoleaction” também atende mensagens estruturadas:

| Entrada | Chamada upstream | Consequência |
| --- | --- | --- |
| Canal de comando servidor | `require(data.plugin).consoleaction(data, data.rights, data.sessionid, this)` | Primeiro argumento é o envelope inteiro, não array de argumentos. |
| Console `plugin nome ...` | `require(args['_'][0]).consoleaction(args, rights, sessionid, mesh)` | Primeiro argumento contém `args._`; quarto é explicitamente `mesh = require('MeshAgent')`. |
| Outro caminho de mensagens do core | `require(cmd.plugin).consoleaction(cmd, null, null, this)` | Rights/session podem ser null; quarto argumento não deve ser tratado universalmente como MeshAgent. |

Fontes: [meshcore L2123–2124](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/agents/meshcore.js#L2123-L2124), [L6421–6433](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/agents/meshcore.js#L6421-L6433), [L4373–4374](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/agents/meshcore.js#L4373-L4374).

**Recomendação:** usar `require('MeshAgent').SendCommand(envelope)` para respostas, não depender de um `parent.SendCommand` universal. Não registrar outro command handler que substitua o core; integrar pelo módulo/consoleaction e pelo handshake disparado pelo servidor. Envelope versionado e estritamente validado; rejeitar comandos de console/túnel como canal de dispatch se não forem explicitamente autorizados.

### serveraction e domínio: fronteira de segurança

Ambos os caminhos chamam `serveraction(command, obj, parent)`:

- Usuário: `obj` é sessão MeshUser (possui `user`, `domain`, `ws`); `parent` é webserver. O core sobrescreve `command.userid` com usuário autenticado, mas **não aplica uma regra admin-only antes do serveraction**. Autorizar por `obj.user`/`obj.domain`, não por campos enviados pelo cliente. [meshuser L114–115](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/meshuser.js#L114-L115), [L5103–5112](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/meshuser.js#L5103-L5112).
- Agente: `obj` é conexão agente; conferir `authenticated === 2`, `domain.id`, `dbNodeKey` e vínculo com execução esperada. `command.nodeid`, `userid`, `domain`, `sessionid` não substituem a identidade da conexão. [meshagent L45–46](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/meshagent.js#L45-L46), [L1256–1265](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/meshagent.js#L1256-L1265), [L1645–1652](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/meshagent.js#L1645-L1652).
- **Bypass que o desenho deve considerar:** `routeToNode: true` no comando de usuário desvia do serveraction e chama roteamento genérico. Esse roteamento verifica domínio e permissões de nó, mas aceita remote-control **ou view-only** nessa chamada, sem requisito adicional do plugin; injeta rights/sessionid/userid e remove nodeid. Portanto, “chegou pelo canal MeshCentral” não prova que passou pelo scheduler/admin-only do MeshTask. [meshuser L278–323](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/meshuser.js#L278-L323).

**Obrigatório no desenho:** separar operações de usuário e respostas de agente; revalidar domínio/targets no servidor; dispatch interno autenticado de forma não forjável por roteamento genérico (por exemplo, autorização assinada vinculando nó, conteúdo, execução e validade, com verificação implementada e testada). Ausência de sessionid não é autenticação suficiente. Um attempt token serve para correlação/dedup, não substitui por si só um contrato de autorização. Não habilitar execução antes desse gate.

## 5. SimpleDataStore: API não equivale a journal durável

- `require('SimpleDataStore').Shared()` usa datastore do engine e pode retornar null se indisponível; `Create(path[, options])` cria instância separada. O wrapper permite `readOnly`. [SimpleDataStore binding L211–259](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_SimpleDataStore.c#L211-L259).
- `Put(key, value)`: key string; value string ou buffer. Serializar objetos explicitamente com JSON e validar schema na leitura. Retorna código inteiro da função C. `Get` converte buffer para string; `GetBuffer` preserva buffer; ausência/leitura inconsistente retorna null. Pode haver prefixo interno do GUID de contexto: não presumir compartilhamento entre contextos ou estabilidade após troca de core sem teste. [Binding L42–137](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_SimpleDataStore.c#L42-L137).
- O armazenamento evita regravar **mesma chave com mesmo hash SHA-384 do valor**. Isso é deduplicação de gravação, **não execução exatamente uma vez**, nem CAS/transação de efeitos externos. [Store L686–703](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microstack/ILibSimpleDataStore.c#L686-L703).
- Escrita faz `fwrite` e `fflush`; não foi encontrado `fsync`, `_commit` ou `FlushFileBuffers` nesse arquivo. Isso não demonstra durabilidade contra queda de energia. [Store L239–250](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microstack/ILibSimpleDataStore.c#L239-L250).
- **Crítico:** sem dataFile, cai em cache e retorna 0. Em erro de escrita, armazena em cache, reabre read-only, pode chamar error handler e também retorna 0. Logo `Put() === 0` + `Get()` imediato **não prova gravação em disco**. [Store L658–662](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microstack/ILibSimpleDataStore.c#L658-L662), [L706–717](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microstack/ILibSimpleDataStore.c#L706-L717).

**Recomendação prática:** usar namespace exclusivo e registro por executionId/attempt com hash do payload; marcar intenção antes de spawn, reter resultados e responder duplicatas sem repetir execução conhecida. Após crash/restart/registro ausente ou estado ambíguo, conciliar com ledger durável do servidor e marcar `unknown`, sem reexecutar cegamente. Não vender SimpleDataStore como única proteção persistente de dedup. Falha entre efeito do script e gravação do resultado permanece irredutível para scripts arbitrários. Confirmar persistência após restart, disco cheio/read-only, troca de core e quedas no ambiente dedicado antes de alegar dedup durável.

## 6. Prioridades imediatas e limites

1. Implementar adapter exclusivo MeshAgent, sem herdar pressupostos Node: argv[0], Windows sem escaping automático, callback exit, stdin e streams.
2. Preferir scripts via stdin; não usar fallback inseguro para temporário. Validar Bash/PowerShell e definir semântica de código de saída.
3. Fechar bypass `routeToNode` e separar identidades usuário/agente/domínio antes de habilitar execução.
4. Handshake de versão/hash/capabilities após core estável; módulo ausente ou incompatível deve falhar fechado.
5. Dedup conservadora com reconciliação; `Put` não comprova durabilidade e ACK não comprova término.
6. Gates ainda não executados: MeshAgent Windows/Linux reais, scripts com exit não zero, sintaxe inválida, Unicode, stdout/stderr grande, EOF, timeout/cancelamento, desconexão, restart e duplicata; autorização cross-domain, roteamento direto, disco cheio, reload e atualização de core. Executar somente em ambiente dedicado autorizado.

Confiança alta sobre os trechos dos SHAs citados; compatibilidade com builds instalados e comportamento E2E permanecem **não verificados**. Nenhum código legado foi utilizado como contrato ou copiado para a implementação.

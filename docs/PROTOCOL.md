# Protocolo MeshTask 2 — versão 1 (alpha)

Implementado no servidor e módulo MeshAgent. Compatibilidade de fonte e testes VM não equivalem a homologação real. Modo de execução: `direct-control-v1`, servidor único/TLS, conforme README e RUNTIME-CONTRACTS.

## Administração

Pedido: `{action:'plugin',plugin:'meshtask2',version:1,type:'request',requestId,op,input}`. Resposta ao socket autenticado chamador: mesmos action/plugin/version/requestId/op, `type:'response',method:'onMessage',ok:true,result`; erro usa `ok:false,error:{code,message}` sanitizado. Nenhum destino fornecido pelo cliente determina o socket de resposta.

Exige administrador corrente do domínio, sessão registrada e ACL dos alvos. `routeToNode:true` é recusado; no agente, identidade positiva + filtros impedem os caminhos genéricos que ignoram esta API. Ponte correlaciona requestId e op; timeout/reconexão não fazem retry automático.

Mutações são idempotentes por domínio/autor/requestId, com hash canônico de operação/input e commit atômico com a resposta. Repetição exata retorna original; conteúdo diferente recebe REPLAY_CONFLICT. Nova chave representa nova intenção e pode repetir efeitos externos.

| op | input | saída |
|---|---|---|
| status | `{}` | versão, executionEnabled, reason, scheduler automatic-single-flight, lastError, listLimit |
| scripts.list | `{}` | até 200 id/nome/revisão/engine |
| scripts.save | id?, name, engine, body, context:service | id e revisão imutável |
| jobs.create | scriptId, revision, targets, context:service | id, alvos, queued e executionBlocked conforme configuração |
| jobs.list | `{}` | até 200 jobs sem corpo |
| jobs.get | jobId, afterAttempt?, afterEvent? | snapshot, páginas, nextAttempt/nextEvent |
| schedules.create | campos do job, kind, at, intervalMs? | snapshot congelado |
| schedules.list | `{}` | próximas datas, habilitação, erro de autorização |
| schedules.disable | scheduleId | disabled:true; jobs existentes não são cancelados |

Engines: bash/powershell. Somente contexto service. `kind`: once/interval; datas ISO UTC com Z e segundos, milissegundos opcionais; intervalo 1000–31536000000 ms. O servidor agenda automaticamente; não depende do browser.

## Canal agente

Envelope básico: `action:'plugin',plugin:'meshtask2',version:1,type`. No agente, parent deve ser o singleton MeshAgent; rights/sessionid posicionais não nulos e a presença de `_`, sessionid, fromSessionid, userid, rights, routeToNode são recusados. Schema fechado por operação, inclusive para null/false. Não desembrulhar payload recursivamente.

Token de tentativa é correlação/posse de resultado, **não autorização para spawn**. A autorização vem do canal positivo dentro das premissas documentadas. Esta edição não transmite assinatura RSA ou chave pública de rede.

### Handshake/pull

1. Servidor envia `poll` com domínio/nó derivados da conexão autenticada.
2. Módulo inicializa capacidades, cria bootNonce CSPRNG por contexto e requestNonce por pull pendente. Ambos são strings decimais de 0 a 2^256−1, nunca Number.
3. Agente envia `pull` com bootNonce, requestNonce, engines e reason opcional. Servidor aceita somente da conexão autenticada/registrada; não aceita pela sessão administrativa. Falha de runtime envia `capability` com reason (`runtime_unavailable` ou `executor_capacity`), sem grant possível.
4. Um pull dura no máximo 10 s no servidor. Repetição do último nonce não renova prazo nem restaura consumo. No agente, timer de 10 s, relógio monotônico os.uptime e corte aos 9 s compensam a resolução inteira. Retrocesso/invalidez de relógio recusa o grant.
5. Servidor revalida autorização do job, persiste tentativa claimed e evento dispatch_claimed com binding/digest e confirma COMMIT antes de send.

### Servidor → agente

Campos de tentativa: `jobId`, `attemptId` (identificador único da execução) e token hex minúsculo de 64 caracteres.

- `execute`: campos de tentativa + context:service, script:{scriptId,revision,engine,body,hash}, domain,node,bootNonce,requestNonce,grantTtlMs:10000. Hash SHA-256 do corpo UTF-8 é conferido. Nenhuma lista da frota ou busca arbitrária de script. O módulo valida envelope/binding, consome pending e guarda tombstone **antes** de spawn/ACK.
- `query`: somente campos de tentativa. Consulta estado/resultado, não reenvia script nem cria autorização.
- `receipt`: somente campos de tentativa, enviado após commit do resultado idêntico/aceito. Limpa saída no agente, não dedup. Perda do receipt causa novo envio do resultado em poll/query.

Grants consumidos nunca são reemitidos para o mesmo job/nó/attempt, mesmo após crash, timeout ou reconexão. Novo boot invalida nonces anteriores. No máximo um processo ativo e 1000 tombstones por contexto; limite esgotado fecha novos grants sem eviction. Resultados podem se perder após reboot; isso não justifica reexecução.

### Agente → servidor

- `ack`: campos de tentativa; confirma aceitação, não sucesso. Duplicata não duplica auditoria.
- `status`: campos de tentativa + state:running/unknown/not_found. Não conclui nem autoriza retry. Consulta desconhecida recebe not_found.
- `result` completed: campos de tentativa + outcome:completed, exitCode inteiro de −2147483648 a 4294967295, stdout, stderr e truncated booleano. Exit zero é sucesso; stderr isolado não altera código.
- `result` rejected: outcome:rejected, exitCode:null, reason não vazio até 200 bytes, stdout/stderr/truncated. Para contexto/interpretador indisponível ou falha síncrona de spawn; falha após spawn é unknown, não rejeição definitiva.

Posse é validada por domínio/nó da conexão, job/attempt/token. Resultado igual deduplica; conflito não sobrescreve o primeiro e tem quota de evidências. Resultado tardio reconcilia unknown sem remover eventos anteriores. `receipt` não é enviado se persistência falhar; módulo mantém resultado para retry. Saída liberada por receipt não pode ser recuperada do módulo novamente, mas está durável no servidor.

## Limites

| Item | Limite |
|---|---:|
| Envelope JSON UTF-8 | 196608 bytes |
| Corpo do script | 65536 bytes, também sujeito ao envelope |
| Captura do executor | 8192 bytes originais por stream, com truncated |
| stdout/stderr aceitos pelo protocolo | 32768 bytes por stream |
| Targets explícitos | 1–100 |
| IDs | 1–128 bytes ASCII alfanuméricos, underscore/hífen |
| Nó/domínio | 512/128 bytes |
| Resposta ao browser | 1 MiB |
| Listagens principais | 200 registros e orçamento de 900000 bytes |
| Página de tentativas/eventos | 256 KiB / 50 registros |
| Conflitos por tentativa | 8 evidências + marcador único de quota |
| Ponte UI | 32 pendências, timeout 15 s |

Captura concatena bytes limitados antes de decodificar UTF-8, substitui NUL/bytes inválidos, não oferece saída binária. Limite conservador mantém orçamento JSON mesmo com escapes. Envelope máximo de dispatch reserva os campos de nonce/binding ao aceitar o snapshot.

## Garantias negativas

Sem exactly-once de efeitos, cancelamento/kill, sessão gráfica, reenvio cego ou execução offline. Timeout de 60 s é observabilidade, não controle do processo. Perda entre claim e spawn pode significar não execução; perda após efeito pode significar resultado desconhecido. Uma nova intenção com novo ID exige avaliação administrativa do risco de repetição.

# Arquitetura — MeshTask 2 alpha

## Fluxo implementado

```text
Plugins/p42 → UI/bridge → sessão MeshUser registrada
                              │ administrador corrente + ACL dos alvos
                              ▼
                         AdminAPI / Service
                              │ mutação idempotente e snapshot imutável
                              ▼
                         SQLite próprio
                              │
Lifecycle automático → schedules → Dispatcher
                              │ revalida autor e alvo
Agente ← poll ← transporte     │
Agente → pull/boot/request → sessão vinculada à conexão
                              │ claim + auditoria COMMIT
                              ▼
                         execute/grant
                              │ canal singleton + filtros + schema + nonce/TTL
                              ▼
                       consumo em RAM antes de spawn
                              │ stdin/EOF, Bash ou PowerShell de serviço
                              ▼
                    ack / result / status
                              │ posse domínio/nó/job/token + commit
                              ▼
                          receipt
```

Sem endpoint HTTP novo, fetch de script por ID arbitrário ou substituição de autenticação/CSRF. O modo `direct-control-v1` é restrito a servidor único/build TLS e às premissas de origem de [RUNTIME-CONTRACTS](RUNTIME-CONTRACTS.md). Assinatura RSA não é usada nesta edição.

## Ownership

- `meshtask2.js`: factory inerte, startup/ready, roteamento, configuração, status, integração do timer e hooks de UI/core estável; captura erros de hooks que o upstream não aguarda.
- `lifecycle`: timer unref, single-flight, sondagem de ownership mesmo durante await, barreira síncrona de parada, drain e cleanup aguardáveis.
- `store`: schema v1, foreign keys, FULL, busy timeout, quick_check, BEGIN IMMEDIATE/savepoints e criação privada. Erro não apaga banco nem muda para memória.
- `service`: scripts/revisões, snapshots/alvos, jobs, schedules once/interval UTC, histórico/paginação. Confere atividade após ACL assíncrona.
- `dispatcher`: uma tentativa por job/nó, autorização antes do claim, intenção/auditoria commitadas antes de enviar, timeout/restart/resultado tardio.
- `pull-transport`: sessão vinculada ao objeto agente autenticado/registrado; TTL, capabilities, consumo do pull antes de envio e polls rotativos limitados a 100 nós/ciclo.
- `api/meshcentral`: identidade corrente de administrador e agente, ACL por nó, mensagens limitadas e erro sanitizado. Revalida sessão após await.
- `protocol/validate`: envelope e limites; orçamento do dispatch já reserva campos de binding antes de aceitar snapshot.
- `idempotency/pages`: ledger de mutação administrativa, leitura iterativa e paginação por bytes.
- `modules_meshcore/meshtask2.js`: ES5 dedicado ao Duktape, CSPRNG/hash/relógio conforme fontes oficiais, identidade positiva de canal, dedup em RAM, stdin e captura limitada. Nenhum datastore local ou arquivo de script.
- `ui/native.js`: hooks autocontidos serializáveis por `.toString()`, botão administrativo em p42, ponte sem alterar roteamento nativo, remoção na desconexão/revogação e identidade nova na reconexão.

## Modelo persistente

| Tabela | Invariante |
|---|---|
| scripts/revisions | Revisão atual; revisões e hashes imutáveis |
| jobs/targets | Snapshot completo e alvos congelados; elegibilidade/erro podem mudar |
| attempts | UNIQUE(job_id,node), token aleatório, state/deadline; resultado final imutável |
| events | Append-only; dispatch_claimed inclui domínio/nó, nonces, TTL e digest do envelope |
| schedules/schedule_events | Snapshot congelado, occurrence única, próximo vencimento e auditoria |
| admin_requests | Chave domínio/autor/requestId, hash de operação/input e resposta atômicos |

O ledger é o registro durável de consumo: `claimed` já é autorização consumida, não reserva reabrível. Nonce não depende de SimpleDataStore. Não há migração legada. Alterações desta etapa não mudam o schema v1.

## Estados e falhas

`queued → claimed → acknowledged → succeeded/failed/rejected`; claimed/acknowledged podem ir para `unknown`, que aceita resultado tardio válido. ACK não prova conclusão. Resultado pode anteceder ACK. Primeiro resultado é imutável; conflito tem quota de oito evidências e marcador único.

Falha de persistência impede envio. Falha após claim é ambígua e nunca reinsere na fila. Reinício marca pendências unknown, não reemite grant. Reinício do agente gera novo bootNonce; grant anterior é inválido. Após resultado persistido, receipt libera saída em RAM, preservando tombstone. Se receipt se perde, poll/query reenviam resultado, não execução. Perda da RAM pode perder resultado; consulta not_found não prova ausência de efeitos.

Timeout servidor de 60 s não mata nem cancela. Falha de stdin após spawn fica unknown. O módulo retém referência forte ao filho até exit e só aceita um processo por vez. Códigos e streams dependem do contrato nativo, não de callback Node. Os testes não certificam drenagem/EOF no binário real.

## Scheduler e lifecycle

Timer padrão 1000 ms, configurável entre 100 e 60000 ms. `tick()` manual compartilha single-flight, não enfileira execuções sobrepostas. Cada ciclo expira tentativas, materializa schedules, solicita pulls e despacha. Schedules atrasados são agrupados para uma ocorrência e avançam ao próximo slot; disable do schedule não cancela jobs existentes.

ACL é consultada fora de transação e revalidada; perda de ownership/stop após await impede novo claim. Cada ciclo trata até 100 candidatos; adiamento de 5 s com motivo evita starvation por nós indisponíveis/autor revogado. Falha de banco não é convertida em sucesso.

`pluginHandler.plugins.meshtask2 === plugin` é a identidade da instância viva. Disable upstream remove essa entrada sem cleanup; o timer detecta a perda, para imediatamente e fecha o banco após o ciclo. Reload inicia somente após o close anterior. `ready` captura falhas assíncronas, e `lastError` aparece no status. A aplicação externa pode aguardar `close()` no shutdown; término do processo não implica cancelamento de scripts já iniciados nos endpoints.

## Segurança e escopo

Admin exige siteadmin integral, usuário corrente e socket registrado. Resultado/pull exigem `authenticated === 2` e igualdade com a conexão registrada para o nó. Domínio/nó do envelope não substituem identidade da conexão. O agente exige singleton de controle, rejeita todos os marcadores de usuário/console e schema desconhecido. Túnel 7 com JSON limpo falha pela identidade do parent.

Supõe servidor/core/OS e módulos privilegiados confiáveis; não permite peer/HA ou reflexão de payload por outro plugin. Nonces OpenSSL de 256 bits, hash SHA-256, prazo nominal 10 s e cutoff monotônico conservador aos 9 s. Até 1000 tombstones, sem eviction permissiva. Sem exactly-once de efeitos.

O armazenamento exige POSIX privado; FULL não garante hardware/backup correto. Não retomar de rollback do ledger sem fencing/reconciliação e invalidação dos grants. Quotas globais, rate limiting, retenção, carga e backup/restore homologado permanecem gates externos. Ver [VALIDATION](VALIDATION.md) e [README](../README.md).

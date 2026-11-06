# Validação — 2.0.0-alpha.1

2026-11-06. Validação isolada de software; **não é E2E MeshCentral/MeshAgent nem certificação de produção**.

## Comandos e resultados finais

Ambiente: Node **v22.22.0**, npm **9.2.0**. Módulos nativos, sem dependências instaladas.

```sh
npm test
npm run check
```

| Comando | Resultado observado | Exit |
|---|---|---:|
| npm test | **121 passaram**, 0 falhas, 0 ignorados, 0 cancelados | **0** |
| npm run check | **31 arquivos JS**; sintaxe, versão/config/import, subconjunto ES5 e sinks DOM | **0** |

Aviso experimental de node:sqlite esperado e não ocultado. O gate ES5 não é parser/certificação Duktape. CI definido para outros Nodes não foi acionado no GitHub. Testes não dependem de snapshots de pesquisa ignorados pelo Git.

Sem serviços, stack, instalação, persistência de dados de teste no projeto, acesso a dispositivos, commit/push/tag ou deploy. Bancos são em memória/diretórios temporários removidos pelos testes. Um teste executa Bash local curto com saída fixa e exit 7, sem arquivos de script ou dados persistentes; não é ambiente de execução/deploy do projeto nem MeshAgent real.

## Cobertura

- **Executor VM:** fonte ES5 real, require restrito a stubs das APIs MeshAgent, argv[0], stdin/EOF, stdout/stderr/exit não zero, rejeição de spawn/contexto/interpretador, falha de stdin conservadora, perda de capacidade/RNG/relógio, wrapper PowerShell sem conteúdo na linha de comando.
- **Autenticação/replay:** singleton positivo, parent falso/lookalike/túnel, console e marcadores routeToNode com null/false/zero/vazio, schema extra, hash alterado, domínio/nó/nonce incorretos, expiração monotônica, duplicata antes/depois de término, fresh pull e novo boot, teto de tombstones sem eviction.
- **Captura:** acentos/UTF-8 dividido entre chunks, NUL sanitizado, excesso truncado, limites de envelope e saída, código inválido sem sucesso fabricado.
- **Fluxo real de módulos em processo isolado:** transporte pull + Dispatcher + SQLite + VM; intent/binding/digest já commitados no callback de send; trigger de falha impede entrega; envio ambíguo após spawn não reabre grant; timeout/resultado tardio reconciliado.
- **Plugin/timer:** factory inerte, registro de ownership, ready, timer automático materializa schedule e despacha sem tick manual, single-flight, callback lento, falha/recuperação, disable/reload/close, bloqueio de claim após ACL em andamento e drain antes de fechar banco; modo inválido/peer recusados.
- **Resultado:** receipt somente depois do commit, retry de resultado até receipt, tombstone preservado, resultado repetido/conflitante, quotas, timeout/restart/disconnect sem redispatch. Eventos anteriores permanecem.
- **Base persistente:** scripts/revisões/snapshots imutáveis, idempotência administrativa durável, rollback, autorização de domínio/nó, sessões revogadas, concorrência de conexões SQLite, pagination/bytes, caminhos privados e recusa de symlink/hardlink/corrupção/schema futuro.
- **UI:** exports efetivos do plugin serializados conforme contrato prepExports, startup/p42, admin tardio, esconder para não admin, revogação, logout/reconexão com identidade nova, bridge correlacionada, timeout sem retry, cleanup, navegação, conteúdo hostil somente como texto e DOM que recusa innerHTML.

## Regressões encontradas e corrigidas

A primeira execução da retomada teve 99 testes, 93 aprovados e 6 falhas: cinco expectativas antigas sobre stub/startup/bridge e um defeito real na UI. As expectativas foram atualizadas para o novo contrato (sem retirar controles de segurança); a UI foi corrigida para não reutilizar identidade administrativa em reconexão. O mesmo teste passou depois.

A base já tinha correções de replay administrativo, starvation de fila e amplificação de conflitos registradas no relatório histórico REVIEW. Elas continuam cobertas. Este ciclo acrescentou testes positivos de execução e negativos de origem/nonce, em vez de apenas retirar o gate do transporte.

## Evidência de fonte versus execução

RUNTIME-CONTRACTS demonstra CSPRNG bignum, singleton/canal e alternativas RSA. O modo implementado escolhe o canal positivo restrito, não assinaturas. APIs child_process e stdin vêm de UPSTREAM. Relógio monotônico usa os.uptime no binding ScriptContainer (Linux /proc/uptime; Windows GetTickCount64), com margem conservadora. Fontes não comprovam comportamento do binário instalado.

O teste Bash usa Node para adaptar argv[0] e close drenado à interface simulada MeshAgent. Ele confirma o script/EOF/streams/código em Bash local, **não** o binding Duktape. O PowerShell é validado por stubs/contrato e inspeção de wrapper, não por processo Windows. UI usa DOM/VM, não navegador MeshCentral real.

## Gaps explícitos

- E2E em Windows/Linux com versões/builds identificados, TLS, identidade de parent, module distribution, core reload e ataque via rotas reais.
- PowerShell real: parse/exit/native command policy, stdout/stderr e encoding; MeshAgent: EOF, backpressure, saída após término, Unicode, sinais e processo filho/árvore.
- Sessão gráfica/wallpaper e cancelamento não implementados. Timeout não cancela.
- Servidor único; sem HA/peer ou auditoria de reflexões de outros plugins privilegiados. Assinatura RSA ainda não implementada.
- Limite de 1000 tombstones requer manutenção planejada; reboot pode perder resultado, nunca permite retry cego. Retenção global/rate limiting/frota com milhares de nós ainda não homologados.
- Disco cheio físico, energia, fsync/hardware, corrupção/backup/restore, fencing após rollback e processos independentes não exercitados. SQLite FULL e triggers de falha são apenas evidência local.
- Sem ACL de armazenamento Windows (startup em disco recusado), pacote remoto/release/deploy ou CI executado.

Próxima validação exclusivamente em laboratório dedicado autorizado no BAYIT/VPS, seguindo ACCEPTANCE. Não executar stack no container Agent Zero. Nada nesta entrega declara a matriz E2E aprovada.

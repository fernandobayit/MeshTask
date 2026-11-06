# Plano e conclusão de software — MeshTask 2

Atualizado em 2026-11-06. Produto de Fernando Lima; reescrita clean-room, sem migração/compatibilidade legada, sem apagar instalação antiga. Versão mantida em **2.0.0-alpha.1**.

## Escopo implementado

1. **Executor:** módulo ES5 separado do Node, Bash/Linux e PowerShell/Windows por stdin/EOF, serviço somente, captura limitada e código real de término. Autenticação positiva do canal de controle com filtros/schema, nonces de boot/pull, hash, TTL monotônico e consumo antes de spawn. Capacidade ausente recusa explicitamente.
2. **Persistência/orquestração:** SQLite privado, revisões/snapshots imutáveis, alvos explícitos, uma tentativa por job/nó, intenção e binding commitados antes de send, ACK separado, timeout/restart/ambiguidade unknown, resultado tardio e receipts. Nunca reemitir execução consumida.
3. **Scheduler:** once/interval UTC automático, single-flight, coalescência de atrasos, autorização revalidada, ownership observado e cleanup/reload aguardáveis. Tick manual permanece apenas alternativa diagnóstica, não requisito operacional.
4. **Administração/UI:** API admin-only, isolamento domínio/nó, mutações idempotentes, histórico paginado, UI PT-BR, botão e loader em Plugins/p42, bridge pelo controle autenticado, nova identidade após reconexão.
5. **Testes/docs:** VM MeshAgent, integração isolada dos módulos, timer/UI, um Bash local curto, contratos e instruções atualizadas. **121 testes, exit 0; check de 31 arquivos JS, exit 0.**

## Invariantes preservados

- Claim COMMIT antes do envio; consume antes de spawn. Sem exatamente-uma-vez de efeitos externos.
- ACK não é sucesso; timeout não é cancelamento; not_found não prova ausência de efeito.
- Mesmo executionId não ganha novo grant após erro, reboot ou expiração.
- Resultado tardio não apaga eventos anteriores; primeiro resultado é imutável; conflitos têm quota.
- Conteúdo/revisão/contexto/alvos congelados. Nenhum fetch arbitrário ou interpretação de identidade fornecida pelo cliente.
- Scripts por stdin sem temporários; runtime Duktape não pressupõe API Node.
- Execução padrão disabled; direct-control-v1 exige servidor único/TLS e premissas documentadas. Sem fallback para configuração insegura.

## Fora desta entrega / gates restantes

**Homologação e distribuição pendentes, não substituídas pelos testes locais.**

- Escolher laboratório dedicado autorizado no BAYIT/VPS, com MeshCentral e endpoints Windows/Linux; registrar versões e executar ACCEPTANCE, inclusive caminhos console/routeToNode/túnel reais, stdin/EOF/backpressure, Unicode, código não zero, retorno tardio e core reload.
- Avaliar política PowerShell e encoding nativo em Windows real. UI/loader ainda requerem conferência visual no host.
- Sessão de usuário/wallpaper, cancelamento confirmado/kill de árvore, cron/DST, HA/peer e RSA são extensões não implementadas.
- Rate limiting/retenção globais, paginação integral de biblioteca/frota, carga hostil, backup/restore/fencing, disco cheio/energia e ACL servidor Windows exigem trabalho próprio.
- Distribuição futura segue GitHub + ghcr.io + docker-compose em ambiente do usuário, não stack Agent Zero. Nenhuma URL/release/tag inventada.

Commit local autorizado será realizado pelo agente principal após revisão; este workstream não alterou Git, fez commit/push/deploy nem deixou trabalho externo prometido em segundo plano. Não afirmar production-ready ou E2E concluído. Consulte README, STATUS, ARCHITECTURE, PROTOCOL e VALIDATION para o contrato vigente; REVIEW é histórico.

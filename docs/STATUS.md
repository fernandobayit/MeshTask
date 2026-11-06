# Estado — MeshTask 2

Atualizado em 2026-11-06. Responsável pelo produto: Fernando Lima. Versão: **2.0.0-alpha.1**.

## Entrega de software

Executor real implementado em código ES5 MeshAgent para Bash/Linux e PowerShell/Windows, por stdin, sem temporários. Há caminho funcional de execução: o módulo não é mais um stub de recusa universal. Configuração padrão mantém dispatch desativado; `direct-control-v1` habilita o modo restrito a servidor único/TLS e contratos upstream documentados.

Autenticação usa identidade positiva do singleton MeshAgent, comprovada no binding C, mais rejeição de console/routeToNode/túnel, schema fechado, hash e boot/request nonce CSPRNG. Não usa somente ausência de campos, token ou marcador server. Não implementa assinatura RSA; a alternativa de canal positivo foi escolhida sob premissas explícitas. Ver README e RUNTIME-CONTRACTS.

Ledger servidor registra intenção/binding/digest e confirma COMMIT antes de send; agente consome nonce/tentativa antes de spawn. Não há reenvio automático da execução após ambiguidade, restart ou timeout. Resultado tardio reconcilia unknown; receipt vem depois do commit, permitindo retry apenas de resultado.

Scheduler automático single-flight, revalidação de ACL, parada ao perder ownership, close aguardável e reload que drena instância anterior integrados. UI nativa com botão em Plugins/p42 e loader automático integra os exports reais; reconexão exige identidade nova. Persistência/idempotência/domínios e quotas da base anterior foram preservados.

## Verificação final observada

- Node **v22.22.0**, npm **9.2.0**.
- `npm test`: **121 passaram**, 0 falhas, 0 ignorados/cancelados; **exit 0**.
- `npm run check`: **31 arquivos JS**, sintaxe/config/import/ES5 conservador/DOM; **exit 0**.
- Testes de VM MeshAgent com stubs explícitos, integração SQLite/transporte/plugin/timer, DOM simulado e um subprocesso Bash local curto via adaptador de teste. Sem serviços ou stack.
- Sem instalação de dependências, dispositivo remoto, deploy, publicação, commit, push ou alteração do Git por este workstream. Commit autorizado é responsabilidade do agente principal.

## Limites e gates restantes

1. **Nenhum E2E MeshCentral/MeshAgent real.** Duktape, PowerShell real, loader visual, bind do canal no binário instalado, stdin/EOF/backpressure/drenagem, encoding Windows e atualização/restart de core exigem laboratório dedicado autorizado.
2. **Alpha, não production-ready.** Modo direto confia em servidor/core/OS/plugins privilegiados; não usar peer/HA ou plugins que reflitam mensagens de usuário em comando limpo. Build TLS/API compatível obrigatório.
3. Contexto serviço somente. Não implementados sessão de usuário/wallpaper, cancelamento/kill de árvore, cron/DST, migração legada ou distribuição remota versionada.
4. Um processo ativo e 1000 tombstones por contexto; limite recusa novos grants. Saída limitada a 8192 bytes por stream. Reboot perde resultados não confirmados, não autoriza retry de execução. Timeout não encerra processo.
5. Rate limiting/retenção globais, carga, falha física de disco/energia, backup/restore/fencing, múltiplos processos e ACL de servidor Windows permanecem fora da validação.
6. CI existe, não foi executado no GitHub. Nenhum alvo remoto escolhido nem instalação antiga modificada.

## Documentação

README, ARCHITECTURE, PROTOCOL, PLAN e VALIDATION descrevem o código atual. EXECUTOR-DESIGN/UPSTREAM receberam notas de implementação; REVIEW continua relatório histórico. RUNTIME-CONTRACTS e ACCEPTANCE permanecem evidências/matriz externa, não registro fictício de homologação.

## Revisão final pré-commit

Em 2026-11-06, revisão independente estática do executor, transporte pull, protocolo, dispatcher, persistência e lifecycle não encontrou bloqueadores concretos para o commit desta alpha. Foram examinados origem positiva do canal, bloqueios console/túnel/routeToNode, consumo de nonce antes de spawn, commit antes do envio/receipt e drenagem no fechamento. A conclusão é restrita ao modelo servidor único/TLS e componentes privilegiados confiáveis; não constitui homologação de produção.

Fernando Lima autorizou finalizar e fazer o commit. Em 2026-11-06, também autorizou o push da branch `rewrite/v2` para o repositório GitHub do projeto; nenhuma alteração em `master`, release, tag ou deploy faz parte desta operação.

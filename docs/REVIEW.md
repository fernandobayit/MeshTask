# Revisão independente de segurança — MeshTask 2

> **Nota de vigência — 2026-11-06:** relatório histórico, anterior ao executor/lifecycle atuais; não representa aprovação independente do código novo. Referências ao stub/bloqueio universal descrevem a versão então revisada. O estado vigente é README/STATUS/VALIDATION. Replay administrativo e quota de conflitos continuam corrigidos e testados. O modo direct-control-v1 usa identidade positiva comprovada em RUNTIME-CONTRACTS, não autorização por campos ausentes. Foram executados testes locais, não E2E nem auditoria independente posterior. Manter alpha até os gates externos.

Data: 2026-11-04. Revisão estática para Fernando Lima e agente integrador.

## Escopo e conclusão

Lidos AGENTS.md, docs/UPSTREAM.md, docs/PLAN.md, os módulos servidor/agente e UI solicitados, além de trechos dos snapshots upstream locais. Nenhuma suíte, processo de aplicação, dependência, rede, dispositivo, commit ou deploy foi executado. Somente este documento foi escrito. O diretório não apresentou metadados Git; referências abaixo são linhas observadas durante a revisão, com implementação paralela ainda em andamento.

**Não identifiquei bloqueador crítico de execução indevida alcançável no alpha com executor bloqueado.** Não equivale a homologação. `lib/meshcentral.js:45-47` impede dispatch real; `modules_meshcore/meshtask2.js:6-10` apenas retorna recusa e não inicia processos. Esses gates não podem ser removidos com base nesta revisão.

Dois achados concretos devem ser tratados antes de liberar execução. O primeiro já duplica registros administrativos; o segundo requer tentativa válida/token conhecido, condição não produzida pelo transporte bloqueado atual. Não são duas vulnerabilidades de execução remota já exploráveis no alpha.

## 1. Replay administrativo cria jobs e agendamentos adicionais

**Prioridade:** bloqueador de habilitação de execução não idempotente; duplicação de registros já presente no alpha.

**Locais:** `lib/api.js:13-29`; `lib/service.js:33-42,68-76`; `lib/store.js:39-43`.

**Raciocínio/reprodução proposta, não executada:** com a mesma sessão administrativa válida, enviar duas vezes o mesmo envelope `jobs.create`, incluindo o mesmo `requestId` e mesmo input. A API só valida o formato de `requestId`; não o consulta nem persiste. Cada passagem chama `insertJob`, gera outro UUID e insere outro job. Em `schedules.create`, cada passagem também gera outro UUID. Duas chamadas concorrentes e replay após restart têm o mesmo efeito. A restrição `UNIQUE(job_id,node)` impede duas tentativas do mesmo job, mas não duas execuções decorrentes de dois jobs criados pelo mesmo pedido. A unicidade de ocorrência do scheduler também não protege dois schedules distintos.

**Impacto:** após resposta perdida/reenvio do mesmo pedido, uma única intenção administrativa pode resultar em duas execuções ou duas séries recorrentes quando o executor for habilitado. A ponte atual não faz retry automático (`ui/bridge.js:20-26`), o que reduz exposição, mas não transforma a API em idempotente. Não é bypass de admin/domínio.

**Correção indicada:** deduplicação durável e transacional por domínio/ator/requestId para mutações, vinculada ao hash do input e à operação; devolver o resultado anterior para repetição idêntica e rejeitar reutilização com conteúdo diferente. Persistir a chave junto com a criação do job/schedule, não apenas em memória. Definir retenção que preserve a proteção de pedidos antigos.

**Evidência:** caminho determinístico de código; não depende de MeshAgent real para confirmar a duplicação de registros. O efeito duplicado no endpoint é condicional à futura habilitação e exige teste dedicado.

## 2. Conflitos de resultado sem quota permitem crescimento de disco e amplificação de memória

**Prioridade:** bloqueador de habilitação de ingestão real de resultados de agentes não confiáveis; não alcançável por agente sem tentativa/token válido no alpha atual.

**Locais:** `lib/dispatcher.js:64-85`; `lib/protocol.js:11-16`; `lib/service.js:62-66`; `meshtask2.js:48-50`; `lib/store.js:42,66-67`.

**Raciocínio/reprodução proposta, não executada:** dado um agente autenticado dono de uma tentativa com token correto e resultado final salvo, enviar novos `result` válidos variando um caractere de stdout. Cada digest diferente gera outro evento `result_conflict`, com stdout/stderr completos; não há quota de conflitos por tentativa, orçamento de bytes ou limitação de frequência. Cada saída aceita até 32 KiB por stream. Mil conflitos com streams perto do limite representam aproximadamente 62,5 MiB de texto de saída, fora JSON e objetos. O total persistido pode continuar crescendo sem limite de eventos.

`jobs.get` carrega até 1.000 eventos com dados completos, converte-os em objetos e serializa a resposta inteira no processo MeshCentral. Portanto o limite de entrada de 192 KiB não é limite de memória/bytes por resposta; uma única consulta pode materializar dezenas de MiB e várias cópias. O limite de 32 requests pendentes na ponte é somente cliente e não protege o servidor.

**Impacto:** agente comprometido que já recebeu autorização para uma tentativa pode consumir disco, bloquear o event loop com gravações/serializações e pressionar memória do servidor e navegador administrativo. A identidade e o token corretamente verificados restringem quem chega ao caminho; não restringem seu volume. Não há necessidade de forjar token de outro nó.

**Correção indicada:** orçamento durável por tentativa para conflitos e bytes de auditoria; registrar digest/metadados e contador limitado em vez de repetir toda a saída indefinidamente, preservando a primeira evidência. Paginar eventos com limite de bytes por resposta; aplicar limites de ingestão e de consultas por identidade/domínio. Não resolver descartando silenciosamente o primeiro resultado tardio legítimo.

**Evidência:** crescimento e agregação são verificáveis por leitura do código. Esgotamento efetivo de memória/disco, throughput e impacto no runtime exigem teste de carga isolado autorizado; não foram medidos. O transporte atual não cria as tentativas necessárias para exploração normal pelo agente.

## Fronteiras verificadas sem achado bloqueador

- **routeToNode:** o upstream `MeshCentral--meshuser.js:5103-5112` realmente desvia de `serveraction`, e o roteamento genérico permite view-only/remote-control em `:278-323`. A rejeição de `routeToNode` na API isoladamente não resolveria isso. No código atual o módulo agente não executa nada por nenhum desses caminhos; não há bypass de execução demonstrado.
- **consoleaction / parent / session:** upstream possui assinaturas diferentes. O stub atual não usa parent, rights, sessionid ou ausência deles como autorização e não chama SendCommand. Isso é fail-closed, não implementação de autenticação de dispatch.
- **Admin/domínio/nó:** `lib/meshcentral.js:4-15,17-41` usa sessão registrada, usuário corrente, siteadmin, domínio e conexão agente autenticada/registrada. Targets passam por ACL no servidor. Não identifiquei caminho confiando no userid/nodeid fornecido pelo cliente para essas identidades.
- **Token e resultado:** `lib/dispatcher.js:67-69` vincula tentativa, job, nó e domínio antes de comparar token de 32 bytes. Resultado idêntico é idempotente, conflito não sobrescreve o primeiro resultado e ACK tardio não regride terminal (`:70-90`).
- **SQLite claim-before-send:** transação síncrona `BEGIN IMMEDIATE`/COMMIT, unicidade `(job_id,node)` e evento de claim antes de send (`lib/store.js:41,61-64`; `lib/dispatcher.js:11-33`). Falha ambígua e recuperação passam a unknown, sem nova tentativa automática (`:34-57`).
- **Resultados tardios:** unknown aceita resultado final preservando eventos anteriores e anotando `late` (`lib/dispatcher.js:81-90`).
- **HTML:** nomes, erros, scripts e saídas chegam a `textContent`, inclusive detalhes em pre (`ui/admin.js:57-60,101-104,268-275`). Não identifiquei sink de HTML executável nos arquivos revisados.

## Hipóteses/gates que continuam exigindo E2E

- Não existe executor nem dedup persistente de execução no agente nesta versão. Não alegar proteção contra replay após restart do MeshAgent com base apenas no ledger do servidor.
- Antes de implementar execução, fechar autorização não forjável pelo routeToNode, vinculada ao nó/conteúdo/tentativa/validade. Token de correlação ou ausência de sessionid não bastam.
- Validar instalação do plugin, exportação da UI e assinaturas reais dos hooks na versão MeshCentral escolhida; os snapshots não comprovam compatibilidade do ambiente instalado.
- Validar perda de conexão, crash/restart, queda durante commit, comportamento do disco, resultado tardio e efeitos de script no runtime real. Leitura estática não prova durabilidade física ou exactly-once.

**Decisão recomendada ao integrador:** alpha pode ser descrito apenas como núcleo administrativo/persistente com execução explicitamente bloqueada, sujeito aos testes do implementador. Não apresentar como executor operacional, homologado ou pronto para produção. Corrigir os dois achados antes de remover os gates e completar a matriz E2E em laboratório autorizado.

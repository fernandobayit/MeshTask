# MeshTask — ScriptTask Runner (plugin MeshCentral)

> Agendamento e execução de **scripts (bash / bat / ps1)** em endpoints gerenciados pelo MeshCentral — com persistência SQLite, targeting dinâmico por filtros e administração 100% admin-only.

![version](https://img.shields.io/badge/version-1.0.1-blue) ![meshcentral](https://img.shields.io/badge/MeshCentral-%3E%3D1.1.35-green) ![tests](https://img.shields.io/badge/tests-94%20checks-brightgreen)

## Visão geral

MeshTask é um plugin do MeshCentral que permite:

- **Executar scripts** (`.sh`, `.bat`, `.ps1`) em 1 ou N dispositivos — manualmente ou agendados;
- **Comandos ad-hoc por filtro**: rodar um comando em toda a frota que case com um filtro dinâmico, sem salvar script na árvore (script efêmero, auto-limpo);
- **Agendamentos recorrentes** (once / minutes / hourly / daily / weekly) com janela de validade (`startAt`/`endAt`) e dias da semana;
- **Filtros dinâmicos re-avaliados a cada dispatch** — um agendamento com filtro sempre atinge o estado ATUAL da frota;
- **Variáveis em 4 escopos** (global / script / mesh / node) interpoladas no momento do despacho;
- **Histórico completo** de jobs por nó, por script e por agendamento, com returnVal/errorVal e exit codes reais.

Todo o ciclo usa **uma única serveraction** (WS + sessões de agente), persistência **SQLite** (com migração automática do NeDB legado) e guardas admin-only.

## Instalação

**Requisitos:** MeshCentral `>= 1.1.35` (o driver `sqlite3` usado pelo plugin é o mesmo que o core MeshCentral já embala em `node_modules`).

No MeshCentral: **My Server → Plugins → Adicionar plugin** e aponte o plugin para este repositório (o MeshCentral lê o `config.json` e a lista de tags do GitHub).

URLs do plugin:

| Campo | URL |
| --- | --- |
| configUrl | `https://raw.githubusercontent.com/fernandobayit/MeshTask/master/config.json` |
| changelogUrl | `https://raw.githubusercontent.com/fernandobayit/MeshTask/master/changelog.md` |
| versionHistoryUrl | `https://api.github.com/repos/fernandobayit/MeshTask/tags` |
| downloadUrl | `https://github.com/fernandobayit/MeshTask/archive/refs/tags/v1.0.1.zip` |

> O fluxo de update do MeshCentral consulta essas URLs **anonimamente** — o repositório deve estar **público**.

**Instalação manual:** baixe o zip da tag e descompacte em `meshcentral-data/plugins/` (gera a pasta `scripttask/`), depois reinicie o MeshCentral.

## Filtros de dispositivos

O engine de targeting (`targeting.js`) implementa a mesma linguagem de busca do MeshCentral, server-side. Exemplos:

```
webserver01             → nome do dispositivo (substring)
os:linux                → osdesc contém 'linux'
g:servers               → nome do grupo (mesh) 'servers'
t:prod                  → tag 'prod'
a:financeiro            → agent tag
desc:sistema            → descrição do nó
ip:10.0.1.5             → IP
u:jose                  → usuário do dispositivo
c:agent                 → conectividade (agent/cira/amt/relay/mqtt/local)
c:online, c:offline     → online/offline agora
wsc:ok                  → Windows Security Center
*                       → dispositivos marcados com estrela
t:prod and os:linux     → interseção
os:linux or os:windows  → união
!t:homolog and c:agent  → negação combinada
```

Filtros só são aceitos se passarem pelo validador (prefixos e valores conhecidos — ex.: `c:` só aceita os estados definidos).

## Variáveis

Defina variáveis nas abas do plugin (escopos: **global**, **script**, **mesh** e **node** — a ordem de precedência é node > mesh > script > global) e use nos scripts:

```
echo "Deployando em #GBL:nodeId# por #GBL:runBy#"
```

`#GBL:nodeId#`, `#GBL:runBy#` e `#GBL:meshId#` são injetados automaticamente. Placeholders não resolvidos viram `VAR_NOT_FOUND`.

## Arquitetura

```
scripttask.js                 núcleo server-side: serveraction unificada, fila,
                              timeouts, agendamentos, HTTP (view/download)
db2.js                        persistência SQLite (tabela docs; migração NeDB;
                              serial queue de escritas; WAL + busy_timeout)
targeting.js                  parser/validator/matcher dos filtros do MeshCentral
modules_meshcore/scripttask.js  módulo executado DENTRO do agente (meshcore):
                              cache de scripts, execução bash/bat/ps1,
                              interpolação de variáveis, jobComplete
views/user.handlebars         UI admin (árvore de scripts/folders, agendas,
                              variáveis, histórico, preview de filtro)
```

Decisões-chave:

- **Admin-only:** sessões de usuário exigem `siteadmin === 0xFFFFFFFF`; sessões de AGENTE só podem chamar `getScript`/`jobComplete`/`clearAllPendingJobs`;
- **Eventos** do plugin são entregues apenas a admins conectados (sem broadcast);
- **Job timeout** de 180 s e expiração de jobs nunca-despachados após 7 dias de elegibilidade;
- **Dispatch pacing:** no máximo 250 jobs despachados por ciclo (frota grande não satura);
- **Scripts efêmeros** (comandos ad-hoc) são criados no despacho e apagados quando o ÚLTIMO job conclui;
- Scripts e saídas são gravados em arquivos temporários com `PID` no nome e modo `0600`;
- Histórico preserva exit codes reais (`exit=N`).

## Testes

```bash
node test_targeting.js      # 46 checks — linguagem de filtros
node test_schedule.js       # 11 checks — agendamentos
node test_serveraction.js   # 20 checks — ações server + guards + eventos
node test_fixes.js          # 17 checks — regressões dos fixes v1.0.1
node test_db2.js           # exige driver sqlite3 (roda dentro de um MeshCentral)
```

`test_schedule.js` e `test_serveraction.js` resolvem o módulo pelo caminho de instalação do plugin (`/opt/data/mct2/scripttask.js`); ajuste o require se rodar em outro host.

## Changelog

Veja [changelog.md](changelog.md).

## Licença

Apache-2.0 (herdada do projeto original).

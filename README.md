# MeshTask 2 — 2.0.0-alpha.1

Reescrita clean-room para Fernando Lima. Plugin/export novo: **`meshtask2`**. Sem copiar código da versão antiga, migrar seus dados ou modificar sua instalação.

> **Executor Bash/Linux e PowerShell/Windows implementado, com autenticação de canal, pull/nonce e claim durável; scheduler automático e UI nativa integrados. Alpha não homologado em MeshCentral/MeshAgent real. Execução desativada por padrão, habilitável apenas no modo restrito documentado abaixo.**

## Implementado

- SQLite próprio, transacional, `synchronous=FULL`, revisões imutáveis e snapshot de conteúdo/alvos por job.
- Administração restrita a administrador corrente do domínio, socket registrado e ACL de cada nó; mutações idempotentes por domínio/autor/requestId.
- Grant vinculado a bootNonce/requestNonce, domínio/nó e conteúdo congelado. Commit de tentativa/auditoria antes de enviar; consumo no agente antes de spawn.
- Bash `/bin/bash --noprofile --norc -s` e PowerShell do Windows via stdin, sem temporário e sem script na linha de comando. Contexto de serviço exclusivamente.
- Captura limitada de stdout/stderr, EOF explícito e código real do evento de término. ACK não é sucesso. Timeout, erro de transporte e ambiguidade não autorizam retry de execução.
- Resultados tardios, retry de resultado até receipt persistido, conflitos limitados e auditoria imutável. Reinício não reabre tentativas já consumidas.
- Scheduler `once`/`interval` UTC automático, single-flight, autorização revalidada, cleanup após disable/reload e shutdown aguardável.
- Botão **Abrir MeshTask 2** na página nativa **Plugins** (`p42`) para administradores; UI PT-BR, ponte correlacionada, histórico paginado, limpeza no logout/reconexão. Nenhuma rota HTTP adicional.

## Requisitos e modo de confiança

Servidor: **Node >=22.13**, `node:sqlite`, POSIX, diretório privado próprio 0700 e banco 0600, sem symlink/hardlink. O plugin não cria o diretório nem instala dependências. Armazenamento em servidor Windows é recusado até haver contrato ACL validado.

Agente: build TLS compatível com os contratos em [RUNTIME-CONTRACTS](docs/RUNTIME-CONTRACTS.md), módulos `MeshAgent`, `bignum`, `SHA256Stream`, `os`, `fs`, `child_process`, Buffer e timers. Linux requer `/bin/bash`; Windows usa `windir` do serviço e `System32/WindowsPowerShell/v1.0/powershell.exe`. Ausência de capacidade ou entropia mantém o executor fechado, sem fallback Node/Math.random.

**Modo entregue: `direct-control-v1`, servidor único, sem peer/HA.** A origem deve ser o mesmo objeto singleton `require('MeshAgent')`, conforme binding C comprovado. Também são recusados argumentos posicionais de console e a presença de `_`, `sessionid`, `fromSessionid`, `userid`, `rights` e `routeToNode`, mesmo com null/zero/false. O túnel 7 não passa na identidade de objeto. Schema fechado e nonces são barreiras adicionais; ausência de campos e token de tentativa **não** são autenticação isoladamente.

Este modo confia no servidor/core/OS e nos módulos privilegiados. Não protege contra outro plugin privilegiado que reflita conteúdo de usuário em comando de controle limpo ou contra JavaScript já comprometido no heap. Conferir os contratos ao atualizar MeshCentral/MeshAgent. **Grants RSA estão documentados como alternativa, mas não implementados neste modo.** Não usar esta edição em topologia distribuída ou fora dessas premissas.

## Configuração para futura integração autorizada

O loader usa `require(.../meshtask2/meshtask2.js).meshtask2(pluginHandler)`. O diretório do plugin deve conter todos os arquivos de produto, inclusive `modules_meshcore/meshtask2.js` e `ui/`. `config.json` é metadado de integração local (`settings.plugins.list`), não manifesto de release remoto; nenhuma URL foi inventada.

Exemplo de configuração **não aplicado nesta entrega**:

```json
{
  "settings": {
    "plugins": { "list": ["meshtask2"] },
    "meshtask2": {
      "database": "/var/lib/meshtask2/state.sqlite",
      "executionMode": "disabled",
      "intervalMs": 1000
    }
  }
}
```

Somente em laboratório dedicado autorizado, após conferir TLS/contratos e controles de origem, trocar `executionMode` por `direct-control-v1`. Não existe habilitação por comando de usuário. A omissão equivale a `disabled`; qualquer outro valor falha. Peer/HA detectado impede esse modo.

O scheduler inicia em `server_startup()`, mesmo com execução desativada, e materializa schedules sem executá-los. A factory é inerte. Startup assíncrono tem `plugin.ready`, com falhas contidas e `lastError`; `plugin.tick()` aguarda ready e compartilha o single-flight do timer. `await plugin.close()` bloqueia novos despachos imediatamente e fecha o banco após o ciclo em andamento. A perda da instância em `pluginHandler.plugins` é detectada automaticamente; reload aguarda fechamento da instância anterior.

`hasAdminPanel:false` indica ausência de rota HTTP própria; **não ausência de UI**. O hook WebUI exportado insere o botão em Plugins e monta o painel pelo canal autenticado já existente. `ui/admin.html` é apenas demonstração isolada; não autentica nem se conecta sozinho.

## Semântica do executor

- **Bash:** status da última instrução/`exit`; não acrescenta `exit 0` nem impõe `set -e`.
- **PowerShell:** conteúdo UTF-8 em base64 dentro de wrapper enviado por stdin. Faz parse do script inteiro, dot-source no mesmo escopo, `ErrorActionPreference='Stop'`, captura erro no stderr e usa exit 1; preserva `exit` explícito e verifica `$LASTEXITCODE`. Um script autorizado pode mudar sua própria política. Comportamento real do Windows ainda exige homologação.
- **Saída:** primeiros 8192 bytes por stream; acumulação antes de decodificar preserva UTF-8 entre chunks. NUL vira U+FFFD; bytes UTF-8 inválidos são substituídos. `truncated` informa corte. Não é canal binário, e programas nativos Windows com outro encoding exigem avaliação no laboratório.
- **Freshness:** nonces de 256 bits via OpenSSL `bignum.random`, em string decimal. TTL nominal de 10 s, timer e relógio monotônico `os.uptime()`, com corte conservador aos 9 s por resolução de segundos. Novo contexto gera novo bootNonce.
- **Retenção:** um processo ativo por módulo, até 1000 tombstones por contexto. Receipt libera saída, não o identificador. Capacidade esgotada recusa novos grants; recuperação planejada exige aguardar/reconciliar processos e recarregar o core para obter nonce novo, nunca evictar IDs permissivamente.
- **Timeout:** servidor marca `unknown` após 60 s; não cancela nem mata. Processo longo mantém o nó ocupado e pode retornar resultado tardio. Falha de stdin após spawn é incerta, mesmo com exit zero.

Uma execução consumida nunca é reenviada automaticamente, nem após reinício. Perda entre commit e spawn pode resultar em não execução/`unknown`. Isso não é exactly-once de efeitos shell. Uma nova intenção administrativa pode repetir efeitos; operador deve reconciliar antes.

## Verificação local

Sem dependências npm e sem `npm install`:

```sh
npm test
npm run check
```

Resultados e contagens finais: [VALIDATION](docs/VALIDATION.md). Testes usam SQLite isolado, VM com stubs explícitos MeshAgent, DOM simulado e um subprocesso Bash curto sem dados persistentes. Não há stack, serviço ou dispositivo remoto utilizado. PowerShell real/Duktape e loader visual não foram executados. CI está definido, mas não foi acionado no GitHub.

## Limites para produção

Sem cancelamento/kill de árvore, sessão do usuário/wallpaper, cron/DST, HA, migração legada, publicação ou deploy. Listas principais limitadas a 200 registros; detalhes de job paginados. Faltam rate limiting e retenção globais, carga hostil, backup/restore e quedas reais. **Não restaurar ledger antigo e retomar dispatch silenciosamente**: manter disabled, invalidar sessões/grants e reconciliar antes. SQLite não é criptografado; proteger volumes/backups.

## Documentação

[Estado](docs/STATUS.md) · [Plano](docs/PLAN.md) · [Arquitetura](docs/ARCHITECTURE.md) · [Protocolo](docs/PROTOCOL.md) · [Validação](docs/VALIDATION.md) · [Upstream](docs/UPSTREAM.md) · [Runtime](docs/RUNTIME-CONTRACTS.md) · [Desenho de segurança](docs/EXECUTOR-DESIGN.md) · [Aceite externo](docs/ACCEPTANCE.md) · [Revisão histórica](docs/REVIEW.md)

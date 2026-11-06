# Contratos práticos de autenticação no MeshAgent

## Decisão executiva

**Há API nativa suficiente para implementar agora; não há homologação do binário instalado nesta entrega.** Pesquisa delimitada em 2026-11-05, somente fontes oficiais fixadas, sem dependências, serviços, deploy ou execução em dispositivo. Nenhum código do executor foi alterado.

1. **Preferido: RSA PKCS#1 v1.5 + SHA-256.** Importar certificado público X.509 DER com `tls.loadCertificate({der: buffer})`; calcular o digest com `SHA256Stream.create().syncHash(bytes)`; verificar com `RSA.verify(RSA.TYPES.SHA256, certificado, digest, assinatura) === true`. Não usar a API `crypto.createVerify` de Node no agente.
2. **Identidade positiva comprovada no C:** no caminho normal do controle, o quarto argumento de `consoleaction` é o singleton retornado por `require('MeshAgent')`. `parent === mesh` fecha o túnel 7 conhecido, mas **sozinho não fecha console nem routeToNode**. A alternativa sem assinatura exige também filtros e as premissas restritas da seção 4.
3. **Nonce CSPRNG com falha reportada:** usar `require('bignum').random(limite2Elevado256).toString()`. O binding chama `BN_rand_range` e lança erro se retornar zero. Preservar como string decimal; não converter para Number. É alternativa real à chamada `randomBytes` não comprovada nesta pesquisa.
4. **Não aprovar `Buffer.randomFill()` como caminho fail-closed:** em build TLS chega a `RAND_bytes`, mas seu retorno é ignorado; em build `MICROSTACK_NOTLS` chega a `rand()` sem segurança criptográfica. Não usar `Math.random`, relógio, GUID presumido seguro ou fallback silencioso.

Estes contratos refinam [UPSTREAM.md](UPSTREAM.md) e resolvem a lacuna de bindings indicada em [EXECUTOR-DESIGN.md](EXECUTOR-DESIGN.md). Permanecem obrigatórios o ledger servidor com commit antes do grant, consumo único, vínculo com boot/pull, prazo local e nenhuma reemissão automática do mesmo executionId.

## 1. Versões e evidências reproduzíveis

- **MeshAgent:** commit `0e6b4f7fea6c88ad1978206550d202a7f33741c5`.
- **MeshCentral:** commit `2e7ec138cf45b09204bf036b500e5e2cf37aaba4`.
- Snapshots em `docs/upstream-evidence/`; nome local `MeshAgent--` seguido do caminho com `/` substituído por `__`.
- As nove fontes MeshAgent obtidas neste ciclo foram comparadas ao `MeshAgent-tree.json` local: **9/9 blobs Git SHA-1 correspondentes**. Isso verifica integridade dos snapshots em relação à árvore registrada, não correspondência com produção nem assinatura do release.

| Arquivo MeshAgent | Git blob SHA-1 verificado |
| --- | --- |
| `meshcore/agentcore.c` | `575d86dfcc75f7b2e3218398b23856769267db82` |
| `microscript/ILibDuktape_SHA256.c` | `4774a5406f4be15d8d4e8d90729646361a113165` |
| `microscript/ILibDuktape_net.c` | `7dc783adecf3ea0db3acb7ce444f424975f1d0cb` |
| `microscript/ILibduktape_EventEmitter.c` | `681bbbaac505792781f42ad27b54445bb6574ed3` |
| `microscript/ILibDuktape_Polyfills.c` | `d1ea610b01483a6bfd433654a702d38f7830ceff` |
| `microstack/ILibCrypto.c` | `498e3cdff6cd039b4295dd274255c48d4a660df1` |
| `microscript/ILibDuktape_ScriptContainer.c` | `c07c12f41d065b62d6d08b4161c16083b811df60` |
| `microscript/ILibDuktapeModSearch.c` | `7b124291c19cc3b4d68729884872abe7fba31c51` |
| `microscript/ILibDuktape_EncryptionStream.c` | `8e8186e4598bb7096488c1bd3c9fb6513ea808c3` |

Os dois últimos arquivos foram consultados para localizar APIs; os contratos positivos abaixo vêm dos bindings específicos, não de inferência pelo nome EncryptionStream.

## 2. RSA/SHA-256: chamada correta e importação

### Prova por fonte

- [SHA256.c L386–413](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_SHA256.c#L386-L413): argumento 1 contém o `util_cert` nativo; argumentos 2 e 3 são buffers; obtém RSA de `cert->x509` e chama `RSA_verify(tipo, digest, digestLen, signature, signatureLen, rsa)`. Retorna booleano `vstatus == 1`. Exporta `verify` e `TYPES.SHA256 = NID_sha256`.
- [SHA256.c L416–433](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_SHA256.c#L416-L433): `syncHash` calcula SHA-256 e devolve Buffer de 32 bytes. [L691–696](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_SHA256.c#L691-L696) exporta `create`; [L718–733](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_SHA256.c#L718-L733) registra módulos `RSA` e `SHA256Stream`, sendo RSA condicionado a TLS.
- [net.c L2811–2858](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_net.c#L2811-L2858): `tls.loadCertificate` aceita `der`/`cer` ou `pfx` com passphrase. Para chave pública, usar **certificado X.509 DER**, não SPKI DER nem texto `BEGIN PUBLIC KEY`. [ILibCrypto.c L979–985](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microstack/ILibCrypto.c#L979-L985) chama `d2i_X509` e não carrega chave privada nesse caminho.

**Formato de assinatura:** `RSA_verify` verifica o digest SHA-256 com assinatura RSA PKCS#1 v1.5, não RSA-PSS. No servidor Node, assinar a **mensagem original**, com SHA-256 e padding explícito; não assinar o digest com uma API que aplique SHA-256 novamente. No agente, passar o digest binário, nunca sua representação hexadecimal.

### Snippet mínimo MeshAgent (ES5)

Função executável com APIs comprovadas nos bindings. Entradas `trustedDer`, `payloadBytes` e `signatureBytes` são Buffers. O certificado é fornecido **somente pela configuração/provisionamento confiável**, nunca pelo envelope de rede. A função é um verificador criptográfico, não um executor ou uma validação completa de grant.

```javascript
function makeGrantVerifier(trustedDer, expectedSignatureBytes) {
    var tls = require('tls');
    var rsa = require('RSA');
    var sha = require('SHA256Stream').create();
    var cert = tls.loadCertificate({ der: trustedDer });
    // Política local: certificado RSA previamente validado, 2048/3072/4096 bits.
    if (expectedSignatureBytes !== 256 && expectedSignatureBytes !== 384 &&
        expectedSignatureBytes !== 512) {
        throw new Error('Unsupported pinned RSA key size');
    }
    return function verifyGrantBytes(payloadBytes, signatureBytes) {
        try {
            if (!Buffer.isBuffer(payloadBytes) || !Buffer.isBuffer(signatureBytes)) {
                return false;
            }
            if (payloadBytes.length === 0 || payloadBytes.length > 1048576 ||
                signatureBytes.length !== expectedSignatureBytes) {
                return false;
            }
            return rsa.verify(rsa.TYPES.SHA256, cert,
                sha.syncHash(payloadBytes), signatureBytes) === true;
        } catch (e) {
            return false;
        }
    };
}
```

Exemplo de integração: `makeGrantVerifier(Buffer.from(certificadoPublicoBase64Provisionado, 'base64'), 256)` para certificado RSA de 2048 bits. A função devolvida recebe os bytes decodificados da mensagem e da assinatura. Não fornecer o certificado de uma mensagem não autenticada a essa factory.

**Risco nativo importante:** `RSA.verify` não demonstra checagens defensivas para objeto de certificado inválido ou chave não RSA antes de usar ponteiros OpenSSL. `try/catch` não transforma um crash nativo em erro JavaScript. Validar certificado RSA e correspondência com chave privada no provisionamento; importar uma vez, reter o objeto e nunca permitir que o remetente escolha certificado/algoritmo. A verificação RSA não faz validação de cadeia, revogação ou prazo de X.509; aqui a confiança é pinning explícito de chave/certificado.

### Contraparte mínima Node (servidor, não Duktape)

```javascript
function signGrantBytes(privateKeyPem, payloadBytes) {
    var crypto = require('node:crypto');
    return crypto.sign('sha256', payloadBytes, {
        key: privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_PADDING
    });
}
```

Contrato de bytes recomendado: o servidor serializa uma vez o grant validado, codifica em UTF-8, assina esses bytes e envia `grantB64` + `signatureB64`. O agente decodifica, verifica e **só então** interpreta o JSON desses mesmos bytes. Não verificar uma representação e executar campos de outro objeto externo. Isso evita depender da ordem de propriedades de duas serializações independentes. Impor limites também à string base64 antes de alocar buffers.

O corpo assinado deve vincular versão, propósito/plugin, domínio/nó, executionId, script ou hash exato de conteúdo congelado, interpretador/opções, bootNonce, requestNonce e validade. Comparar tudo à solicitação/contexto pendente e consumir antes de qualquer yield/spawn. A assinatura prova posse da chave; **não prova freshness, autorização de negócio ou uso único sozinha**. O servidor não pode oferecer assinatura genérica de conteúdo da UI.

## 3. Nonces: CSPRNG real e tratamento de falha

### API comprovada e recomendada

[Polyfills.c L2376–2384](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_Polyfills.c#L2376-L2384): `bignum.random(range)` chama o gerador criptográfico OpenSSL `BN_rand_range(rnd, range)` e lança `Error Generating Random Number` quando retorna 0. Não chama `rand()` nesse caminho.

[Polyfills.c L2412–2431](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_Polyfills.c#L2412-L2431): construtor recebe **string decimal**, via `BN_dec2bn`; exporta `random`. [L2258–2276](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_Polyfills.c#L2258-L2276): `toString()` usa `BN_bn2dec`, não implementa radix hexadecimal. [L3535–3538](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_Polyfills.c#L3535-L3538): módulo registrado apenas com suporte TLS.

```javascript
var bn = require('bignum');
var nonceRange = bn(
    '115792089237316195423570985008687907853269984665640564039457584007913129639936'
); // 2^256, não converter para Number.
function newNonce256() {
    return bn.random(nonceRange).toString();
}
```

Resultado: string decimal de um inteiro uniforme em `[0, 2^256)`, até 78 dígitos, representando 256 bits de espaço aleatório. Zero é um valor possível, não evidência de falha. Não truncar nem usar `parseInt`/`toNumber`. Se o protocolo exigir hex/base64, sua conversão exata precisa implementação separada; **não presumir `toString(16)`**. Usar diretamente a string decimal reduz o contrato necessário.

Geração de bootNonce e requestNonce deve ocorrer dentro do caminho que, em exceção, invalida o estado pendente e mantém execução bloqueada. Novo contexto/perda de dedup RAM exige novo bootNonce; não inicializar nonce com constante nem aproveitar valor anterior após erro. Ausência de `bignum`, OpenSSL sem entropia ou falha de geração: sem hello/grant executável. O binding tem uma alocação nativa que não libera `rnd` no caminho de erro; não implementar loop infinito de retry de RNG.

### Por que não afirmar `crypto.randomBytes` nem usar randomFill como equivalente

Não foi comprovado `require('crypto').randomBytes` no conjunto examinado. Isso é **limite desta pesquisa**, não afirmação de ausência em todas as versões/módulos externos.

A API nativa encontrada é `buffer.randomFill()`: [Polyfills.c L123–141](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_Polyfills.c#L123-L141), exportada em [L362–363](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibDuktape_Polyfills.c#L362-L363). Ela chama `util_random` e retorna undefined. [ILibCrypto.c L246–271](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microstack/ILibCrypto.c#L246-L271) mostra:

- Com TLS: `RAND_bytes(result, length);` **sem verificar retorno**.
- Sem TLS: `srand(time(...))` seguido de `rand()`.

Testar tamanho, desigualdade de duas amostras ou ausência de zeros não comprova CSPRNG nem corrige falha de entropia. A solução sem modificar binding é o `bignum.random` acima, e não um wrapper que apenas renomeie randomFill para randomBytes.

## 4. Identidade positiva de parent: prova completa e limites

### Cadeia nativa → core → plugin

| Etapa | Evidência fixada | Consequência |
| --- | --- | --- |
| Singleton | [agentcore.c L2040–2067](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/meshcore/agentcore.c#L2040-L2067) | `ILibDuktape_MeshAgent_PUSH` devolve o objeto guardado em `MESH_AGENT_SINGLETON`; na primeira criação armazena esse mesmo objeto no heap stash. |
| Registro | [agentcore.c L702–711](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/meshcore/agentcore.c#L702-L711) | `mesh.AddCommandHandler(fn)` chama `mesh.on('Command', fn)` com o mesmo `this`. **C maiúsculo.** |
| Origem normal | [agentcore.c L3015–3022](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/meshcore/agentcore.c#L3015-L3022), [L3181–3200](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/meshcore/agentcore.c#L3181-L3200), [L3263–3266](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/meshcore/agentcore.c#L3263-L3266) | No build TLS, comandos não auth não chegam ao dispatch enquanto `serverAuthState != 3`. Emissão usa `MeshAgent_PUSH`, método `emit`, receptor singleton e evento `Command`. |
| Receptor do listener | [EventEmitter.c L268–280](https://github.com/Ylianst/MeshAgent/blob/0e6b4f7fea6c88ad1978206550d202a7f33741c5/microscript/ILibduktape_EventEmitter.c#L268-L280) | Faz `duk_push_this` antes de `duk_pcall_method`; o listener recebe o mesmo receptor da emissão. |
| Core | [meshcore.js L7621](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/agents/meshcore.js#L7621), [L2123–2124](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/agents/meshcore.js#L2123-L2124) | Registra `handleServerCommand`, que repassa `this` como quarto argumento de `consoleaction`. Portanto **parent === require('MeshAgent')** nesse caminho. |
| Túnel 7 | [meshcore.js L4365–4375](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/agents/meshcore.js#L4365-L4375) | Handler de dados do túnel repassa seu objeto de stream/túnel, não o singleton; JSON recebido não pode fabricar identidade de objeto JavaScript. |

### Predicado mínimo de origem, para uso dentro de consoleaction

```javascript
var mesh = require('MeshAgent');
function isDirectControl(command, rights, sessionid, parent) {
    if (parent !== mesh || rights != null || sessionid != null) return false;
    if (!command || typeof command !== 'object' || Array.isArray(command)) return false;
    if (command.action !== 'plugin' || command.plugin !== 'meshtask2' ||
        command.version !== 1) return false;
    var denied = ['_', 'sessionid', 'fromSessionid', 'userid', 'rights', 'routeToNode'];
    for (var i = 0; i < denied.length; ++i) {
        if (denied[i] in command) return false; // presença, mesmo null/0/false/''
    }
    return true;
}
```

Este predicado **não executa nada**. Depois dele ainda são exigidos schema fechado/operação exata, autenticação RSA se escolhida, binding de contexto/nonce, deadline, consumo e dedup. Não registrar outro AddCommandHandler para substituir/duplicar o core.

- **Console:** passa explicitamente `mesh`, portanto a comparação de identidade aceita esse parent; os argumentos posicionais e `args._` precisam ser rejeitados. [meshcore.js L6421–6433](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/agents/meshcore.js#L6421-L6433).
- **routeToNode:** chega ao mesmo canal autenticado e portanto também tem parent correto. O servidor injeta `userid`, `rights` e `sessionid` antes do envio local; filtros barram esse caminho específico. [meshuser.js L293–323](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/meshuser.js#L293-L323), [L5103–5111](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/meshuser.js#L5103-L5111). Via peer, injeta `fromSessionid`: [L338–364](https://github.com/Ylianst/MeshCentral/blob/2e7ec138cf45b09204bf036b500e5e2cf37aaba4/meshuser.js#L338-L364).
- Não basta negar `parent.httprequest`: usar igualdade positiva. Não aceitar `parent` vindo de campo JSON, marcador server, nome de classe ou objeto com método SendCommand.
- Não protege contra JavaScript privilegiado já executando no mesmo heap: esse código pode obter o singleton e emitir evento/chamar plugin. Servidor, core, módulos privilegiados e OS confiáveis são premissas, não resultados desta verificação.

**Alternativa sem assinatura:** admissível como desenho restrito a servidor único/build TLS e SHAs homologados, com o predicado, schema fechado e servidor que nunca reflita mensagem de usuário como dispatch limpo. A identidade prova o receptor/canal do controle, não autoria pelo scheduler. Não certifica outros plugins, rotas não examinadas ou processamento do peer/HA. Para não ampliar auditoria de rotas agora, **preferir o grant RSA**, mantendo o predicado como defesa adicional. Não anunciar parent sozinho como autenticação universal do servidor MeshTask.

## 5. Gate mínimo para executar no ambiente dedicado

Não é necessário continuar pesquisando APIs para iniciar a implementação. Antes de liberar spawn, executar somente no ambiente autorizado:

1. **Probe MeshAgent Windows e Linux:** disponibilidade dos módulos; cert provisionado RSA carrega; assinatura Node válida retorna true; mensagem alterada, assinatura alterada e outra chave retornam false. Demonstrar também que RSA-PSS não é aceito pelo contrato v1.5. Não injetar certificado inválido/não RSA no binding como teste casual: há risco nativo descrito acima.
2. **Nonce:** `bignum.random` funciona no binário real; falha/indisponibilidade do módulo mantém o executor fechado. Amostras distintas são smoke test, não prova estatística de segurança. A prova de origem criptográfica vem do binding e da biblioteca/build confiável.
3. **Transporte sem spawn:** grant de servidor passa; console, routeToNode com campos omitidos/null e túnel 7 com JSON limpo/server forjado falham. Confirmar identidade por booleano, sem publicar nonces ou conteúdo sensível. Revalidar a cada atualização relevante.
4. **Estado:** nonce de boot anterior, request já consumido, TTL expirado e duplicata não geram spawn. Perda de RAM/reload invalida sessão. Ledger servidor persiste consumo antes da autorização e nunca reabre o mesmo executionId; crash/disconnect podem resultar em unknown, não retry cego.

**Limite explícito:** os snippets são funções JavaScript mínimas fundamentadas nas APIs C; não foram executados em Duktape nesta entrega. Checagem sintática em Node não prova importação desses módulos nem interoperabilidade real de assinatura. Nenhuma correspondência com o binário instalado foi aferida e nenhum gate de produção foi liberado.

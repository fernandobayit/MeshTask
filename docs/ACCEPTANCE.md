# Aceite e homologação — MeshTask 2

## Princípio
Testes locais são necessários, mas não aprovam o plugin para produção. Este documento define o que precisa ser observado em um laboratório autorizado. Nenhum cenário abaixo autoriza usar automaticamente os endpoints de produção.

## Gates de entrega
- G0 — código: módulos importam sem iniciar serviços; suíte isolada executa sem dependências baixadas; nenhum segredo ou caminho absoluto de instalação nos testes.
- G1 — persistência: tarefa/tentativa/auditoria persistidas atomicamente antes do despacho; reinício não causa execução cega; storage corrompido falha fechado.
- G2 — integração: plugin carrega no MeshCentral homologado, UI autentica admin, ações e eventos pertencem ao domínio correto, módulo chega ao MeshAgent.
- G3 — execução: Bash/Linux e PowerShell/Windows produzem stdout, stderr e exit code corretos no runtime real, incluindo erros e Unicode.
- G4 — resiliência: duplicidade, queda de rede e reinício deixam histórico explicável e não anunciam sucesso/cancelamento sem confirmação.
- G5 — release: build rastreável, artefato versionado, backup/rollback ensaiados e nenhuma execução simultânea pela versão antiga.

## Casos comportamentais
### Orquestração e banco
1. Criar tarefa e editar script depois: execução usa a revisão original.
2. Dois ciclos de despacho concorrentes: uma única tentativa reservada por job.
3. Banco falha antes do commit: nenhuma mensagem sai para o agente.
4. Transporte falha após commit: tentativa permanece identificável/ambígua, não volta automaticamente à fila virgem.
5. Servidor reinicia após enviar, antes do ACK: não repetir a execução; consultar status ou manter desconhecido.
6. ACK repetido e resultado repetido idêntico: não duplicar efeitos ou registros finais; conflitos explícitos não sobrescrevem resultado silenciosamente.
7. Resultado recebido antes do ACK: armazenar conclusão; ACK tardio não regride o estado.
8. Prazo excedido e resultado recebido depois: preservar o evento de timeout e incorporar o resultado tardio.
9. Agente diferente ou domínio diferente informa resultado: rejeitar sem mutação.
10. Identificador de tentativa/token incorreto, protocolo desconhecido, payload excessivo: rejeitar.
11. Scheduler concorrente/reiniciado: mesma ocorrência não cria jobs extras.
12. Dispositivo offline: tarefa não é marcada como executada/sucesso.

### Agente real
13. Bash termina com 0 e texto em stdout: sucesso com texto e exit code 0.
14. Bash termina com 7: falha com exit code 7, não sucesso presumido.
15. Stderr com exit 0: preservar stderr sem transformar automaticamente em falha.
16. PowerShell com acentos e exit explícito: preservar Unicode e código de saída.
17. Falha de spawn/interpreter ausente: erro explícito; nenhum job local preso como running.
18. Desconexão durante execução e reconexão: reconciliação pelo mesmo identificador, sem relançar.
19. Reinício do agente durante execução: não presumir que processo acabou; resultado desconhecido conservador.
20. Mensagem duplicada para job concluído: devolver resultado salvo, não executar novamente.
21. Saída grande: limite de memória e indicador de truncamento, sem derrubar processo do MeshAgent.
22. Arquivos temporários (se houver): conteúdo privado desde a criação e limpeza no sucesso/erro; sem symlink traversal.
23. Plataforma ou contexto não suportado: recusa explícita antes de executar.
24. Tarefa longa: limite de espera do servidor não equivale a encerramento do processo.
25. Cancelamento (se habilitado): distinguir pedido enviado, confirmação, processo encerrado e árvore de processos. Sem confirmação, não exibir cancelado.

### Interface e autorização
26. Usuário comum: sem acesso à UI/dados/execução administrativos.
27. Administrador de outro domínio: sem acesso cruzado a scripts, targets ou resultados.
28. Nome de script, stderr e stdout com markup: texto visível, nunca HTML executável.
29. Respostas fora de ordem: correlacionar com a operação originadora.
30. Carregamento/falha: mostrar indisponibilidade, nunca tabela vazia equivalente a ausência de dados.

## Wallpaper e sessão gráfica
Wallpaper não é critério de sucesso do executor em contexto serviço. O suporte à sessão do usuário exige requisito separado: identificar sessão ativa, usuário correto, autorização, ambiente gráfico, D-Bus/desktop no Linux ou sessão interativa no Windows. Não usar ROOT/SYSTEM como substituto silencioso do usuário logado. Não validar pelo exit code sozinho; conferir efeito no contexto correto.

## Registro de execução E2E
Preencher apenas após autorização e execução: versão MeshCentral, Node servidor, build MeshAgent, OS, usuário/contexto, commit/artefato, casos executados, resultado observado, evidência sanitizada, falhas e plano de rollback. Status inicial: NÃO EXECUTADO.

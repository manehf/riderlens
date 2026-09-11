# RiderLens — campanhas, utilização e melhorias da análise

Data: 10 de setembro de 2026. Relatório para decisão de produto e desenvolvimento.

**Conclusão:** existe utilização efetiva registada, com análises concluídas. Há falhas de comunicação repetidas que podem prejudicar a primeira experiência. A medição atual não permite saber quantas pessoas regressam, quantas veem a subscrição ou por que não compram. A prioridade é entregar resultados de forma fiável, proteger as análises gratuitas e medir o percurso até à compra antes de aumentar a aquisição.

## 1. Âmbito e qualidade da evidência

Os números seguintes são os observados nos painéis durante a consulta desta conversa, em 10 de setembro; não constituem uma exportação integral nem um painel atualizado automaticamente. O Meta Ads foi consultado de 1 a 10 de setembro, em horário de Lisboa. O relatório histórico do GA4 abrangia 13 de agosto a 9 de setembro. A janela de tempo real do GA4 correspondia aos 30 minutos anteriores à leitura e muda continuamente.

Os **95 downloads e zero subscrições** foram indicados pelo proprietário. Não foram reconciliados com App Store Connect, Google Play ou RevenueCat. O valor zero de receita no GA4 não confirma, por si só, ausência de compras: a instrumentação de compras da app não foi demonstrada neste relatório.

A revisão técnica incidiu nos ficheiros locais, que contêm alterações em curso. **Código local não equivale a código já instalado pelos clientes.** A correção de transporte iOS tem implementação local e documentação próprias; a validação física e a disponibilização na loja não foram confirmadas nesta revisão.

## 2. Campanhas: quanto foi gasto e o que trouxe

| Campanha / conjunto | Gasto | Resultado observado | Custo unitário |
| --- | ---: | --- | ---: |
| Instalações iOS 14+ — CA/UK/US | 2,91 € | 10 instalações atribuídas | 0,29 €/instalação |
| Instalações Android — CA/UK/US | 16,18 € | 27 instalações atribuídas | 0,60 €/instalação |
| Tráfego iOS para App Store | 18,60 € | 160 cliques | 0,12 €/clique |
| Tráfego iOS + Android para website | 9,76 € | 121 visualizações da página de destino | 0,08 €/visualização |
| **Total RiderLens** | **47,45 €** | Resultados com unidades diferentes | — |

Fonte: [Meta Ads — conta consultada](https://adsmanager.facebook.com/adsmanager/manage/campaigns?act=1784757402700465). Os custos unitários apresentados estão arredondados.

As duas campanhas de instalação somam **37 instalações atribuídas por 19,09 €**, ou aproximadamente **0,52 € por instalação**. O iOS começou em 10 de setembro; dez instalações ainda são uma amostra pequena e não permitem concluir que esse público produz melhores clientes. As janelas de atribuição também diferem: iOS usa clique de um dia; Android inclui clique, visualização ou interação de um dia.

O tráfego absorveu **28,36 €, aproximadamente 60% do gasto**. A campanha agregada apresenta 298 cliques, mas esse resultado não mede subscrições. O conjunto do website apresenta 121 visualizações de página; não se devem somar estas visualizações a instalações como se fossem a mesma conversão.

Não é válido atribuir automaticamente os 95 downloads às campanhas, nem usar 47,45 €/95 como CPI confirmado. Faltam o intervalo e a plataforma dos downloads, a reconciliação com as lojas e a contribuição orgânica.

**Decisão sugerida:** manter testes pequenos de instalação; reavaliar a continuidade do tráfego com base em instalações e primeiras análises concluídas. Não aumentar orçamento com base apenas no CPC ou no CPI inicial. A rentabilidade não está demonstrada enquanto não houver compras e utilização posterior atribuíveis.

### Atualização: comparação das duas campanhas ativas

Após a pergunta específica sobre as duas campanhas ativas, foi feita uma nova leitura do Meta Ads, com **10 de setembro de 2026** como período comum. Foram adicionadas as colunas `Mobile app installs`, `App installs` e `Cost per app install` à visualização, guardada pelo Meta como “Copy of Performance and clicks”. Não foram alterados anúncios, orçamentos ou estados de publicação.

| Campanha ativa | Gasto observado nesta leitura | Instalações atribuídas hoje | Outros resultados |
| --- | ---: | ---: | --- |
| App Installs — iOS 14+ — CA/UK/US | 3,38 € | **11**, a **0,31 €** cada | — |
| Traffic — iOS — Meta Test | 2,82 € | **“—”**, sem instalações atribuídas apresentadas | 33 cliques; 24 visualizações da página de destino |

**Resposta:** a App Install é a que demonstra mais downloads atribuídos no Meta neste dia. A Traffic não apresenta instalações atribuídas, mesmo quando se consulta explicitamente essa métrica. O traço não prova que nenhum dos seus visitantes tenha instalado a app: a atribuição pode ser incompleta e o dia ainda não estava fechado. Não há base para quantificar os downloads totais reais da Traffic ou a sua contribuição para os 95 downloads indicados. Estes números mais recentes não substituem o histórico de 1 a 10 de setembro da secção anterior.

## 3. Há pessoas a usar?

Há eventos que comprovam utilização do fluxo de análise, embora não permitam contar pessoas distintas com rigor nem excluir testes internos.

| Evento no GA4, 13 de agosto a 9 de setembro | Ocorrências | Identificadores distintos apresentados em “Total users” |
| --- | ---: | ---: |
| `analysis_started` | 25 | 23 |
| `analysis_completed` | 21 | 19 |
| `analysis_failed` | 19 | 4 |
| `analysis_retry` | 24 | 7 |

Fonte: [GA4 — eventos RiderLens](https://analytics.google.com/analytics/web/#/a93476196p552967238/reports/explorer?r=top-events).

As **19 falhas em quatro identificadores** apontam para falhas repetidas em alguns registos. Um mesmo registo pode falhar várias vezes e depois concluir. Não é correto calcular 19/25 como percentagem de pessoas que falharam, nem apresentar 21/25 como taxa de sucesso de uma coorte: existem repetições, reprocessamentos e resultados que podem atravessar os limites do período.

Na leitura em tempo real foram observadas **duas análises iniciadas, uma concluída, duas novas tentativas e quatro falhas**. As quatro falhas tinham `failure_stage=request_transport`. O painel mostrava quatro “utilizadores” em 30 minutos e um em cinco minutos; esses valores representam identificadores de análise neste fluxo, não necessariamente quatro pessoas.

O Meta Events Manager também recebia eventos da app, incluindo inícios e conclusões. Os totais entre Meta e GA4 não devem ser somados: medem atividade sobreposta, com mecanismos e momentos de processamento diferentes.

### Limitações da medição atual

Em [productAnalytics.ts](../src/services/productAnalytics.ts), `clientId` é construído como `analysis.<recordId>`. O chamador envia o ID do registo, que também pode ser reutilizado quando esse registo é reprocessado. Assim, não é um identificador persistente de pessoa, nem necessariamente uma tentativa única.

A propriedade GA4 mistura eventos do website e eventos da app enviados pelo servidor. Os **63 utilizadores** do relatório incluem estas duas origens. `engagement_time_msec` é definido como **1 ms por evento** no servidor: não mede tempo real de utilização. Os campos `app_platform` e `event_source` existem, mas não transformam automaticamente os eventos enviados ao fluxo web em sessões nativas completas.

É necessário distinguir pessoa/instalação, sessão, registo e tentativa. A documentação oficial explica o papel dos parâmetros de sessão e interação e avisa que uma resposta HTTP de sucesso do Measurement Protocol não garante o processamento de um evento válido. [Google — Measurement Protocol](https://developers.google.com/analytics/devguides/collection/protocol/ga4/reference?hl=en).

## 4. O que pode impedir a análise ou a subscrição

### P0 — Fiabilidade do envio no iOS

**Evidência de produção:** o [incidente Sentry 7724795355](https://antonio-fernandes.sentry.io/issues/7724795355/) mostra iOS 1.0.4 (7), uma tentativa de POST para `/capture/jobs`, entrada em segundo plano e erro de transporte aproximadamente 143 segundos depois do início. O pedido reportava cerca de 4,9 MB. Isto não prova quantos bytes chegaram ao servidor, nem estabelece que a suspensão foi a causa única. Também não prova falha do algoritmo de análise.

**Situação local:** já existe transporte nativo iOS, coordenação de transferências, recuperação de resultados, proteção contra repetição indevida do envio, progresso e diagnóstico por fase. Ver [plano de transporte iOS](ios-analysis-transfer-plan.md), [adaptador iOS](../src/services/analysisTransport.ios.ts) e [coordenador](../src/services/analysisCoordinator.ts). A prioridade é concluir a validação desta implementação, sem duplicar uma correção já em curso.

**Critério de aceitação:** num iPhone físico, enviar vídeos representativos, bloquear o ecrã, mudar de rede e regressar à app; o vídeo deve ficar preservado, não deve haver um segundo envio enquanto o anterior está ativo e o resultado deve ser recuperado quando disponível. Testar também resposta perdida depois da aceitação, pouco espaço e reabertura após encerramento.

Transferências em segundo plano não garantem continuidade após o utilizador forçar o encerramento da app. A Apple documenta esse limite; a recuperação posterior deve continuar a ser tratada pela aplicação. [Apple — background URLSession](https://developer.apple.com/documentation/foundation/urlsessionconfiguration/background%28withidentifier%3A%29).

### P0 — Não gastar uma análise gratuita sem entregar resultado

**Confirmado no código:** a app oferece três análises gratuitas por mês. Em [useRiderLensMvp.ts](../src/hooks/useRiderLensMvp.ts), o contador é incrementado depois de guardar o vídeo, antes do processamento terminar. Não foi encontrada compensação automática quando o processamento falha. As novas tentativas do mesmo registo não descontam novamente neste caminho.

**Impacto provável:** alguém pode consumir a experiência gratuita com registos que ainda não produziram resultados. Isso pode afetar confiança e disposição para pagar; não está demonstrado que explique todas as zero subscrições.

**Proposta:** reservar uma utilização ao admitir o registo, confirmar o consumo quando o resultado fica guardado e utilizável, e libertar a reserva numa falha definitiva sem resultado. A operação deve ser persistente e idempotente. Uma simples mudança do incremento para o fim permitiria iniciar vários pedidos gratuitos antes de algum terminar.

**Critério de aceitação:** três reservas impedem uma quarta admissão; repetir uma tentativa não cobra de novo; falha definitiva liberta apenas uma reserva; reabrir a app ou atravessar o fim do mês não perde nem duplica o saldo; apagar um resultado já entregue não devolve o crédito. Definir explicitamente o tratamento de cancelamentos.

### P1 — Medir e distinguir problemas na compra

Em [revenueCat.ts](../src/services/revenueCat.ts), `presentProPaywall()` reduz o resultado ao estado Pro e, em caso de exceção, volta a consultar esse estado. O chamador não distingue bem fechar o ecrã, não comprar, falha na apresentação ou problema de compra. Os quatro eventos próprios atuais cobrem análise, não o percurso de subscrição.

**Proposta:** distinguir e medir abertura/fecho do ecrã, indisponibilidade de produtos, compra iniciada, compra confirmada e erro. Mostrar uma mensagem recuperável quando existe erro técnico, preservando o vídeo selecionado. Usar a confirmação de entitlement/compra do RevenueCat e das lojas como verdade de pagamento, com deduplicação; não inferir uma compra a partir de um botão premido.

**Critério de aceitação:** validar numa build de loja em ambiente de teste compra, cancelamento, produtos indisponíveis, rede desligada e restauro. A revisão atual não prova que as compras estejam avariadas em produção; esta é uma lacuna de diagnóstico.

### P1 — Separar utilização, tentativas e conversão

Criar um funil que permita localizar o abandono:

`abertura → vídeo selecionado → análise pedida → envio aceite → resultado guardado → resultado visto → limite atingido → subscrição apresentada → compra confirmada`.

Manter `record_id` para o conteúdo e `attempt_id` para o processamento. Para retenção, considerar um identificador aleatório da instalação e sessões delimitadas, com desenho de privacidade e consentimento adequado; a implementação atual evita deliberadamente um identificador persistente. Essa decisão deve ser explícita e não introduzida silenciosamente. Mesmo uma instalação não equivale a uma pessoa e muda com reinstalações.

Separar produção, desenvolvimento e testes, app e website, iOS e Android, versão e build. A versão sozinha não distingue builds da mesma versão. Não enviar vídeos, identificadores publicitários ou IDs de registo detalhados para a Meta sem necessidade. Usar as ferramentas de diagnóstico para correlação técnica e agregados para aquisição.

**Critério de aceitação:** executar um percurso controlado e verificar exatamente os eventos esperados, incluindo uma recuperação sem nova compra nem nova utilização gratuita. Verificar eventos no destino, para além do HTTP 2xx.

### P1 — Recuperar resultados quando a pessoa regressa mais tarde

A fila local do servidor tem retenção terminal configurada para **45 minutos** e limpeza de resultados associada. O envio nativo pode terminar sem a app aberta, mas a obtenção e persistência do resultado permanecem operações de primeiro plano no desenho atual. Quem regressar depois da expiração pode precisar de novo processamento. Ver [capture_jobs.py](../worker/app/capture_jobs.py).

**Proposta:** medir quanto tempo decorre até ao primeiro regresso e quantas recuperações encontram resultado expirado. Avaliar retenção mais longa ou retenção até confirmação de receção, sempre com um limite máximo e limpeza. Não aumentar retenção ou infraestrutura sem conhecer tamanho dos resultados, espaço disponível e custo.

**Critério de aceitação:** testar regresso antes e depois dos 45 minutos; nunca perder o vídeo local, consumir outro crédito automaticamente ou apresentar uma espera interminável. Explicar ao utilizador quando é necessário repetir o processamento.

### P1 — Mostrar o progresso que realmente existe

A implementação local já distingue preparação, envio, confirmação, espera, análise e obtenção de resultado. Falta verificar em dispositivo se o progresso corresponde ao estado real. Existem ainda textos de fallback com o termo técnico “worker”.

**Proposta:** usar mensagens simples, por exemplo “O vídeo está guardado. Vamos tentar novamente quando houver ligação.”; mostrar a fase atual, a próxima tentativa e o resultado da recuperação. Não mostrar 100% do envio como 100% da análise, nem estimativas de tempo sem dados.

**Critério de aceitação:** a pessoa percebe se pode sair da app, se o vídeo está seguro e quando deve agir, sem precisar de conhecer a infraestrutura.

### P2 — Reduzir a transferência e facilitar a primeira análise

O cliente envia o ficheiro de origem juntamente com o intervalo escolhido; selecionar oito segundos não implica enviar apenas oito segundos. O resultado inclui vídeos e imagens em base64, com compressão e limites já existentes no servidor. Isto é uma oportunidade de otimização, não uma causa demonstrada dos incidentes.

**Proposta:** medir bytes e duração por fase. Avaliar recorte local do intervalo e transferência separada dos ficheiros de resultado, preservando orientação, timestamps e qualidade necessária à deteção. Não reduzir indiscriminadamente resolução ou fotogramas por segundo numa app que analisa movimento.

Para a primeira utilização, avaliar um exemplo de resultado acessível sem consumir crédito e instruções curtas sobre enquadramento, visibilidade do ciclista e seleção do momento. Estas são hipóteses de produto a validar com abandono e resultado visto, não falhas comprovadas de onboarding.

### P2 — Validar a qualidade da análise antes de alterar o algoritmo

Os eventos comprovam entrega de resultados, não a correção das medições nem a utilidade para o ciclista. Esta revisão não examinou um conjunto de vídeos reais de clientes e não permite concluir que seja necessário substituir o modelo ou a deteção de pose.

**Proposta:** usar vídeos de teste autorizados e representativos de iluminação, ângulo, movimento e diferentes capacidades dos telemóveis. Comparar momentos detetados e medições com anotações humanas, verificar reprodução/rotação e avaliar se o resultado ajuda a pessoa a perceber a execução. Definir critérios antes de comparar alterações.

## 5. Porque zero subscrições ainda não identifica a causa

| Hipótese | O que a sustenta | O que falta |
| --- | --- | --- |
| Ainda não atingiram o limite gratuito | Três análises por mês no código | Número de instalações com três resultados e exposições ao ecrã de subscrição |
| Falhas estragam a primeira experiência | GA4 e incidente Sentry | Coorte que falhou, recuperou, regressou e comprou |
| Problema técnico na compra | Erros pouco diferenciados no cliente | Testes de loja e dados RevenueCat |
| O resultado não demonstra valor suficiente | Possibilidade de produto | Resultado visto, repetição de uso e feedback |
| Público pouco qualificado | Parte do gasto otimizada para tráfego | Primeira análise concluída e compras por campanha |
| Preço ou oferta desadequados | Nenhuma evidência específica recolhida | Exposições à oferta, rejeições e comparação controlada |

Não recomendo reduzir as análises gratuitas nem alterar o preço só com estes números. Primeiro é necessário saber quantas pessoas receberam valor e tiveram oportunidade real de comprar.

## 6. Ordem de execução e medição

| Ordem | Trabalho | Condição para avançar |
| --- | --- | --- |
| 1 | Validar a correção iOS já existente | Matriz física de envio, suspensão e recuperação aprovada |
| 2 | Reservas de créditos e diagnóstico de compra | Casos de falha/repetição e compras de teste aprovados |
| 3 | Funil completo e separação de testes | Percurso controlado verificado nos destinos |
| 4 | Observar uma coorte após a correção | Período e versões comparáveis, com utilizadores elegíveis para regresso |
| 5 | Ajustar aquisição, onboarding e oferta | Decisão apoiada em resultados vistos e conversão, não apenas downloads |

O painel de acompanhamento deve incluir: instalações por loja; primeira análise concluída por instalação observável; conclusão por tentativa única; recuperação após falha; latência mediana e percentil 95 por fase; resultados vistos; regresso no dia 1 e no dia 7 entre instalações elegíveis; subscrições apresentadas; compras confirmadas; custo por primeira análise concluída e por cliente pagante.

Usar denominadores compatíveis e explicitar cobertura de consentimento, versões e atribuição. Não ligar automaticamente cliques web a instalações ou compras da app. As metas numéricas devem ser definidas após obter uma base fiável; não foram inventados benchmarks para esta amostra.

## 7. Verificação técnica efetuada

Foram executados os sete ficheiros de testes de créditos, repetição, coordenação, transporte, transporte nativo simulado, armazenamento e integração do plugin: **81 testes passaram**. `npm run typecheck` também passou.

Os testes validam a lógica local coberta. Não comprovam comportamento com suspensão num iPhone físico, fiabilidade da rede real, qualidade da deteção nos vídeos dos clientes, configuração de compras publicada ou correspondência exata com a versão instalada. Não foram introduzidas falhas em produção nem alteradas campanhas, pagamentos ou código funcional nesta revisão.

**Recomendação final:** concluir e validar a correção de transporte existente, proteger a experiência gratuita e tornar o percurso até à compra observável. Só depois será possível distinguir com confiança um problema de fiabilidade, de valor do produto ou de aquisição.

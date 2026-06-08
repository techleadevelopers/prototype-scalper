# Quant Brain

Serviço Python/FastAPI de inteligência quantitativa do BingX Futures Dashboard.
Ele não envia ordens. Sua responsabilidade é coletar contexto de mercado,
finalizar sinais, estudar resultados, avaliar edge, monitorar drift e produzir
evidência auditável para o backend executor.

Este sistema é experimental. Modelo, score, AUC ou win rate não garantem lucro.
Autoridade de execução permanece no backend Node.js.

## Responsabilidades

```text
Market data -> feature snapshots -> signal lifecycle -> labels
            -> shadow model -> calibration/profitability
            -> edge-v3 decision -> backend executor
            -> realized outcomes -> knowledge base -> next cycle
```

Quant Brain responde:

- o dado de mercado está completo, fresco e consistente?
- o contexto atual possui edge líquido após custos?
- target ou stop configurado foi atingido primeiro?
- o modelo melhora o baseline em validação temporal?
- a probabilidade está calibrada?
- há drift de feature, previsão, calibração ou expectativa?
- profundidades adicionais de stacking agregam valor fora da amostra?
- um challenger possui evidência suficiente para promoção?

## Estado Implementado

- FastAPI com liveness, readiness, métricas, request ID, rate limit e gzip;
- PostgreSQL com schema isolado ou SQLite como fallback local;
- Feature Engine para preço, volume, OI, funding, RSI, ATR, spread e regime BTC;
- snapshots multi-timeframe e `marketEventId`;
- tactical loop, macro candle regime, shadow sampler e manutenção de modelo;
- finalização de sinais com janela configurável;
- classes `ALLOW`, `WAIT` e `BLOCK`, além de origem do sinal;
- modelo shadow com mínimo de 300 amostras;
- split cronológico purgado e walk-forward;
- comparação Brier contra baseline, AUC, qualidade de dados e simulação de
  lucratividade;
- contrato rígido `edge-v3` com proveniência;
- drift monitor com thresholds configuráveis;
- governança champion/challenger com artefatos content-addressed e audit log;
- retenção configurável por classe de dado;
- endpoints de knowledge base, inteligência, notícias e diagnóstico.

## Separação De Responsabilidades

### Backend Node.js

- guarda API Key/Secret em sessão;
- assina chamadas BingX;
- controla capital, posições, idempotência e TP/SL;
- decide se uma ordem pode ser enviada;
- mantém monitoramento e reconciliação.

### Quant Brain

- coleta e normaliza features;
- registra e finaliza sinais;
- calcula score, probabilidade e incerteza;
- mede performance histórica e drift;
- recomenda, mas não envia ordens.

## Contrato `edge-v3`

O backend chama:

```text
POST /edge/evaluate
```

O request inclui, entre outros:

- `contractVersion=edge-v3`;
- `signalId`;
- `marketEventId`;
- símbolo, side e positionSide;
- `featureVersion`;
- timestamp da feature e da requisição;
- validade da decisão;
- referência de preço;
- configuração econômica e contexto.

O Quant Brain:

- rejeita versão incompatível;
- exige IDs de proveniência;
- controla claim de evento para evitar duplicidade;
- devolve os mesmos IDs, símbolo e lados;
- informa timestamp, idade do dado, score, probabilidade, incerteza e decisão;
- pode devolver `driftPolicy`.

O backend valida a resposta com Zod e rejeita:

- contrato, feature ou proveniência divergente;
- predição anterior à requisição;
- predição ou dado de mercado stale;
- score/probabilidade presentes quando `available=false`.

O schema compartilhado vive em:

```text
contracts/quant-brain-edge-v3.json
```

## Market Data E Features

O `FeatureEngine` consulta a BingX e produz snapshots com:

- preço, bid/ask e spread;
- volume e volume ratio;
- open interest;
- funding;
- RSI, EMA, ATR e aceleração;
- contexto BTC;
- frames `1m`, `5m` e `15m`;
- candle regime macro `1h` e `4h`;
- qualidade e timestamp de origem;
- `market_event_id`.

O tactical loop persiste snapshots para permitir finalização posterior mesmo
após cold start ou perda do cache em memória.

Endpoints:

```text
GET /market/snapshots
GET /market/snapshots/{symbol}
GET /market/anomalies
GET /market/macro-regime
GET /sniper/btc-commander
GET /sniper/evaluate/{symbol}
GET /tactical/alerts
POST /tactical/analyze
```

## Ciclo De Sinal E Labels

Um sinal registrado mantém:

- decisão e `decision_group`;
- origem: hipotético, shadow sampler, VST ou outra fonte configurada;
- símbolo, lado e contexto;
- feature/config/label versions;
- preço executável;
- target, stop e custo estimado;
- IDs de sinal e evento;
- timestamps e janela de observação.

A finalização verifica qual evento ocorreu primeiro dentro da janela:

```text
target configurado -> hit
stop configurado   -> miss
janela expirada    -> resultado conforme trajetória disponível
```

Para LONG, entrada/saída usam ask/bid executáveis; SHORT usa o inverso. Valores
não finitos e preços inválidos são descartados.

Configuração:

```env
SIGNAL_OUTCOME_WINDOW_SECONDS=300
SIGNAL_OUTCOME_MIN_AGE_SECONDS=300
SIGNAL_DEDUPE_SECONDS=300
```

Endpoints:

```text
POST /signals/finalize
GET  /signals/edge/{symbol}
GET  /signals/shadow-sampler/status
POST /signals/shadow-sampler/run
```

## Shadow Sampler

O sampler gera observações sem exigir execução real. Ele roda sob o Job
Supervisor e registra candidatos dos símbolos/lados configurados.

```env
SHADOW_SAMPLER_ENABLED=true
SHADOW_SAMPLER_INTERVAL_SECONDS=60
SHADOW_SAMPLER_WINDOW_SECONDS=300
SHADOW_SAMPLER_DEDUPE_SECONDS=300
SHADOW_SAMPLER_BOOTSTRAP_SAMPLES=3
SHADOW_SAMPLER_SYMBOLS=
```

Parâmetros econômicos usados para labels:

```env
SHADOW_SAMPLER_LEVERAGE=14
SHADOW_SAMPLER_MARGIN_PER_TRADE=5
SHADOW_SAMPLER_TAKE_PROFIT_PCT=0.22
SHADOW_SAMPLER_STOP_LOSS_PCT=0.55
SHADOW_SAMPLER_TAKER_FEE_BPS=5
SHADOW_SAMPLER_SLIPPAGE_BPS_PER_SIDE=2
SHADOW_SAMPLER_ESTIMATED_FUNDING_COST_PCT=0
```

Esses valores definem o problema que o modelo aprende. Alterá-los muda label,
break-even e interpretação da probabilidade.

## Treinamento Do Modelo

O modelo shadow exige no mínimo:

```text
MIN_TRAINING_SAMPLES = 300
```

O pipeline atual:

1. carrega sinais finalizados;
2. ordena cronologicamente;
3. aplica split cronológico purgado;
4. executa walk-forward temporal;
5. treina features numéricas e categóricas;
6. mede Brier, AUC e baseline;
7. simula thresholds e EV após custos;
8. calcula qualidade, cobertura, break-even e Kelly;
9. persiste metadados e artefato somente quando há melhoria de baseline ou
   lucratividade verificada.

Status e treinamento:

```text
POST /models/sniper/train
GET  /models/sniper/status
```

O modelo continua shadow. Treinar não promove automaticamente autoridade de
execução.

## Lucratividade E Calibração

O status do modelo expõe:

- amostras disponíveis e mínimo;
- classes hit/miss;
- AUC;
- Brier do modelo e baseline;
- threshold ótimo;
- EV simulado;
- win rate no threshold;
- cobertura;
- break-even win rate;
- Kelly fraction;
- qualidade do dataset;
- `profitabilityVerified`.

Alta AUC sem calibração ou EV líquido positivo não é critério suficiente para
uso operacional.

## Drift Monitor

`GET /monitoring/drift` avalia:

- PSI e Jensen-Shannon de features;
- missingness;
- volatilidade, volume e mudança de universo;
- idade das previsões;
- Brier e degradação contra referência;
- ECE e gap de probabilidade;
- expectativa e profit factor;
- segmentos tóxicos.

Thresholds ficam no `.env.example`, incluindo:

```env
DRIFT_PSI_WARN=0.10
DRIFT_PSI_CRITICAL=0.25
DRIFT_BRIER_WARN=0.22
DRIFT_BRIER_CRITICAL=0.28
DRIFT_ECE_WARN=0.08
DRIFT_ECE_CRITICAL=0.15
DRIFT_EXPECTANCY_WARN=0
DRIFT_EXPECTANCY_CRITICAL=-0.20
DRIFT_PROFIT_FACTOR_WARN=1.10
DRIFT_PROFIT_FACTOR_CRITICAL=0.80
```

O `driftPolicy` pode reduzir stacking, impedir novas entradas ou desautorizar
enforcement ML no backend.

## Champion/Challenger Governance

Portfólio suportado:

- `deterministic_baseline`;
- `current_champion`;
- `ml_challenger`;
- `stacking_policy_challenger`;
- `early_exit_shadow_challenger`.

Artefatos são armazenados por SHA-256 sob `data/governance/artifacts`.
Registros e evidências são imutáveis; transições vão para audit log.

A avaliação usa campanhas cronológicas, purge de labels sobrepostas e bootstrap
por campanha. A partição final é reservada e fingerprinted para reduzir
otimização indevida contra o test set.

```text
GET  /governance/status
POST /governance/candidates
POST /governance/observations
POST /governance/evaluate/{candidate_id}
POST /governance/promote/{candidate_id}
POST /governance/rollback/{candidate_id}
```

Promoção e rollback são explícitos e auditados.

## Knowledge Base

Backend de persistência:

- PostgreSQL quando `QUANT_BRAIN_DATABASE_URL` ou `DATABASE_URL` existe;
- SQLite `data/knowledge.db` como fallback local.

PostgreSQL usa schema isolado:

```env
QUANT_BRAIN_DB_SCHEMA=quant_brain
QUANT_BRAIN_DB_POOL_SIZE=5
QUANT_BRAIN_DB_COMMAND_TIMEOUT=30
```

Categorias persistidas incluem:

- feature snapshots;
- observações e alertas;
- outcomes de trade;
- signal outcomes;
- notícias;
- qualidade de execução;
- evidência de governança.

Retenção:

```env
RETENTION_FEATURE_SNAPSHOTS_HOURS=24
RETENTION_SIGNAL_OUTCOMES_DAYS=60
RETENTION_NEWS_EVENTS_DAYS=3
RETENTION_OBSERVATIONS_DAYS=14
RETENTION_EXECUTION_QUALITY_DAYS=14
RETENTION_TRADE_OUTCOMES_DAYS=0
```

`0` preserva trades realizados indefinidamente.

## Runtime Jobs

O `JobSupervisor` aplica concorrência limitada, prioridade, timeout, heartbeat,
stale detection e lock de treinamento.

| Job | Default | Papel |
|---|---:|---|
| tactical market cycle | `15s` | snapshots e alertas |
| shadow signal sampler | `60s` | observações shadow |
| model maintenance | `30s` no exemplo | finalização, treino e retenção |
| macro candle regime | `900s` | contexto macro |
| strategic loop | `6h` | relatório estratégico |

Variáveis:

```env
JOB_MAX_CONCURRENCY=2
JOB_STALE_AFTER_SECONDS=120
TACTICAL_JOB_TIMEOUT_SECONDS=20
SHADOW_SAMPLER_JOB_TIMEOUT_SECONDS=25
MODEL_JOB_TIMEOUT_SECONDS=45
MACRO_CANDLE_JOB_TIMEOUT_SECONDS=30
```

## Saúde E Observabilidade

```text
GET /health/live   processo HTTP vivo
GET /health/ready  runtime, snapshots e jobs prontos
GET /health        visão consolidada
GET /metrics       latência, erros, cache, jobs, DB e event loop
```

Railway deve usar `/health/live` como liveness. Um deployment pode aparecer
running na UI da cloud e ainda devolver `502` se o processo falhou, reiniciou ou
não está ouvindo em `$PORT`.

## Autenticação E CORS

Quando `QUANT_BRAIN_API_TOKEN` está definido, requisições mutáveis
`POST/PUT/PATCH/DELETE` exigem:

```text
X-Quant-Brain-Token: <token>
```

ou:

```text
Authorization: Bearer <token>
```

GET/HEAD/OPTIONS permanecem legíveis para health e dashboards. O backend usa o
mesmo token.

`FRONTEND_URLS` controla CORS. Sem valor, a origem é `*`; isso deve ser evitado
em exposição pública.

## Integração Com O Backend

Fluxos principais:

```text
POST /edge/evaluate
POST /kb/trades
POST /kb/trades/batch
GET  /kb/trades/summary
GET  /kb/trades/recent
GET  /models/sniper/status
GET  /signals/edge/{symbol}
GET  /news/context/{symbol}
GET  /health/live
```

Outcomes não entregues ficam na outbox persistente do backend e são reenviados
em lote. O Quant Brain deve ser um sidecar degradável em `shadow`; em `enforce`,
indisponibilidade bloqueia entradas.

## Endpoints

```text
GET  /
GET  /health
GET  /health/live
GET  /health/ready
GET  /metrics

GET  /market/snapshots
GET  /market/snapshots/{symbol}
GET  /market/anomalies
GET  /market/macro-regime
GET  /sniper/btc-commander
GET  /sniper/evaluate/{symbol}

GET  /tactical/alerts
POST /tactical/analyze
GET  /strategic/report
GET  /strategic/edge-evolution
POST /strategic/analyze
POST /strategic/hypotheses

GET  /kb/patterns
GET  /kb/observations
GET  /kb/insights
GET  /kb/stats
GET  /kb/stats/{symbol}
POST /kb/trades
POST /kb/trades/batch
GET  /kb/trades/summary
GET  /kb/trades/recent
GET  /kb/feature-history/{symbol}

POST /recommend/entry
POST /edge/evaluate
GET  /simulate/gate-rejections
GET  /monitoring/drift

POST /signals/finalize
GET  /signals/edge/{symbol}
GET  /signals/shadow-sampler/status
POST /signals/shadow-sampler/run
POST /models/sniper/train
GET  /models/sniper/status

POST /news/events
GET  /news/context/{symbol}

GET  /governance/status
POST /governance/candidates
POST /governance/observations
POST /governance/evaluate/{candidate_id}
POST /governance/promote/{candidate_id}
POST /governance/rollback/{candidate_id}
```

## Rodar Local

```powershell
cd quant-brain
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
Copy-Item .env.example .env
python main.py
```

Teste:

```text
GET http://localhost:9000/health/live
GET http://localhost:9000/health/ready
```

## Deploy Railway

```text
Root Directory: quant-brain
Start Command: python main.py
Healthcheck Path: /health/live
```

Railway injeta `PORT`; `main.py` escuta em `0.0.0.0:$PORT`.

Variáveis mínimas recomendadas:

```env
DATABASE_URL=${{Postgres.DATABASE_URL}}
QUANT_BRAIN_DB_SCHEMA=quant_brain
QUANT_BRAIN_API_TOKEN=<segredo-compartilhado>
FRONTEND_URLS=https://seu-dashboard.example
```

## Testes

```powershell
python -m pytest
```

A suíte cobre contrato, lifecycle shadow, qualidade de mercado, drift,
governança, job supervisor, banco, calibração e regressões de runtime.

## Dados Que Não Devem Ir Para Git

```text
.env
.venv/
__pycache__/
.pytest_cache/
data/
*.db
*.db-journal
*.log
```

Segredos exibidos em terminal, editor, screenshot ou chat devem ser revogados e
substituídos.

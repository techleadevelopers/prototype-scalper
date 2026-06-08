# BingX Execution Backend

Backend Node.js do BingX Futures Dashboard. Ele concentra sessão, credenciais,
assinatura HMAC, execução, proteção de posições, Demo/VST, telemetria e a
integração contratual com o Quant Brain.

Este software é experimental. Scalping em massa aumenta custos, correlação,
slippage e exposição. Nenhuma configuração ou modelo garante lucro.

## Objetivo Operacional

O sistema foi construído para procurar micro-edge repetível:

```text
mercado -> candle completo -> contexto BTC -> gates de custo/risco
        -> ordem -> proteção TP/SL -> resultado realizado
        -> telemetria -> aprendizado -> próxima decisão
```

A estratégia pode distribuir várias entradas pequenas entre símbolos e, quando
explicitamente habilitado, empilhar entradas no mesmo símbolo. Volume não
substitui edge: multiplicar entradas com EV líquido negativo multiplica perdas.

O critério financeiro mínimo deve considerar:

```text
ganho líquido = alvo bruto - taxa round-trip - slippage - funding
perda líquida = stop bruto + taxa round-trip + slippage + funding
WR break-even = perda líquida / (ganho líquido + perda líquida)
```

TP, SL e limites devem ser calibrados com resultados realizados, não apenas com
taxa de acerto ou PnL bruto.

## Estado Implementado

- conexão BingX cria uma sessão server-side com API Key e Secret;
- o frontend nunca recebe a Secret de volta;
- Demo Lab reutiliza as credenciais da sessão de login e testa acesso somente em
  `https://open-api-vst.bingx.com`;
- chamadas live usam somente `https://open-api.bingx.com`;
- rotas de ordem real validam ambiente, confirmação explícita e identidade da
  conta antes do envio;
- `SCALP_ALLOW_EXECUTION=false` mantém as rotas live em observação;
- Demo Sniper possui loop server-side, monitor, campanhas e stacking controlado;
- ordens VST usam `clientOrderId` determinístico, journal persistente e
  reconciliação de estados ambíguos;
- telemetria local alimenta o motor adaptativo e é sincronizada com o Quant
  Brain por outbox persistente;
- o contrato de avaliação Quant Brain é `edge-v3` e valida proveniência,
  versão de feature, idade da predição e idade do dado de mercado;
- auditoria de execução separa perda causada por latência/slippage/spread de
  perda causada pela estratégia;
- Symbol Rotation, Strategy Memory, Aggression Controller, Kill Switch, Live
  Readiness e Position Sizing atuam antes de novas entradas;
- Pipeline Integrity Audit marca outcomes elegíveis ou bloqueados para
  aprendizado antes do sync com o Quant Brain;
- score calibration do Quant Brain pode reduzir prioridade e sizing quando o
  score bruto estiver superconfiante;
- a máquina de estado operacional continua monitorando e fechando posições
  mesmo quando novas entradas estão pausadas.

## Arquitetura

```text
Dashboard React
    |
    | cookie de sessão
    v
Express API
    |-- BingX live: open-api.bingx.com
    |-- BingX VST:  open-api-vst.bingx.com
    |-- telemetry.jsonl / data/*
    `-- Quant Brain: /edge/evaluate, /kb/trades, sidecars
```

Principais módulos:

```text
src/app.ts                    Express, CORS, sessão e middleware
src/routes/bingx.ts           conexão e leitura da conta live
src/routes/bot.ts             gates, ordens, bulk e autopilot live
src/routes/demo.ts            Demo/VST, campanhas e Demo Sniper
src/routes/telemetry.ts       estado adaptativo e exportação
src/lib/botConfig.ts          ENV e overrides em memória
src/lib/candleEdge.ts         candles completos e edge técnico
src/lib/entryProtection.ts    confirmação e TP/SL anexado
src/lib/executionRisk.ts      custo, exposição e correlação
src/lib/executionSecurity.ts  isolamento demo/live e autorização
src/lib/aggressionController.ts PAUSED/DEFENSIVE/NORMAL/BOOST/MAX_SNIPER
src/lib/killSwitch.ts         breakers operacionais de entrada
src/lib/live_readiness.ts     promoção demo/shadow/micro/limited/live
src/lib/pipelineAuditor.ts    elegibilidade de treino e gaps de pipeline
src/lib/positionSizing.ts     tier, margem, alavancagem e risco
src/lib/strategyMemory.ts     regras maduras, decay, drift e recomendações
src/lib/symbolRotation.ts     HOT/ACTIVE/REDUCED/PAUSED/RECOVERY por símbolo
src/lib/serviceState.ts       HEALTHY/DEGRADED/SHADOW_ONLY/PAUSED
src/lib/stackingPolicy.ts     gates marginais de stacking
src/lib/vstOrderJournal.ts    idempotência e recovery VST
src/lib/vstAccounting.ts      invariantes contábeis VST
src/lib/quantBrainClient.ts   contrato edge-v3, cache e outbox
src/lib/telemetryStore.ts     outcomes e motor adaptativo
```

## Sessões E Credenciais

### Login

`POST /api/bingx/connect` recebe `apiKey` e `secretKey`, verifica o saldo na
BingX live e guarda as credenciais somente na sessão Express.

Conectar não libera execução real. A autorização de dinheiro real ocorre
novamente nas rotas de ordem.

### Demo VST

`POST /api/demo/connect` não recebe ID, API Key ou Secret. Ele reutiliza as
credenciais já guardadas no login e tenta acessar a API VST.

Isso evita reenviar o segredo pelo navegador. A mesma chave precisa possuir
acesso ao Demo Trading da BingX; caso contrário, a conexão VST será rejeitada.

As credenciais são copiadas para um campo de sessão separado com ambiente
`demo`, e o roteamento impede credenciais demo de resolver endpoints live.

### Administração

`X-Admin-Token` protege operações administrativas, como:

- override/reset de configuração;
- seleção/reset de modo;
- pausa/reset da máquina de estado;
- leitura do audit log de configuração.

O token administrativo não deve ser colocado no bundle público do frontend.

## Barreiras De Execução Real

Uma implantação live precisa declarar:

```env
EXECUTION_ENV=live
BINGX_CREDENTIAL_ENV=live
REAL_EXECUTION_ENABLED=true
REAL_EXECUTION_CONFIRMATION=I_ACKNOWLEDGE_REAL_MONEY
LIVE_ACCOUNT_ID=<identidade-aprovada>
ADMIN_API_TOKEN=<token-operacional>
SCALP_ALLOW_EXECUTION=false
```

O startup é recusado quando:

- `EXECUTION_ENV` não é `demo` ou `live`;
- ambiente de credencial diverge do ambiente de execução;
- demo tenta iniciar com `REAL_EXECUTION_ENABLED=true`;
- live não possui confirmação, conta ou token;
- live tenta carregar configuração persistida.

Mesmo em deployment live, cada ordem chama `assertLiveExecutionAllowed()` e
confere `LIVE_ACCOUNT_ID`. Ative `SCALP_ALLOW_EXECUTION=true` somente após
validação operacional independente.

## Pipeline De Entrada

Uma entrada pode ser rejeitada por:

- kill switch e estado do serviço;
- live readiness do escopo símbolo/lado/playbook/regime;
- pipeline sem proveniência ou sem elegibilidade de aprendizado;
- aggression controller em `PAUSED` ou redução operacional;
- symbol rotation em `PAUSED` ou limite por símbolo atingido;
- sessão sem credenciais;
- símbolo ou hora bloqueados;
- regime BTC incompatível;
- limite de posições, margem, concentração ou exposição;
- proteção contra hedge no mesmo símbolo;
- candle incompleto, atrasado, com gaps, score baixo ou mercado lateral;
- EV, win rate, profit factor ou toxicidade;
- edge recente negativo ou sequência recente de perdas;
- custo estimado maior que o edge;
- correlação excessiva em lote;
- evento/candle já executado;
- Quant Brain indisponível em modo `enforce`;
- stacking sem novo evento, probabilidade calibrada ou capacidade.

TP e SL podem ser anexados à ordem pela BingX quando
`SCALP_ATTACH_PROTECTION_ORDERS=true`.

## Controles Adaptativos

Os controles abaixo atuam juntos nas rotas live, bulk, sniper mass e autopilot.
Eles bloqueiam apenas novas entradas; monitoramento, closes, watcher, Exit
Intelligence e telemetria continuam rodando.

| Controle | Endpoint | Papel |
|---|---|---|
| Aggression Controller | `GET /api/aggression/status` | ajusta agressividade por drawdown, slippage, estado do serviço, pressão de posições e telemetria |
| Kill Switch | `GET /api/kill-switch/status` | transiciona entre `RUNNING`, `CAUTION`, `SOFT_PAUSE`, `HARD_PAUSE`, `RECOVERY` e `RESUME` |
| Live Readiness | `GET /api/live-readiness/status` | aprova escopos para `DEMO_ONLY`, `SHADOW_LIVE`, `MICRO_LIVE`, `LIMITED_LIVE`, `STANDARD_LIVE` ou `SUSPENDED` |
| Symbol Rotation | `GET /api/symbol-rotation/status` | calcula `rotationScore`, `sideBias`, alocação, limite por símbolo e estado HOT/ACTIVE/REDUCED/PAUSED/RECOVERY |
| Position Sizing | `GET /api/position-sizing/status` | escolhe tier `MICRO`, `SCOUT`, `BASE`, `BOOST`, `AGGRESSIVE` ou `MAX_SNIPER` |
| Strategy Memory | `GET /api/strategy-memory/status` | consolida regras maduras com evidência, decay, drift, conflitos e recomendações |
| Pipeline Audit | `GET /api/pipeline/audit` | mostra health, gaps por etapa, elegíveis/bloqueados para treino e falhas críticas |
| Execution Audit | `GET /api/execution/audit` | resume latência, slippage, spread, price move durante latência, drag e qualidade de execução |

`POST /api/bot/sniper/mass` retorna um bloco `rotation` por candidato e usa
`rotationScore`, `allocationWeight`, estado de agressividade e tier de sizing
para ordenar candidatos, limitar posições e ajustar margem por trade.

## Stacking E Execução Em Massa

### Live

O stacking live é controlado por:

```env
SCALP_POSITION_STACKING_ENABLED=false
SCALP_MAX_POSITIONS_PER_SYMBOL=1
SCALP_MAX_CONCURRENT_POSITIONS=10
SCALP_AUTOPILOT_INTERVAL_SEC=20
SCALP_AUTOPILOT_MAX_CANDIDATES=8
SCALP_SNIPER_MIN_COMBINED_SCORE=0.20
```

Endpoints:

```text
POST /api/bot/sniper/mass
POST /api/bot/sniper/autopilot/start
POST /api/bot/sniper/autopilot/stop
GET  /api/bot/sniper/autopilot/status
POST /api/bot/order/bulk
```

Bulk e mass execution compartilham contexto de capital para reduzir chamadas e
mantêm limite de correlação e deduplicação por evento.

### Demo/VST

O Demo Sniper roda no servidor, independente da aba do navegador:

```env
DEMO_SNIPER_GLOBAL_MAX=50
DEMO_SNIPER_PER_SYMBOL_MAX=10
DEMO_SNIPER_CYCLE_MS=30000
DEMO_SNIPER_MONITOR_MS=12000
DEMO_STACKING_COOLDOWN_MS=60000
DEMO_STACKING_MAX_CAMPAIGN_DRAWDOWN_PCT=5
```

Cada campanha recebe deterministicamente um cap de controle `1`, `3`, `5` ou
`10`. Entradas de profundidade 2+ exigem:

- mesma direção da campanha;
- edge não inferior ao da entrada anterior;
- probabilidade calibrada mínima de `0.55`;
- incerteza aceitável;
- cooldown concluído;
- novo `marketEventId` ou novo fingerprint;
- margem não crescente, bloqueando martingale;
- drawdown e capacidade dentro dos limites.

O relatório `/api/demo/stacking/audit` usa holdout cronológico e mede a
expectativa marginal de cada profundidade.

## Máquina De Estado Operacional

Estados:

| Estado | Novas entradas | Monitor/close/reconcile |
|---|---|---|
| `HEALTHY` | normal | ativo |
| `DEGRADED` | permitido com redução operacional | ativo |
| `SHADOW_ONLY` | somente primeira entrada exploratória por campanha VST | ativo |
| `PAUSED` | bloqueado | ativo |

Defaults atuais:

| Variável | Default |
|---|---:|
| `QB_FAILURE_DEGRADED` | `3` |
| `QB_FAILURE_SHADOW` | `8` |
| `API_ERROR_DEGRADED` | `5` |
| `API_ERROR_SHADOW` | `15` |
| `CONSECUTIVE_LOSS_DEGRADED` | `8` |
| `CONSECUTIVE_LOSS_PAUSE` | `15` |
| `ROLLING_LOSS_PCT_DEGRADED` | `-5` |
| `ROLLING_LOSS_PCT_PAUSE` | `-10` |
| `ROLLING_LOSS_WINDOW_MS` | `14400000` |
| `STALE_DATA_SHADOW_MS` | `90000` |

O limite absoluto `ROLLING_LOSS_PAUSE_USD` fica desabilitado por default em VST
com `-999999`; os breakers relativos à equity são primários.

## Quant Brain

Configuração:

```env
QUANT_BRAIN_ENABLED=true
QUANT_BRAIN_URL=http://localhost:9000
QUANT_BRAIN_API_TOKEN=<mesmo-token-do-quant>
QUANT_BRAIN_GATE_MODE=shadow
```

Modos:

- `off`: não consulta o gate;
- `shadow`: registra e exibe a decisão, mas indisponibilidade não bloqueia;
- `enforce`: indisponibilidade ou rejeição bloqueia a entrada.

O backend:

- envia avaliações para `POST /edge/evaluate`;
- valida rigorosamente respostas `edge-v3`;
- sincroniza trades em `/kb/trades` e `/kb/trades/batch`;
- envia outcomes com timestamps/preços de execução, versões de estratégia,
  config, modelo, policy e label;
- consome auditoria de execução, score calibration, position sizing e demais
  sidecars operacionais;
- consulta saúde, modelo, signal edge e notícias para a tela IA Sniper;
- mantém outcomes pendentes em
  `data/quant-brain-outbox.json` por default;
- limita retries por minuto e usa cache stale para sidecars.

`Quant online` no dashboard depende de `GET /health/live` responder. Um serviço
marcado como running pela cloud pode continuar aparecendo offline se o domínio
retornar `502`, timeout ou não estiver escutando em `$PORT`.

## Telemetria E Persistência

`telemetry.jsonl` contém outcomes operacionais. O motor adaptativo reconstrói:

```text
symbol + side + hourUtc + btcRegime
  -> samples, win rate, avg win/loss, EV, PF, fee drag, toxicity
```

Dados VST adicionais ficam sob `data/`, incluindo journal de ordens, campanhas
e outbox do Quant. Escritas críticas usam arquivo temporário + rename e/ou fila
serializada.

Em cloud, use volume persistente. Sem volume, deploy/restart pode perder dados
locais que ainda não foram enviados ao PostgreSQL/Quant Brain.

## Variáveis Principais

Consulte `.env.example` para a lista completa.

### Estratégia

```env
SCALP_LEVERAGE=14
SCALP_MARGIN_PER_TRADE=5
SCALP_TAKE_PROFIT_PCT=0.15
SCALP_STOP_LOSS_PCT=0.10
SCALP_MAX_MARGIN_UTILIZATION=0.5
SCALP_TAKER_FEE_BPS=5
SCALP_SLIPPAGE_BPS_PER_SIDE=2
SCALP_ESTIMATED_FUNDING_COST_PCT=0
SCALP_MIN_EDGE_OVER_COST_PCT=0.03
```

### Gates

```env
SCALP_EV_MIN_THRESHOLD=0
SCALP_WIN_RATE_MIN=0
SCALP_PROFIT_FACTOR_MIN=0
SCALP_RECENT_EDGE_WINDOW_HOURS=4
SCALP_RECENT_EDGE_MIN_TRADES=8
SCALP_RECENT_EDGE_MIN_PROFIT_FACTOR=0.8
SCALP_RECENT_EDGE_MAX_CONSECUTIVE_LOSSES=4
SCALP_CANDLE_MIN_SCORE=0.5
SCALP_CANDLE_MIN_SEPARATION=0.08
SCALP_PREVENT_HEDGED_POSITIONS=true
```

Valores `0` podem desativar gates. Isso é útil para coleta em observação, mas
não prova segurança para capital real.

### Position Sizing

```env
POSITION_SIZING_ENABLED=true
BASE_RISK_PCT=0.25
MAX_RISK_PCT_PER_TRADE=0.75
MAX_TOTAL_RISK_PCT=3
MAX_SYMBOL_RISK_PCT=1
MIN_MARGIN=1
```

O sizing combina score calibrado, rotação, qualidade de execução, drawdown,
profundidade de stacking e risco global. Stacking não pode aumentar margem em
sequência de perda por regra anti-martingale.

## Endpoints

```text
GET  /api/healthz
GET  /api/runtime/metrics
GET  /api/service-state
POST /api/service-state/pause              [admin]
POST /api/service-state/reset              [admin]
GET  /api/aggression/status
GET  /api/kill-switch/status
GET  /api/live-readiness/status
GET  /api/symbol-rotation/status
GET  /api/position-sizing/status
GET  /api/strategy-memory/status
GET  /api/pipeline/audit
GET  /api/execution/audit
GET  /api/score-calibration/status

POST /api/bingx/connect
POST /api/bingx/disconnect
GET  /api/bingx/market/ticker
GET  /api/bingx/balance
GET  /api/bingx/positions
GET  /api/bingx/orders
GET  /api/bingx/summary

GET  /api/bot/config
GET  /api/bot/config/audit                 [admin]
PATCH /api/bot/config/override             [admin]
POST /api/bot/config/override/reset        [admin]
GET  /api/bot/market-data-quality
GET  /api/bot/sentiment
GET  /api/bot/scan
GET  /api/bot/edge
GET  /api/bot/intelligence
POST /api/bot/order
POST /api/bot/close
POST /api/bot/order/bulk
GET  /api/bot/modes
POST /api/bot/mode                         [admin]
POST /api/bot/mode/reset                   [admin]
POST /api/bot/sniper/mass
POST /api/bot/sniper/autopilot/start
POST /api/bot/sniper/autopilot/stop
GET  /api/bot/sniper/autopilot/status
GET  /api/bot/watcher

POST /api/demo/connect
POST /api/demo/disconnect
GET  /api/demo/status
GET  /api/demo/positions
GET  /api/demo/analysis-state
POST /api/demo/risk-check
POST /api/demo/order
POST /api/demo/close
POST /api/demo/sniper/start
POST /api/demo/sniper/stop
GET  /api/demo/sniper/status
GET  /api/demo/campaign
GET  /api/demo/campaign/summary
GET  /api/demo/stacking/audit
GET  /api/demo/model-readiness

GET  /api/telemetry/state
GET  /api/telemetry/recommendation
POST /api/telemetry/outcome
GET  /api/telemetry/context
GET  /api/telemetry/rank
GET  /api/telemetry/export
GET  /api/telemetry/live
```

## Rodar Local

```powershell
cd backend
pnpm install
Copy-Item .env.example .env
pnpm run build
pnpm run start
```

Healthcheck:

```text
GET http://localhost:8080/api/healthz
```

O frontend Vite usa proxy `/api` para `http://localhost:8080`.

## Deploy Railway

```text
Root Directory: backend
Build Command: pnpm run build
Start Command: pnpm run start
Healthcheck Path: /api/healthz
```

Configure `SESSION_SECRET`, CORS e todos os segredos no gerenciador da cloud.
`CORS_ORIGIN` aceita uma lista separada por vírgulas. Sem configuração, o
backend aceita qualquer origem, comportamento adequado apenas para ambiente
controlado.

## Validação

```powershell
pnpm run build
pnpm run test:security
pnpm run typecheck
```

O typecheck inclui testes TypeScript e exige todas as dependências de teste
instaladas. O build de produção é gerado em `dist/`.

## Dados Que Não Devem Ir Para Git

```text
.env
dist/
node_modules/
telemetry.jsonl
data/
*.log
```

Segredos exibidos em terminal, editor, screenshot ou chat devem ser revogados e
substituídos.

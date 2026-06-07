# BingX API Server

Backend standalone do BingX Futures Terminal.

Este projeto e privado, pessoal e operacional de uso privado. 


## Objetivo

O servidor executa a camada segura entre o dashboard e a BingX Futures API:

- mantem API Key e Secret Key somente na sessao server-side;
- assina chamadas BingX com HMAC-SHA256 no backend;
- aplica gates de risco antes de enviar ordens;
- registra resultados realizados em telemetria append-only;
- recalibra edge, win rate, profit factor e toxicidade a partir do historico;
- permite operar em modo observacao antes de liberar execucao real.

O objetivo operacional e buscar PnL massivo por acumulacao de alvos curtos, nao por uma unica entrada grande. A estrategia mira lucros pequenos por posicao, como `0.50`, `1.00` ou `2.00` USDT, repetidos em massa quando varios simbolos passam pelos gates. Exemplo: `0.50 USDT x 100 posicoes de entrada = 50 USDT` de PnL bruto potencial em poucos minutos, porque o take profit e curto e a execucao e desenhada para alta rotacao controlada.

O painel de telemetria existe para mostrar se essa tese esta funcionando na pratica: quais simbolos, horarios, regimes BTC e lados de operacao estao realmente gerando lucro liquido depois de taxa, slippage e perdas. O foco nao e quantidade de trades; e repeticao de micro-edge positivo com controle de risco.

Fluxo principal:

```text
BTC regime -> setup alt -> EV/risk gate -> BingX order -> realized PnL -> telemetry -> adaptive edge
```

## Stack

- Node.js 24+
- pnpm 10+
- TypeScript 5.9
- Express 5
- express-session
- pino / pino-http
- esbuild
- zod
- BingX Swap V2 REST API

## Estrutura

```text
backend/
  src/
    app.ts                  Express, CORS, session, routes
    index.ts                boot HTTP usando PORT
    routes/
      bingx.ts              proxy BingX autenticado
      bot.ts                config, scan, edge, modos e ordens
      demo.ts               rotas demo/VST e simulacoes
      health.ts             healthcheck Railway
      telemetry.ts          estado, rank, contexto e export da telemetria
    lib/
      adaptiveEngine.ts     inteligencia de edge adaptativo
      botConfig.ts          leitura de ENV + overrides em memoria
      botModes.ts           presets Easy, Standard, Aggressive e token bucket
      candleEdge.ts         leitura de candles e sinais tecnicos
      executionRisk.ts      fee drag, custo e limite de ordens correlacionadas
      telemetryStore.ts     storage JSONL + rebuild do motor adaptativo
      logger.ts             logger pino
  package.json
  railway.json
  pnpm-lock.yaml
  pnpm-workspace.yaml
```

## Rodar Local

```bash
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

Resposta esperada:

```json
{"status":"ok"}
```

## Deploy Railway

Configure o servico Railway apontando para o repositorio Git.

```text
Root Directory: backend
Build Command: pnpm run build
Start Command: pnpm run start
Healthcheck Path: /api/healthz
```

O arquivo `railway.json` ja declara:

```json
{
  "build": {
    "builder": "RAILPACK",
    "buildCommand": "pnpm run build"
  },
  "deploy": {
    "startCommand": "pnpm run start",
    "healthcheckPath": "/api/healthz",
    "healthcheckTimeout": 30
  }
}
```

As variaveis de producao devem ser cadastradas no painel do Railway. Nao commitar `.env`.

## Variaveis De Ambiente

### Runtime

| Variavel | Obrigatoria | Padrao | Uso |
|---|---:|---:|---|
| `PORT` | Nao | `8080` | Porta HTTP. No Railway normalmente e injetada automaticamente. |
| `SESSION_SECRET` | Sim | fallback inseguro | Segredo usado pelo `express-session`. Use uma string longa e aleatoria. |
| `LOG_LEVEL` | Nao | `info` | Nivel do logger pino: `debug`, `info`, `warn`, `error`. |
| `PRETTY_LOGS` | Nao | `false` | Ativa logs legiveis localmente. Em cloud, deixar `false`. |
| `QUANT_BRAIN_ENABLED` | Nao | `true` | Liga/desliga o espelhamento de trades fechados para o Quant Brain. |
| `QUANT_BRAIN_URL` | Nao | vazio | URL do Quant Brain. Se vazio, o backend opera sozinho. |

Gerar `SESSION_SECRET`:

```bash
openssl rand -hex 32
```

### Execucao

| Variavel | Padrao | Uso |
|---|---:|---|
| `SCALP_ALLOW_EXECUTION` | `false` | Kill switch principal. `false` avalia gates sem enviar ordens reais; `true` permite ordens BingX. |
| `SCALP_LEVERAGE` | `14` | Alavancagem aplicada no calculo de posicao. |
| `SCALP_MARGIN_PER_TRADE` | `5` | Margem em USDT por entrada. |
| `SCALP_MAX_CONCURRENT_POSITIONS` | `10` | Bloqueia novas entradas se ja houver posicoes abertas demais. |
| `SCALP_MAX_MARGIN_UTILIZATION` | `0.5` | Percentual maximo da margem disponivel que pode estar comprometido. |
| `SCALP_MAX_SESSION_LOSS` | `20` | Perda maxima da sessao antes de suspender execucao. |
| `SCALP_ORDER_TYPE` | `MARKET` | Tipo de ordem usado pelo bot. |
| `SCALP_MARGIN_TYPE` | `ISOLATED` | Tipo de margem: `ISOLATED` ou `CROSS`. |

Use `SCALP_ALLOW_EXECUTION=false` ate a telemetria provar edge positivo. O backend foi desenhado para observar muito e executar pouco.

### Take Profit E Stop Loss

| Variavel | Padrao | Uso |
|---|---:|---|
| `SCALP_TAKE_PROFIT_PCT` | `0.15` | Movimento percentual alvo a partir da entrada. Ex: `0.15` = 0.15%. |
| `SCALP_STOP_LOSS_PCT` | `0.10` | Movimento percentual maximo contra a posicao. Ex: `0.10` = 0.10%. |

Com alavancagem, movimentos pequenos viram variacao maior sobre a margem. Exemplo: 0.15% com 14x equivale a cerca de 2.1% sobre margem antes de taxas.

### Gates De Edge

| Variavel | Padrao | Uso |
|---|---:|---|
| `SCALP_EV_MIN_THRESHOLD` | `0.0` | EV minimo por trade. EV = `(win_rate * avg_win) - (loss_rate * abs(avg_loss))`. |
| `SCALP_WIN_RATE_MIN` | `0.0` | Win rate historico minimo para permitir entrada. `0` desativa o gate. |
| `SCALP_PROFIT_FACTOR_MIN` | `0.0` | Profit factor minimo. `0` desativa o gate. |
| `SCALP_TAKER_FEE_RATE` | `0.0005` | Taxa taker estimada usada no fee drag. |
| `SCALP_FEE_DRAG_BUFFER_MULTIPLIER` | `1.5` | Multiplicador de seguranca sobre custo de taxa round-trip. |

Esses valores devem ser calibrados pela telemetria, nao por chute. Comece permissivo em observacao, colete amostra, depois endureca gates.

### Regime BTC E Sinais

| Variavel | Padrao | Uso |
|---|---:|---|
| `SCALP_BTC_REGIME_REQUIRED` | `false` | Quando `true`, exige BTC com direcao clara antes de liberar entradas. |
| `SCALP_ALLOW_COUNTER_REGIME_SCALP` | `true` | Permite scalp contra regime quando a logica considerar valido. |
| `SCALP_BTC_REGIME_THRESHOLD_PCT` | `0.5` | Percentual de variacao 24h para classificar BTC como bull/bear. |
| `SCALP_SYMBOLS` | vazio | Allowlist de pares separados por virgula. Vazio = sem restricao. |
| `SCALP_HOUR_BLACKLIST` | vazio | Horas UTC bloqueadas, separadas por virgula. Ex: `2,3,4`. |

Exemplo:

```env
SCALP_SYMBOLS=BTC-USDT,ETH-USDT,SOL-USDT,BNB-USDT
SCALP_HOUR_BLACKLIST=2,3,4
```

### Bulk E Correlacao

| Variavel | Padrao | Uso |
|---|---:|---|
| `SCALP_MAX_CORRELATED_BULK_ORDERS` | `3` | Limite defensivo para reduzir varias entradas altamente correlacionadas no mesmo lote. |

O modo Aggressive usa token bucket para respeitar o limite operacional da BingX. Mesmo em bulk, cada ordem passa pelos gates.

## Inteligencia De Telemetria E Edge

A telemetria e o centro tecnico do projeto. O backend registra outcomes realizados em `telemetry.jsonl`, um arquivo JSONL append-only no diretorio de execucao.

Hoje o codigo salva telemetria de resultado realizado, nao conversa, nao prompt e nao dado generico de usuario. O que entra no arquivo e o historico tecnico de operacao usado para recalibrar o motor adaptativo.

Cada outcome pode conter:

- simbolo;
- lado da posicao;
- regime BTC;
- horario UTC;
- preco esperado e executado;
- slippage de entrada e saida;
- fee total;
- gross PnL;
- realized PnL;
- motivo de saida;
- margem usada;
- alavancagem.

Na inicializacao, `telemetryStore.ts` le esse arquivo e reconstrui o estado do `AdaptiveEngine`. Em runtime, cada novo trade e gravado no JSONL e aplicado imediatamente no motor em memoria.

Essa "IA" do projeto e uma inteligencia adaptativa baseada em estatistica de resultado. Ela aprende com trades fechados: se determinado simbolo, horario, lado e regime BTC deram lucro ou prejuizo, qual foi o win rate, qual foi o lucro medio, qual foi a perda media, quanto a taxa comeu do resultado e se aquele contexto virou toxico.

O objetivo nao e prever mercado de forma generica. O objetivo e medir se o proprio sistema tem edge em contextos especificos:

```text
symbol + hourUtc + btcRegime + side -> win rate + avg win + avg loss + EV + toxicity
```

O backend usa essa inteligencia para:

- rejeitar simbolos com historico ruim;
- reduzir trades em horarios toxicos;
- comparar EV esperado contra fee drag;
- ranquear entradas;
- separar performance por regime bull/bear;
- detectar deterioracao do edge por janela recente;
- impedir execucao quando custo/risco supera a vantagem medida.

Esse arquivo nao deve ser commitado. Ele e dado operacional privado.

## Modos De Operacao

Os presets vivem em `src/lib/botModes.ts` e sao overrides em memoria. Reiniciar o servidor volta para os valores de ENV.

| Modo | Badge | Margem | Alavancagem | Uso |
|---|---|---:|---:|---|
| Easy | SCOUT | `0.50` USDT | `18x` | Calibracao com exposicao minima. |
| Standard | SNIPER | `2.00` USDT | `18x` | Operacao normal apos edge positivo. |
| Aggressive | ALPHA | `5.00` USDT | `18x` | Bulk execution quando multiplos simbolos passam pelos gates. |

Endpoints:

```text
GET  /api/bot/modes
POST /api/bot/mode
POST /api/bot/mode/reset
POST /api/bot/order/bulk
```

## Endpoints Principais

```text
GET  /api/healthz

POST /api/bingx/connect
POST /api/bingx/disconnect
GET  /api/bingx/wallet
GET  /api/bingx/positions
GET  /api/bingx/orders
GET  /api/bingx/ticker

GET  /api/bot/config
PATCH /api/bot/config
POST /api/bot/config/reset
GET  /api/bot/edge
GET  /api/bot/scan
POST /api/bot/order
POST /api/bot/order/bulk

GET  /api/telemetry/state
GET  /api/telemetry/recommendation
POST /api/telemetry/outcome
GET  /api/telemetry/context
GET  /api/telemetry/rank
GET  /api/telemetry/export
```

## Integracao Com Quant Brain

Quando `QUANT_BRAIN_URL` estiver configurado, todo outcome gravado pelo backend e espelhado para:

```text
POST {QUANT_BRAIN_URL}/kb/trades
```

Isso fecha o ciclo operacional:

```text
trade fechado -> backend telemetry.jsonl -> Quant Brain knowledge.db -> recomendacao/gate
```

O sync e nao bloqueante. Se o Quant Brain estiver offline, a execucao e a telemetria local continuam funcionando.

## Seguranca

- API Key e Secret Key ficam apenas na sessao do servidor.
- Secret Key nunca deve ir para frontend, Git, log ou banco.
- Chamadas BingX autenticadas sao assinadas no backend com HMAC-SHA256.
- Sessao em memoria e perdida em restart, exigindo reconexao.
- Use API Key da BingX sem permissao de saque.
- Comece sempre com `SCALP_ALLOW_EXECUTION=false`.
- Nao commitar `.env`, `telemetry.jsonl`, logs, `node_modules` ou `dist`.

## Gitignore Local

Este backend deve manter fora do Git:

```text
node_modules/
dist/
.env
.tsbuildinfo
telemetry.jsonl
*.log
```

O que deve ir para Git:

```text
src/
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
railway.json
.env.example
.npmrc
README.md
tsconfig.json
build.mjs
```
## Observacoes Operacionais

- `DATABASE_URL` nao e usado pelo backend isolado atual.
- A telemetria atual persiste em arquivo local JSONL, nao em Postgres.
- Em Railway, filesystem pode nao ser persistente entre deploys dependendo da configuracao. Para telemetria duravel em cloud, use volume persistente ou migre `telemetryStore.ts` para banco.
- O endpoint `/api/telemetry/export` existe para backup/exportacao dos outcomes.
- O frontend deve chamar este backend pela URL publica do Railway.
- CORS esta permissivo com `origin: true` e `credentials: true`; se o projeto for exposto publicamente, endureca essa politica.

## Scripts

```bash
pnpm run build      # gera dist/
pnpm run start      # roda dist/index.mjs
pnpm run dev        # build + start
pnpm run typecheck  # valida TypeScript sem emitir build
```

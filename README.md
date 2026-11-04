# 🖥️ UpgradeLab BR — Bot de Alerta de Preços no Discord + Simulador AM4/AM5

Monitor automático de preços de hardware no Brasil (**Pichau, KaBuM!, Terabyte, Amazon, Waz, FGTEC e Mercado Livre**) rodando gratuitamente a cada 30 minutos via **GitHub Actions** e enviando alertas no **Discord** via Webhook.

Inclui também o **Simulador Interativo (`index.html`)** para comparar combos de CPU + GPU, calcular gargalos, custo por FPS e exportar suas metas personalizadas para o `targets.json`.

---

## 📦 Estrutura do Projeto

- [`monitor.js`](./monitor.js) — Script Node.js 20+ (zero dependências externas) que consulta:
  1. **API MeuPC.net (`/api/pesquisa-rapida`)** com handshake CSRF automático (agrega Pichau, KaBuM!, Terabyte, Amazon, Waz, FGTEC e Mercado Livre).
  2. **Página da Peça MeuPC.net (`/peca/{hash}/{slug}`)** como fallback direto.
  3. **Catálogo SSR da KaBuM! (`__NEXT_DATA__`)** para validação direta de estoque à vista no PIX.
- [`targets.json`](./targets.json) — Lista de peças monitoradas com metas de compra imediata (`targetGreen`) e alerta amarelo de cupom (`targetYellow`).
- [`.github/workflows/monitor.yml`](./.github/workflows/monitor.yml) — Workflow do GitHub Actions agendado a cada 30 minutos (`*/30 * * * *`) e com botão de execução manual (`workflow_dispatch`).
- `alert-state.json` — Estado dos alertas já enviados (guardado no cache do GitHub Actions, fora do git). Cada peça só gera alerta na primeira vez que bate a meta, quando sobe de amarelo para verde ou quando o preço cai ainda mais. Se o preço voltar a subir acima da meta, o estado zera e a próxima queda avisa de novo.
- [`index.html`](./index.html) — Painel interativo **UpgradeLab BR** (Simulador de FPS, Semáforo Multi-lojas e Testador de Webhook do Discord).

---

## 🚀 Como Ativar os Alertas no Discord (2 Minutos)

### 1. Crie o Webhook no seu Servidor do Discord
1. No seu servidor do Discord, clique na engrenagem **Editar Canal** (ex: `#alertas-hardware`) → **Integrações** → **Webhooks** → **Novo Webhook**.
2. Copie a **URL do Webhook** (`https://discord.com/api/webhooks/...`).

### 2. Salve a URL nos Secrets do GitHub
Você pode configurar pela interface web do GitHub ou direto pelo terminal com o GitHub CLI (`gh`):

**Opção A — Pelo Terminal (1 comando):**
```bash
gh secret set DISCORD_WEBHOOK_URL --body "https://discord.com/api/webhooks/SEU_ID/SEU_TOKEN"
```

**Opção B — Pelo Site do GitHub:**
1. Acesse **Settings** → **Secrets and variables** → **Actions** no repositório.
2. Clique em **New repository secret**.
3. Nome: `DISCORD_WEBHOOK_URL`
4. Valor: Cole a URL do seu Webhook e salve.

### 3. Teste em 1 Clique
- Vá na aba **Actions** do repositório → **Monitor de Preços Hardware BR** → clique em **Run workflow**.
- Quando acionado manualmente, além dos alertas individuais (🟢 / 🟡), o bot envia automaticamente um **📊 Relatório Resumo de Preços Atuais** para o seu canal do Discord!

---

## 💻 Como Testar Localmente no Terminal

Requer **Node.js 20+**:

```bash
# Testar varredura real de preços no terminal (sem precisar de Webhook)
npm run dry-run

# Disparar alertas + tabela de resumo completa para o Discord
$env:DISCORD_WEBHOOK_URL="https://discord.com/api/webhooks/..."
npm run summary
```

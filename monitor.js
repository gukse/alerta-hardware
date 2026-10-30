// monitor.js — Bot de Alerta de Preços de Hardware BR (Node.js 20+)
import fs from 'node:fs/promises';

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const forceSummary =
  args.includes('--summary') ||
  process.env.SEND_SUMMARY === 'true';

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
if (!WEBHOOK_URL && !isDryRun) {
  console.error('❌ Defina a variável de ambiente DISCORD_WEBHOOK_URL (ou use --dry-run para testar no terminal).');
  process.exit(1);
}

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function matchesFilters(title, item) {
  const lower = (title || '').toLowerCase();
  const mustInclude = item.mustInclude || [];
  const mustExclude = item.mustExclude || ['pc gamer', 'computador', 'notebook'];
  if (!mustInclude.every(kw => lower.includes(kw.toLowerCase()))) return false;
  if (mustExclude.some(kw => lower.includes(kw.toLowerCase()))) return false;
  return true;
}

// Inicializa sessão CSRF do MeuPC.net para consultas na API oficial de busca rápida
async function createMeuPcSession() {
  try {
    const res = await fetch('https://meupc.net/', {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR,pt;q=0.9' }
    });
    const setCookies = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    const cookieHeader = setCookies.map(c => c.split(';')[0]).join('; ');
    const csrf = cookieHeader.match(/ci_csrf_cookie=([^;]+)/)?.[1] || '';
    if (!csrf) return null;
    return { cookieHeader, csrf };
  } catch {
    return null;
  }
}

// Fonte 1: API MeuPC.net (agrega Pichau, KaBuM!, Terabyte, Amazon, Mercado Livre, Waz, FGTEC)
async function fetchMeuPcApiPrice(session, item, minSanityPrice) {
  if (!session) return null;
  try {
    const fd = new FormData();
    fd.append('ci_csrf_token', session.csrf);
    const url = `https://meupc.net/api/pesquisa-rapida?q=${encodeURIComponent(item.query)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'User-Agent': USER_AGENT,
        Cookie: session.cookieHeader,
        Referer: 'https://meupc.net/',
        Origin: 'https://meupc.net'
      },
      body: fd
    });
    if (!res.ok) return null;
    const data = await res.json();
    const candidates = (data.peca || [])
      .filter(p => {
        const pricePix = parseFloat(p.preco_boleto);
        if (!pricePix || pricePix < minSanityPrice) return false;
        if (item.mustInclude?.length) {
          return matchesFilters(p.titulo, item);
        }
        return true;
      })
      .map(p => ({
        title: p.titulo,
        price: parseFloat(p.preco_boleto),
        priceInstallment: parseFloat(p.preco) || parseFloat(p.preco_boleto),
        store: `${p.loja || 'Menor Loja'} (via MeuPC.net)`,
        link: `https://meupc.net/peca/${p.hash}/${p.slug}`
      }))
      .sort((a, b) => a.price - b.price);

    return candidates[0] || null;
  } catch {
    return null;
  }
}

// Fonte 2: Página direta da peça no MeuPC.net (fallback por slug com hash)
async function fetchMeuPcPagePrice(item, minSanityPrice) {
  if (!item.meupcSlug) return null;
  try {
    const url = `https://meupc.net/peca/${item.meupcSlug}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR,pt;q=0.9' }
    });
    if (!res.ok) return null;
    const html = await res.text();

    const matches = [...html.matchAll(/R\$\s?(\d{1,2}\.\d{3},\d{2})/g)];
    const prices = matches
      .map(m => parseFloat(m[1].replace(/\./g, '').replace(',', '.')))
      .filter(p => p >= minSanityPrice);

    if (!prices.length) return null;
    return {
      title: item.name,
      price: Math.min(...prices),
      store: 'Agregador MeuPC (Página da Peça)',
      link: url
    };
  } catch {
    return null;
  }
}

// Fonte 3: Catálogo SSR da KaBuM! (__NEXT_DATA__)
async function fetchKabumPrice(item, minSanityPrice) {
  const slugQuery = item.kabumQuery || item.query.toLowerCase().replace(/\s+/g, '-');
  try {
    const url = `https://www.kabum.com.br/busca/${encodeURIComponent(slugQuery)}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'pt-BR,pt;q=0.9' }
    });
    if (!res.ok) return null;
    const html = await res.text();
    const nextData = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);
    if (!nextData) return null;

    const json = JSON.parse(nextData[1]);
    const rawData = json.props?.pageProps?.data;
    const parsed = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
    const catalog = parsed?.catalogServer?.data || [];

    const valid = catalog
      .filter(prod => {
        if (!prod.available) return false;
        const price = parseFloat(prod.priceWithDiscount || prod.price);
        if (!price || price < minSanityPrice) return false;
        return matchesFilters(prod.name, item);
      })
      .map(prod => ({
        title: prod.name,
        price: parseFloat(prod.priceWithDiscount || prod.price),
        priceInstallment: parseFloat(prod.price || prod.priceWithDiscount),
        store: 'KaBuM! (Estoque Direto)',
        link: `https://www.kabum.com.br/produto/${prod.code}`
      }))
      .sort((a, b) => a.price - b.price);

    return valid[0] || null;
  } catch {
    return null;
  }
}

function formatBRL(value) {
  return value.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function sendDiscordAlert(item, offer, level) {
  if (isDryRun) return;
  const isGreen = level === 'GREEN';
  const embed = {
    title: `${isGreen ? '🟢 COMPRA IMEDIATA' : '🟡 ALERTA AMARELO'}: ${item.name}`,
    url: offer.link,
    description: isGreen
      ? `🔥 **Bateu sua meta verde!** O preço caiu para **R$ ${formatBRL(offer.price)}** (meta: R$ ${formatBRL(item.targetGreen)}).`
      : `⚡ **Ficou muito próximo da meta!** Com cupom de 5% a 10% ou cashback já atinge o preço alvo.`,
    color: isGreen ? 3066993 : 16776960,
    fields: [
      { name: '💰 Preço PIX Encontrado', value: `**R$ ${formatBRL(offer.price)}**`, inline: true },
      { name: '🎯 Meta Verde', value: `R$ ${formatBRL(item.targetGreen)}`, inline: true },
      { name: '🏪 Loja / Origem', value: offer.store, inline: false },
      { name: '📦 Produto Identificado', value: offer.title || item.name, inline: false }
    ],
    footer: { text: 'UpgradeLab Bot • Monitor de Hardware BR' },
    timestamp: new Date().toISOString()
  };

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'UpgradeLab Price Bot',
      content: isGreen ? '@everyone 🚨 **Oferta atingiu o preço alvo de compra!**' : '',
      embeds: [embed]
    })
  });

  if (!res.ok) {
    console.error(`❌ Erro HTTP ${res.status} ao enviar alerta Discord para ${item.name}`);
  }
}

async function sendDiscordSummary(results) {
  if (isDryRun || !results.length) return;
  const fields = results.map(({ item, bestOffer, status }) => {
    if (!bestOffer) {
      return {
        name: `⚪ ${item.name}`,
        value: `Sem estoque no momento | Meta: R$ ${formatBRL(item.targetGreen)}`,
        inline: false
      };
    }
    const badge = status === 'GREEN' ? '🟢' : status === 'YELLOW' ? '🟡' : '🔴';
    const diff = bestOffer.price - item.targetGreen;
    const diffStr = diff <= 0 ? `(${formatBRL(diff)})` : `(+R$ ${formatBRL(diff)} acima da meta)`;
    return {
      name: `${badge} ${item.name}`,
      value: `[**R$ ${formatBRL(bestOffer.price)}**](${bestOffer.link}) na **${bestOffer.store}**\nMeta Verde: R$ ${formatBRL(item.targetGreen)} ${diffStr}`,
      inline: false
    };
  });

  const embed = {
    title: '📊 Relatório de Preços Atuais — UpgradeLab BR',
    description: 'Resumo das menores ofertas à vista (PIX) encontradas agora nas lojas brasileiras:',
    color: 6516465,
    fields,
    footer: { text: 'UpgradeLab Bot • Disparo Manual / Resumo de Monitoramento' },
    timestamp: new Date().toISOString()
  };

  const res = await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: 'UpgradeLab Price Bot',
      embeds: [embed]
    })
  });

  if (res.ok) {
    console.log('✅ Relatório resumo enviado com sucesso para o Discord!');
  } else {
    console.error(`❌ Erro HTTP ${res.status} ao enviar relatório resumo para o Discord.`);
  }
}

async function run() {
  const raw = await fs.readFile('./targets.json', 'utf-8');
  const targets = JSON.parse(raw);

  console.log(`🔎 Iniciando varredura de ${targets.length} peças de hardware...`);
  const session = await createMeuPcSession();
  const results = [];
  let alertsSent = 0;

  for (const item of targets) {
    const minSanityPrice = Math.round(item.targetGreen * 0.6); // Evita caixas vazias/acessórios
    const [meupcApi, meupcPage, kabum] = await Promise.all([
      fetchMeuPcApiPrice(session, item, minSanityPrice),
      fetchMeuPcPagePrice(item, minSanityPrice),
      fetchKabumPrice(item, minSanityPrice)
    ]);

    const candidates = [meupcApi, meupcPage, kabum].filter(Boolean);
    if (!candidates.length) {
      console.log(`⚪ [${item.name}] Nenhuma oferta em estoque encontrada.`);
      results.push({ item, bestOffer: null, status: 'NONE' });
      continue;
    }

    const bestOffer = candidates.reduce((a, b) => (a.price <= b.price ? a : b));
    const comparablePrice = Math.floor(bestOffer.price); // Trata R$ 4.999,99 como <= R$ 4.999
    let status = 'RED';
    if (comparablePrice <= item.targetGreen) {
      status = 'GREEN';
    } else if (comparablePrice <= item.targetYellow) {
      status = 'YELLOW';
    }

    const badge = status === 'GREEN' ? '🟢 COMPRA' : status === 'YELLOW' ? '🟡 ALERTA' : '🔴 ACIMA';
    console.log(
      `${badge} | ${item.name.padEnd(30)} | R$ ${formatBRL(bestOffer.price).padStart(9)} (Meta: R$ ${formatBRL(item.targetGreen)}) | ${bestOffer.store}`
    );

    results.push({ item, bestOffer, status });

    const allowYellowAlerts = process.env.ALERT_YELLOW === 'true' || args.includes('--yellow');
    if (status === 'GREEN' || (status === 'YELLOW' && allowYellowAlerts)) {
      await sendDiscordAlert(item, bestOffer, status);
      alertsSent++;
    }
  }

  if (forceSummary || (alertsSent === 0 && process.env.ALWAYS_NOTIFY === 'true')) {
    await sendDiscordSummary(results);
  }
}

run();

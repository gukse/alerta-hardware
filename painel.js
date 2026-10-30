// painel.js — Servidor Local de Configuração do Bot (Zero dependências, Node.js 20+)
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);
const PORT = process.env.PORT || 3333;
const TARGETS_PATH = path.resolve('./targets.json');
const PAINEL_HTML_PATH = path.resolve('./painel.html');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

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

async function searchLiveCatalog(query) {
  const session = await createMeuPcSession();
  const results = [];

  if (session) {
    try {
      const fd = new FormData();
      fd.append('ci_csrf_token', session.csrf);
      const url = `https://meupc.net/api/pesquisa-rapida?q=${encodeURIComponent(query)}`;
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
      if (res.ok) {
        const data = await res.json();
        for (const p of data.peca || []) {
          const pricePix = parseFloat(p.preco_boleto) || 0;
          results.push({
            title: p.titulo,
            pricePix,
            store: p.loja ? `${p.loja} (via MeuPC.net)` : 'Sem estoque atual',
            meupcSlug: `${p.hash}/${p.slug}`,
            link: `https://meupc.net/peca/${p.hash}/${p.slug}`
          });
        }
      }
    } catch {
      // ignora falha de rede
    }
  }

  return results;
}

function matchesFilters(title, item) {
  const lower = (title || '').toLowerCase();
  const mustInclude = item.mustInclude || [];
  const mustExclude = item.mustExclude || ['pc gamer', 'computador', 'notebook'];
  if (!mustInclude.every(kw => lower.includes(kw.toLowerCase()))) return false;
  if (mustExclude.some(kw => lower.includes(kw.toLowerCase()))) return false;
  return true;
}

async function checkAllPrices(targets) {
  const session = await createMeuPcSession();
  const checked = [];

  for (const item of targets) {
    const minSanityPrice = Math.round((item.targetGreen || 500) * 0.6);
    let bestOffer = null;

    if (session) {
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
        if (res.ok) {
          const data = await res.json();
          const valid = (data.peca || [])
            .filter(p => {
              const pricePix = parseFloat(p.preco_boleto);
              if (!pricePix || pricePix < minSanityPrice) return false;
              return item.mustInclude?.length ? matchesFilters(p.titulo, item) : true;
            })
            .map(p => ({
              title: p.titulo,
              price: parseFloat(p.preco_boleto),
              store: `${p.loja || 'Menor Loja'} (MeuPC.net)`,
              link: `https://meupc.net/peca/${p.hash}/${p.slug}`
            }))
            .sort((a, b) => a.price - b.price);
          if (valid[0]) bestOffer = valid[0];
        }
      } catch {
        // ignora erro
      }
    }

    if (!bestOffer && item.meupcSlug) {
      try {
        const url = `https://meupc.net/peca/${item.meupcSlug}`;
        const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
        if (res.ok) {
          const html = await res.text();
          const matches = [...html.matchAll(/R\$\s?(\d{1,2}\.\d{3},\d{2})/g)];
          const prices = matches
            .map(m => parseFloat(m[1].replace(/\./g, '').replace(',', '.')))
            .filter(p => p >= minSanityPrice);
          if (prices.length) {
            bestOffer = {
              title: item.name,
              price: Math.min(...prices),
              store: 'MeuPC.net (Página da Peça)',
              link: url
            };
          }
        }
      } catch {
        // ignora erro
      }
    }

    checked.push({
      id: item.id,
      bestOffer
    });
  }

  return checked;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf-8') || '{}');
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://localhost:${PORT}`);

  try {
    if (req.method === 'GET' && (urlObj.pathname === '/' || urlObj.pathname === '/painel.html')) {
      const html = await fs.readFile(PAINEL_HTML_PATH, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && urlObj.pathname === '/simulador') {
      const html = await fs.readFile(path.resolve('./index.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && urlObj.pathname === '/api/targets') {
      const raw = await fs.readFile(TARGETS_PATH, 'utf-8');
      sendJson(res, 200, JSON.parse(raw));
      return;
    }

    if (req.method === 'POST' && urlObj.pathname === '/api/targets') {
      const body = await readBody(req);
      if (!Array.isArray(body.targets)) {
        sendJson(res, 400, { ok: false, error: 'Formato inválido de targets.' });
        return;
      }
      await fs.writeFile(TARGETS_PATH, JSON.stringify(body.targets, null, 2) + '\n', 'utf-8');

      let gitMessage = 'Salvo localmente em targets.json!';
      if (body.syncGithub) {
        try {
          await execAsync('git add targets.json');
          const { stdout: statusOut } = await execAsync('git status --porcelain targets.json');
          if (statusOut.trim()) {
            await execAsync('git commit -m "chore: atualiza metas e itens pelo Painel Local"');
            await execAsync('git push');
            gitMessage = 'Salvo localmente e sincronizado com o GitHub (git push concluído)!';
          } else {
            gitMessage = 'Salvo localmente (nenhuma alteração pendente para o GitHub).';
          }
        } catch (err) {
          gitMessage = `Salvo em targets.json, mas houve um aviso no git push: ${err.message}`;
        }
      }

      sendJson(res, 200, { ok: true, message: gitMessage });
      return;
    }

    if (req.method === 'GET' && urlObj.pathname === '/api/search') {
      const q = (urlObj.searchParams.get('q') || '').trim();
      if (!q) {
        sendJson(res, 200, { results: [] });
        return;
      }
      const results = await searchLiveCatalog(q);
      sendJson(res, 200, { results });
      return;
    }

    if (req.method === 'POST' && urlObj.pathname === '/api/check-prices') {
      const raw = await fs.readFile(TARGETS_PATH, 'utf-8');
      const targets = JSON.parse(raw);
      const prices = await checkAllPrices(targets);
      sendJson(res, 200, { ok: true, prices });
      return;
    }

    sendJson(res, 404, { error: 'Rota não encontrada' });
  } catch (err) {
    sendJson(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n🚀 Painel Configurador do Bot rodando em: http://localhost:${PORT}`);
  console.log(`📂 Editando arquivo: ${TARGETS_PATH}\n`);
});

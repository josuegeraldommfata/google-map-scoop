import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();

// Configuração Robusta de CORS
app.use(cors({
  origin: true, // Permite qualquer origem
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
  credentials: false,
  optionsSuccessStatus: 200
}));

// Middleware adicional para garantir CORS em todas as rotas
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.setHeader('Access-Control-Max-Age', '86400');
  
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }
  
  next();
});

app.use(express.json());

// Anti-Crash: Captura erros globais para o servidor não cair nunca
process.on('uncaughtException', (err) => {
  console.error('[ERRO FATAL] Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERRO FATAL] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Sistema de Logs em Tempo Real (SSE)
let logClients = [];
const broadcastLog = (msg) => {
  logClients.forEach(res => res.write(`data: ${JSON.stringify({ msg, timestamp: new Date().toISOString() })}\n\n`));
};

const originalLog = console.log;
console.log = (...args) => {
  const msg = args.join(' ');
  originalLog(...args);
  if (msg.startsWith('[scraper]') || msg.startsWith('[✓]') || msg.startsWith('[api]')) {
    broadcastLog(msg);
  }
};

const PORT = process.env.PORT || 3001;

// ─── Scraper Engine ───────────────────────────────────────────────────────────

// Função de enriquecimento DESABILITADA para velocidade
// async function enrichFromWebsite(url) { ... }

async function scrapeGoogleMaps(page, query, limit = 20) {
  const { niche, city, state } = query;
  const searchTerm = `${niche} ${city} ${state}`;
  console.log(`[scraper] iniciando prospecção: ${searchTerm}`);

  const url = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

  // Espera qualquer sinal de vida (lista ou painel direto)
  try {
    await page.waitForSelector('.Nv2Y3c, .m6u5nf, h1.DUwDvf, [role="article"]', { timeout: 20000 });
  } catch (e) {
    console.log('[scraper] aviso: a página demorou muito para mostrar resultados.');
  }

  // Verifica se caiu direto em um único resultado
  const isSingleResult = await page.evaluate(() => !!document.querySelector('h1.DUwDvf') && !document.querySelector('.Nv2Y3c'));
  
  if (isSingleResult) {
    console.log('[scraper] busca retornou um resultado único direto.');
    // Extrai esse único lead e retorna
    // (A lógica abaixo já vai lidar com isso se a gente tratar os cards de forma flexível)
  }

  let results = [];
  const processedNames = new Set();
  let consecutiveEmptyCycles = 0;

  while (results.length < limit && consecutiveEmptyCycles < 10) {
    // Seletores super abrangentes
    const cards = await page.$$('.Nv2Y3c, .Ua6K6, .jVST6d, [role="article"], a.hfpxzc');
    let newFoundInBatch = false;

    for (const card of cards) {
      if (results.length >= limit) break;

      try {
        const name = await card.$eval('.qBF1Pd', el => el.textContent).catch(() => null);
        if (!name || processedNames.has(name)) continue;

        processedNames.add(name);
        newFoundInBatch = true;
        consecutiveEmptyCycles = 0;

        console.log(`[scraper] analisando: "${name}"...`);
        await card.click();
        
        // Sincronização Panel - Espera o painel "acordar" com dados reais
        try {
          await page.waitForFunction((expectedName) => {
            const panel = document.querySelector('h1.DUwDvf');
            const hasInfo = !!document.querySelector('button[data-item-id="address"]') || !!document.querySelector('button[data-item-id^="phone:tel:"]');
            return panel?.textContent?.length > 1 && hasInfo;
          }, { timeout: 2000 }); // Reduzido de 4000ms para 2000ms
        } catch (e) {
          console.log(`[scraper] painel lento para "${name}", tentando reforçar o clique...`);
          await card.click(); // Re-clique de segurança
          await new Promise(r => setTimeout(r, 800)); // Reduzido de 1500ms para 800ms
        }

        const data = await page.evaluate(() => {
          const getLink = (selector) => document.querySelector(selector)?.getAttribute('href');
          
          // Site Detection
          const website = getLink('a[data-item-id="authority"]') || 
                          getLink('a[aria-label^="Website"]') || 
                          getLink('a[aria-label^="Sítio"]') ||
                          Array.from(document.querySelectorAll('a')).find(a => a.href && !a.href.includes('google.com') && a.innerText.toLowerCase().includes('.'))?.href;
          
          let phone = null;
          // Busca telefone por múltiplos caminhos
          const phoneBtn = document.querySelector('button[data-item-id^="phone:tel:"]');
          if (phoneBtn) {
            phone = phoneBtn.getAttribute('data-item-id').replace('phone:tel:', '');
          } else {
            // Tenta achar qualquer botão que tenha ícone de telefone
            const phoneByIcon = Array.from(document.querySelectorAll('button')).find(btn => btn.querySelector('img[src*="phone"]'));
            if (phoneByIcon) phone = phoneByIcon.textContent.trim();
            else {
              const allText = document.body.innerText;
              const matches = allText.match(/\(\d{2}\)\s\d{4,5}-\d{4}/);
              if (matches) phone = matches[0];
            }
          }

          const address = document.querySelector('button[data-item-id="address"]')?.textContent?.trim() || 
                          Array.from(document.querySelectorAll('.Io6YTe')).find(el => el.textContent.includes(','))?.textContent || 
                          'Endereço não informado';

          return {
            name: document.querySelector('h1.DUwDvf')?.textContent || 'Sem nome',
            address,
            phone,
            website,
            type: website ? 'cold' : 'hot'
          };
        });

        // WhatsApp do Telefone (Regra de Ouro)
        if (data.phone) {
          const clean = data.phone.replace(/\D/g, '');
          if (clean.length >= 10) {
            data.whatsapp = `https://wa.me/${clean.startsWith('55') ? clean : '55' + clean}`;
          }
        }

        // ENRIQUECIMENTO DE SITE DESABILITADO PARA VELOCIDADE
        // Se precisar de Instagram/WhatsApp do site, ative depois manualmente

        const finalLead = {
          id: `gm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          ...data,
          name: (data.name && data.name !== 'Sem nome') ? data.name : name,
          city,
          niche
        };

        results.push(finalLead);
        console.log(`[✓] ${results.length}/${limit}: ${finalLead.name} (${finalLead.type.toUpperCase()})`);
        await new Promise(r => setTimeout(r, 200)); // Reduzido de 500ms para 200ms

      } catch (err) {
        console.log(`[scraper] erro em card: ${err.message}`);
      }
    }

    if (!newFoundInBatch) {
      consecutiveEmptyCycles++;
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) feed.scrollTop += 1200; // Scroll mais agressivo
      });
      await new Promise(r => setTimeout(r, 800)); // Reduzido de 1500ms para 800ms
    }
  }

  return results;
}

// ─── API Routes ──────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');
  res.flushHeaders();
  logClients.push(res);
  req.on('close', () => { logClients = logClients.filter(c => c !== res); });
});

app.post('/api/scrape-leads', async (req, res) => {
  // Headers CORS obrigatórios
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  const { niche, cities = [], state = 'SP', quantity = 20 } = req.body;
  
  // Limita quantidade para evitar timeout
  const maxQuantity = Math.min(quantity, 300); // Aumentado para 300
  
  console.log(`[api] requisição: ${niche} em ${cities.join(', ')} (Qtd: ${maxQuantity})`);

  let browser;
  const timeout = setTimeout(() => {
    console.log('[api] timeout - encerrando requisição');
    if (browser) browser.close();
    if (!res.headersSent) {
      res.status(408).json({ error: 'Timeout - tente com menos contatos' });
    }
  }, 300000); // 5 minutos timeout (aumentado de 2 para 5)

  try {
    browser = await chromium.launch({ 
      headless: true, 
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] 
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();
    let allLeads = [];

    for (const city of cities) {
      if (allLeads.length >= maxQuantity) break;
      const leads = await scrapeGoogleMaps(page, { niche, city, state }, maxQuantity - allLeads.length);
      allLeads = [...allLeads, ...leads];
    }

    clearTimeout(timeout);
    if (!res.headersSent) {
      res.json({ leads: allLeads });
    }
  } catch (error) {
    console.error('[api] erro fatal:', error);
    clearTimeout(timeout);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (e) {
        console.log('[api] erro ao fechar browser:', e.message);
      }
    }
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[api] servidor rodando na porta ${PORT}`);
});

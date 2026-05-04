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
  origin: ['https://google-map-scoop.vercel.app', 'http://localhost:5173', 'http://localhost:3000'],
  methods: ['GET', 'POST', 'OPTIONS', 'PUT', 'DELETE'],
  allowedHeaders: ['Origin', 'X-Requested-With', 'Content-Type', 'Accept', 'Authorization'],
  credentials: false,
  optionsSuccessStatus: 200
}));

// Middleware adicional para garantir CORS em todas as rotas
app.use((req, res, next) => {
  const allowedOrigins = ['https://google-map-scoop.vercel.app', 'http://localhost:5173', 'http://localhost:3000'];
  const origin = req.headers.origin;
  
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  
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

async function enrichFromWebsite(url) {
  let browser;
  try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    
    const content = await page.content();
    const instagramMatch = content.match(/instagram\.com\/([a-zA-Z0-9._]+)/);
    const whatsappMatch = content.match(/api\.whatsapp\.com\/send\?phone=(\d+)|wa\.me\/(\d+)/);
    
    return {
      instagram: instagramMatch ? `https://www.instagram.com/${instagramMatch[1]}` : null,
      whatsapp: whatsappMatch ? `https://wa.me/${whatsappMatch[1] || whatsappMatch[2]}` : null
    };
  } catch (e) {
    return { instagram: null, whatsapp: null };
  } finally {
    if (browser) await browser.close();
  }
}

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
          }, { timeout: 4000 });
        } catch (e) {
          console.log(`[scraper] painel lento para "${name}", tentando reforçar o clique...`);
          await card.click(); // Re-clique de segurança
          await new Promise(r => setTimeout(r, 1500));
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

        // WhatsApp/IG do Site
        if (data.website) {
          const extra = await enrichFromWebsite(data.website).catch(() => ({ instagram: null, whatsapp: null }));
          if (extra.instagram) data.instagram = extra.instagram;
          if (extra.whatsapp) data.whatsapp = extra.whatsapp;
        }

        const finalLead = {
          id: `gm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          ...data,
          name: (data.name && data.name !== 'Sem nome') ? data.name : name, // Fallback para o nome do card
          city,
          niche
        };

        results.push(finalLead);
        console.log(`[✓] ${results.length}/${limit}: ${finalLead.name} (${finalLead.type.toUpperCase()})`);
        await new Promise(r => setTimeout(r, 500));

      } catch (err) {
        console.log(`[scraper] erro em card: ${err.message}`);
      }
    }

    if (!newFoundInBatch) {
      consecutiveEmptyCycles++;
      await page.evaluate(() => {
        const feed = document.querySelector('div[role="feed"]');
        if (feed) feed.scrollTop += 800;
      });
      await new Promise(r => setTimeout(r, 1500));
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
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Cache-Control');
  res.flushHeaders();
  logClients.push(res);
  req.on('close', () => { logClients = logClients.filter(c => c !== res); });
});

app.post('/api/scrape-leads', async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  
  const { niche, cities = [], state = 'SP', quantity = 20 } = req.body;
  console.log(`[api] requisição: ${niche} em ${cities.join(', ')} (Qtd: ${quantity})`);

  let browser;
  try {
    browser = await chromium.launch({ 
      headless: true, 
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
    });
    
    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    });
    
    const page = await context.newPage();
    let allLeads = [];

    for (const city of cities) {
      const leads = await scrapeGoogleMaps(page, { niche, city, state }, quantity);
      allLeads = [...allLeads, ...leads];
    }

    res.json({ leads: allLeads });
  } catch (error) {
    console.error('[api] erro fatal:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[api] servidor rodando na porta ${PORT}`);
});

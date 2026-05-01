import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright-extra';
import stealth from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
// CORS super robusto para aceitar tudo do Vercel
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.json());

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

chromium.use(stealth());

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
  await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });

  try {
    await page.waitForSelector('.m6u5nf, .Nv2Y3c', { timeout: 15000 });
  } catch (e) {
    console.log('[scraper] aviso: carregamento lento de resultados...');
  }

  let results = [];
  const processedNames = new Set();
  let consecutiveEmptyCycles = 0;

  while (results.length < limit && consecutiveEmptyCycles < 10) {
    const cards = await page.$$('.Nv2Y3c, .Ua6K6, .jVST6d');
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
        
        // Sincronização Panel Title
        try {
          await page.waitForFunction((expectedName) => {
            const panelTitle = document.querySelector('h1.DUwDvf')?.textContent || '';
            const normalize = s => s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
            return normalize(panelTitle).includes(normalize(expectedName)) || normalize(expectedName).includes(normalize(panelTitle));
          }, { timeout: 5000 }, name);
        } catch (e) { /* ignore sync timeout and try extract anyway */ }

        const data = await page.evaluate(() => {
          const websiteEl = document.querySelector('a[data-item-id="authority"]');
          const website = websiteEl ? websiteEl.getAttribute('href') : null;
          
          let phone = null;
          const phoneBtn = document.querySelector('button[data-item-id^="phone:tel:"]');
          if (phoneBtn) {
            phone = phoneBtn.getAttribute('data-item-id').replace('phone:tel:', '');
          } else {
            const allInfos = Array.from(document.querySelectorAll('.Io6YTe'));
            const phoneInfo = allInfos.find(el => el.textContent.match(/\(\d{2}\)\s\d/));
            if (phoneInfo) phone = phoneInfo.textContent;
          }

          const addressBtn = document.querySelector('button[data-item-id="address"]');
          const address = addressBtn ? addressBtn.textContent.trim() : (document.querySelector('.Io6YTe')?.textContent || 'Endereço não informado');

          return {
            name: document.querySelector('h1.DUwDvf')?.textContent || 'Sem nome',
            address,
            phone,
            website,
            type: website ? 'cold' : 'hot'
          };
        });

        // WhatsApp do Telefone
        if (data.phone && !data.whatsapp) {
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

app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/logs', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  logClients.push(res);
  req.on('close', () => { logClients = logClients.filter(c => c !== res); });
});

app.post('/api/scrape-leads', async (req, res) => {
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

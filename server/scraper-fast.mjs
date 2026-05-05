import express from 'express';
import https from 'https';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());

// CORS em tudo
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});

// Logs SSE
let logClients = [];
const log = (msg) => {
  console.log(msg);
  logClients.forEach(r => r.write(`data: ${JSON.stringify({ msg, timestamp: new Date().toISOString() })}\n\n`));
};

// Fetch simples via HTTPS
function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// Scraper via Google Maps Text Search (sem browser!)
async function scrapeLeads(niche, city, state, limit) {
  const query = encodeURIComponent(`${niche} ${city} ${state}`);
  const url = `https://maps.googleapis.com/maps/api/place/textsearch/json?query=${query}&language=pt-BR&region=br&key=${process.env.GOOGLE_MAPS_KEY}`;
  
  if (process.env.GOOGLE_MAPS_KEY) {
    // Usa API oficial se tiver chave
    const raw = await fetchUrl(url);
    const data = JSON.parse(raw);
    return (data.results || []).slice(0, limit).map(p => ({
      id: `gm-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
      name: p.name,
      address: p.formatted_address || 'N/A',
      phone: null,
      whatsapp: null,
      website: null,
      instagram: null,
      rating: p.rating || 0,
      reviewCount: p.user_ratings_total || 0,
      type: 'hot',
      city,
      niche
    }));
  }

  // Sem chave: usa scraping leve via HTML do Google Maps
  return await scrapeViaHTML(niche, city, state, limit);
}

// Scraping leve via HTML - sem Playwright
async function scrapeViaHTML(niche, city, state, limit) {
  const { chromium } = await import('playwright');
  
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process']
  });

  const results = [];

  try {
    const page = await browser.newPage();
    
    // Bloqueia imagens, CSS, fontes para ser mais rápido
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    const searchTerm = `${niche} ${city} ${state}`;
    log(`[scraper] buscando: ${searchTerm}`);

    await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });

    await page.waitForSelector('[role="article"], .Nv2Y3c', { timeout: 8000 }).catch(() => {});

    let scrolls = 0;
    const maxScrolls = Math.ceil(limit / 5) + 3;

    while (results.length < limit && scrolls < maxScrolls) {
      // Extrai todos os cards visíveis de uma vez
      const cards = await page.evaluate(() => {
        const items = document.querySelectorAll('[role="article"], .Nv2Y3c');
        return Array.from(items).map(el => {
          const name = el.querySelector('.qBF1Pd, .fontHeadlineSmall')?.textContent?.trim();
          const address = el.querySelector('.W4Efsd span, .Io6YTe')?.textContent?.trim();
          const rating = el.querySelector('.MW4etd')?.textContent?.trim();
          const reviews = el.querySelector('.UY7F9')?.textContent?.replace(/[()]/g, '').trim();
          const phone = el.querySelector('[data-item-id^="phone"]')?.getAttribute('data-item-id')?.replace('phone:tel:', '');
          const website = el.querySelector('a[data-item-id="authority"]')?.href;
          return { name, address, rating, reviews, phone, website };
        }).filter(c => c.name);
      });

      for (const card of cards) {
        if (results.length >= limit) break;
        if (results.find(r => r.name === card.name)) continue;

        let whatsapp = null;
        if (card.phone) {
          const clean = card.phone.replace(/\D/g, '');
          if (clean.length >= 10) {
            whatsapp = `https://wa.me/${clean.startsWith('55') ? clean : '55' + clean}`;
          }
        }

        results.push({
          id: `gm-${Date.now()}-${Math.random().toString(36).slice(2,8)}`,
          name: card.name,
          address: card.address || 'N/A',
          phone: card.phone || null,
          whatsapp,
          website: card.website || null,
          instagram: null,
          rating: parseFloat(card.rating) || 0,
          reviewCount: parseInt(card.reviews) || 0,
          type: card.website ? 'cold' : 'hot',
          city,
          niche
        });

        log(`[✓] ${results.length}/${limit}: ${card.name}`);
      }

      if (results.length < limit) {
        await page.evaluate(() => {
          const feed = document.querySelector('div[role="feed"]');
          if (feed) feed.scrollTop += 3000;
        });
        await page.waitForTimeout(300);
        scrolls++;
      }
    }
  } finally {
    await browser.close();
  }

  return results;
}

// ─── Rotas ───────────────────────────────────────────────────────────────────

app.get('/api/health', (req, res) => res.json({ status: 'ok', version: 'fast-v2' }));

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
  const maxQty = Math.min(quantity, 300);

  log(`[api] iniciando: ${niche} | ${cities.join(', ')} | qtd: ${maxQty}`);

  try {
    let allLeads = [];
    const perCity = Math.ceil(maxQty / cities.length);

    for (const city of cities) {
      if (allLeads.length >= maxQty) break;
      const leads = await scrapeLeads(niche, city, state, Math.min(perCity, maxQty - allLeads.length));
      allLeads = [...allLeads, ...leads];
    }

    log(`[api] concluído: ${allLeads.length} leads`);
    res.json({ leads: allLeads });
  } catch (err) {
    console.error('[api] erro:', err);
    res.status(500).json({ error: err.message });
  }
});

process.on('uncaughtException', err => console.error('[FATAL]', err));
process.on('unhandledRejection', err => console.error('[FATAL]', err));

app.listen(PORT, '0.0.0.0', () => console.log(`[api] rodando na porta ${PORT}`));

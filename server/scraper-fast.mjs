import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';

const app = express();

app.use(cors({ origin: true, credentials: false }));
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  next();
});
app.use(express.json());

const PORT = process.env.PORT || 3001;

// SCRAPER ULTRA RÁPIDO - Extrai dados direto dos cards
async function scrapeGoogleMapsFast(page, query, limit = 20) {
  const { niche, city, state } = query;
  const searchTerm = `${niche} ${city} ${state}`;
  console.log(`[scraper] iniciando: ${searchTerm}`);

  await page.goto(`https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`, { 
    waitUntil: 'domcontentloaded', 
    timeout: 20000 
  });

  await page.waitForSelector('.Nv2Y3c, [role="article"]', { timeout: 8000 }).catch(() => {});

  let results = [];
  let scrollAttempts = 0;
  const maxScrolls = 20;

  while (results.length < limit && scrollAttempts < maxScrolls) {
    // Extrai TODOS os dados direto dos cards visíveis
    const newLeads = await page.evaluate((currentCount, maxLeads, cityName, nicheType) => {
      const cards = document.querySelectorAll('.Nv2Y3c, [role="article"]');
      const leads = [];
      
      for (let i = currentCount; i < cards.length && leads.length < (maxLeads - currentCount); i++) {
        const card = cards[i];
        
        try {
          const name = card.querySelector('.qBF1Pd')?.textContent?.trim() ||
                       card.querySelector('.fontHeadlineSmall')?.textContent?.trim();
          
          if (!name) continue;
          
          const address = card.querySelector('.W4Efsd span')?.textContent?.trim() || 'N/A';
          const rating = card.querySelector('.MW4etd')?.textContent?.trim() || '0';
          const reviews = card.querySelector('.UY7F9')?.textContent?.replace(/[()]/g, '') || '0';
          
          // Pega link do card
          const link = card.querySelector('a')?.href || '';
          
          leads.push({
            name,
            address,
            rating: parseFloat(rating) || 0,
            reviewCount: parseInt(reviews) || 0,
            link,
            city: cityName,
            niche: nicheType
          });
        } catch (e) {
          console.log('Erro no card:', e.message);
        }
      }
      
      return leads;
    }, results.length, limit, city, niche);

    if (newLeads.length > 0) {
      results.push(...newLeads);
      console.log(`[✓] ${results.length}/${limit} leads encontrados`);
    }

    if (results.length >= limit) break;

    // Scroll
    await page.evaluate(() => {
      const feed = document.querySelector('div[role="feed"]');
      if (feed) feed.scrollTop += 3000;
    });
    
    await page.waitForTimeout(200);
    scrollAttempts++;
  }

  // Agora clica em cada lead para pegar telefone e website
  console.log('[scraper] enriquecendo com telefone e website...');
  
  for (let i = 0; i < results.length; i++) {
    try {
      if (results[i].link) {
        await page.goto(results[i].link, { waitUntil: 'domcontentloaded', timeout: 5000 });
        
        const details = await page.evaluate(() => {
          const phoneBtn = document.querySelector('button[data-item-id^="phone:tel:"]');
          const phone = phoneBtn?.getAttribute('data-item-id')?.replace('phone:tel:', '') || null;
          
          const websiteLink = document.querySelector('a[data-item-id="authority"]')?.href || null;
          
          return { phone, website: websiteLink };
        });
        
        results[i].phone = details.phone;
        results[i].website = details.website;
        results[i].type = details.website ? 'cold' : 'hot';
        
        if (details.phone) {
          const clean = details.phone.replace(/\D/g, '');
          if (clean.length >= 10) {
            results[i].whatsapp = `https://wa.me/${clean.startsWith('55') ? clean : '55' + clean}`;
          }
        }
        
        console.log(`[✓] ${i+1}/${results.length}: ${results[i].name} enriquecido`);
      }
    } catch (e) {
      console.log(`[!] Erro ao enriquecer ${results[i].name}`);
    }
  }

  return results.map(lead => ({
    id: `gm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    ...lead,
    instagram: null
  }));
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.post('/api/scrape-leads', async (req, res) => {
  const { niche, cities = [], state = 'SP', quantity = 20 } = req.body;
  const maxQuantity = Math.min(quantity, 200);
  
  console.log(`[api] requisição: ${niche} em ${cities.join(', ')} (Qtd: ${maxQuantity})`);

  let browser;
  try {
    browser = await chromium.launch({ 
      headless: true, 
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'] 
    });
    
    const page = await browser.newPage();
    let allLeads = [];

    for (const city of cities) {
      if (allLeads.length >= maxQuantity) break;
      const leads = await scrapeGoogleMapsFast(page, { niche, city, state }, maxQuantity - allLeads.length);
      allLeads = [...allLeads, ...leads];
    }

    res.json({ leads: allLeads });
  } catch (error) {
    console.error('[api] erro:', error);
    res.status(500).json({ error: error.message });
  } finally {
    if (browser) await browser.close();
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[api] servidor RÁPIDO rodando na porta ${PORT}`);
});

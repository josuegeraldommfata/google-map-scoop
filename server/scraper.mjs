/**
 * Google Maps Scraper Server
 * Extrai: nome, telefone, WhatsApp, site, Instagram
 * SEM API KEY — usa Playwright headless
 */

import express from 'express';
import cors from 'cors';
import { chromium } from 'playwright';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3001;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizePhone(raw) {
  if (!raw) return '';
  return raw.replace(/[^\d+]/g, '');
}

function extractInstagramFromHtml(html) {
  const re = /instagram\.com\/(?!p\/|reel|reels|explore|stories|accounts|about|directory|_\/|__\/|shareddata)([A-Za-z0-9_.]{2,30})/gi;
  const matches = [...html.matchAll(re)];
  if (!matches.length) return null;
  return '@' + matches[0][1].replace(/\/$/, '');
}

function extractWhatsAppFromHtml(html) {
  // wa.me/5511... ou api.whatsapp.com/send?phone=5511...
  const re = /(?:wa\.me|api\.whatsapp\.com\/send[?&]phone=)\/?([0-9]{10,15})/gi;
  const m = re.exec(html);
  return m ? m[1] : null;
}

// Tenta pegar Instagram/WhatsApp do site da empresa
async function enrichFromWebsite(page, websiteUrl) {
  try {
    const url = websiteUrl.startsWith('http') ? websiteUrl : 'https://' + websiteUrl;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 8000 });
    const html = await page.content();
    return {
      instagram: extractInstagramFromHtml(html),
      whatsapp: extractWhatsAppFromHtml(html),
    };
  } catch {
    return { instagram: null, whatsapp: null };
  }
}

// ─── Core Scraper ─────────────────────────────────────────────────────────────

async function scrapeGoogleMaps({ niche, keywords, cities, state, quantity }) {
  console.log('[scraper] iniciando:', { niche, cities, quantity });

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--lang=pt-BR,pt',
      ],
    });

    const allLeads = [];
    const perCity = Math.ceil(quantity / Math.max(1, cities.length));

    for (const city of cities) {
      if (allLeads.length >= quantity) break;

      const context = await browser.newContext({
        locale: 'pt-BR',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        extraHTTPHeaders: {
          'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        },
      });

      const page = await context.newPage();

      try {
        // Monta query de busca
        const searchTerm = `${niche} ${keywords.join(' ')} ${city} ${state}`.trim();
        const encodedSearch = encodeURIComponent(searchTerm);
        const mapsUrl = `https://www.google.com/maps/search/${encodedSearch}`;

        console.log('[scraper] abrindo:', mapsUrl);
        await page.goto(mapsUrl, { waitUntil: 'networkidle', timeout: 30000 });

        // Aguarda lista de resultados
        await page.waitForSelector('[role="feed"]', { timeout: 15000 }).catch(() => {});

        // Scroll para carregar mais resultados
        const feed = await page.$('[role="feed"]');
        if (feed) {
          let prevCount = 0;
          for (let scrollAttempt = 0; scrollAttempt < 6; scrollAttempt++) {
            const cards = await page.$$('[role="feed"] > div > div[jsaction]');
            if (cards.length >= perCity * 2) break;
            if (cards.length === prevCount && scrollAttempt > 1) break;
            prevCount = cards.length;
            await feed.evaluate(el => (el.scrollTop += 2500));
            await page.waitForTimeout(1500);
          }
        }

        // Pega todos os cards de resultado
        const cards = await page.$$('[role="feed"] > div > div[jsaction]');
        console.log(`[scraper] ${city}: ${cards.length} cards encontrados`);

        let cityLeads = 0;

        for (const card of cards) {
          if (cityLeads >= perCity || allLeads.length >= quantity) break;

          try {
            // Clica no card para abrir painel de detalhes
            await card.click();
            await page.waitForTimeout(1800);

            // Aguarda painel carregar
            await page.waitForSelector('h1', { timeout: 6000 }).catch(() => {});

            // ── Extrai dados básicos ──

            const name = await page.$eval('h1', el => el.innerText.trim()).catch(() => '');
            if (!name) continue;

            // Telefone
            let phone = '';
            const phoneEl = await page.$('[data-tooltip="Copiar número de telefone"]');
            if (phoneEl) {
              phone = await phoneEl.evaluate(el => el.getAttribute('data-item-id') || el.innerText || '').catch(() => '');
            }
            // Fallback: busca por aria-label contendo número
            if (!phone) {
              const allButtons = await page.$$('button[aria-label]');
              for (const btn of allButtons) {
                const label = await btn.getAttribute('aria-label');
                if (label && /\(\d{2}\)/.test(label)) {
                  phone = label.replace(/[^\d+]/g, '');
                  break;
                }
              }
            }
            // Fallback 2: busca por span com padrão de telefone
            if (!phone) {
              const spans = await page.$$eval('span', els =>
                els.map(e => e.innerText).filter(t => /\(\d{2}\)\s*\d{4,5}-?\d{4}/.test(t))
              );
              if (spans.length) phone = spans[0].replace(/[^\d+]/g, '');
            }

            // Endereço
            let address = '';
            const addrEl = await page.$('[data-tooltip="Copiar endereço"]');
            if (addrEl) {
              address = await addrEl.evaluate(el => el.innerText || el.getAttribute('aria-label') || '').catch(() => '');
            }
            if (!address) {
              // Busca botão de copiar endereço por aria-label
              const allBtns = await page.$$('button[aria-label]');
              for (const btn of allBtns) {
                const label = await btn.getAttribute('aria-label') || '';
                if (label.toLowerCase().includes('endereço') || label.toLowerCase().includes('copiar')) {
                  const possibleAddr = await btn.evaluate(el => el.innerText || '');
                  if (possibleAddr && possibleAddr.length > 5) {
                    address = possibleAddr;
                    break;
                  }
                }
              }
            }

            // Site
            let website = null;
            const siteBtn = await page.$('a[data-tooltip="Abrir site"][href]');
            if (siteBtn) {
              website = await siteBtn.getAttribute('href');
            }
            if (!website) {
              // Busca links externos no painel
              const links = await page.$$eval('a[href^="http"]', els =>
                els
                  .map(e => e.href)
                  .filter(h => !h.includes('google.com') && !h.includes('goo.gl') && !h.includes('maps.app'))
              );
              if (links.length) website = links[0];
            }

            // Rating
            let rating = 0;
            let reviewCount = 0;
            try {
              const ratingText = await page.$eval('[role="img"][aria-label*="estrela"]', el =>
                el.getAttribute('aria-label') || ''
              ).catch(() => '');
              const ratingMatch = ratingText.match(/(\d[.,]\d)/);
              if (ratingMatch) rating = parseFloat(ratingMatch[1].replace(',', '.'));

              const reviewText = await page.$eval('button[aria-label*="avaliações"]', el =>
                el.innerText || ''
              ).catch(() => '');
              const reviewMatch = reviewText.match(/[\d.,]+/);
              if (reviewMatch) reviewCount = parseInt(reviewMatch[0].replace(/\D/g, ''));
            } catch {/* ignore */}

            // ── Enriquecimento: Instagram e WhatsApp ──

            let instagram = null;
            let whatsapp = normalizePhone(phone) || null;

            // 1. Verifica se o próprio painel tem links de Instagram/WhatsApp
            const panelHtml = await page.content();
            const igFromPanel = extractInstagramFromHtml(panelHtml);
            if (igFromPanel) instagram = igFromPanel;

            const waFromPanel = extractWhatsAppFromHtml(panelHtml);
            if (waFromPanel) whatsapp = waFromPanel;

            // 2. Se tem site, tenta enriquecer abrindo o site
            if (website && (!instagram || !whatsapp)) {
              const enrichPage = await context.newPage();
              try {
                const extra = await enrichFromWebsite(enrichPage, website);
                if (!instagram && extra.instagram) instagram = extra.instagram;
                if (!whatsapp && extra.whatsapp) whatsapp = extra.whatsapp;
              } finally {
                await enrichPage.close();
              }
            }

            // Se phone é número BR, usa como whatsapp
            if (!whatsapp && phone) whatsapp = normalizePhone(phone);

            const lead = {
              id: `gm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name,
              address: address || `${city}, ${state}`,
              phone: normalizePhone(phone),
              whatsapp,
              website,
              instagram,
              rating,
              reviewCount,
              type: website ? 'cold' : 'hot',
              niche,
              city,
              state,
              foundAt: new Date().toISOString(),
            };

            console.log(`[scraper] lead: ${name} | tel: ${phone} | ig: ${instagram} | wa: ${whatsapp} | site: ${website}`);
            allLeads.push(lead);
            cityLeads++;

            // Volta para a lista
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
            await page.waitForTimeout(800);

          } catch (err) {
            console.warn('[scraper] erro no card:', err.message);
            // Tenta voltar mesmo em caso de erro
            await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
            await page.waitForTimeout(500);
          }
        }

      } catch (err) {
        console.error(`[scraper] erro na cidade ${city}:`, err.message);
      } finally {
        await page.close().catch(() => {});
        await context.close().catch(() => {});
      }
    }

    return allLeads;

  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post('/api/scrape-leads', async (req, res) => {
  const { niche, keywords = [], cities = [], state = 'SP', quantity = 20 } = req.body;

  if (!niche || !cities.length) {
    return res.status(400).json({ error: 'niche e cities são obrigatórios', leads: [] });
  }

  try {
    const leads = await scrapeGoogleMaps({ niche, keywords, cities, state, quantity });
    return res.json({ leads, total: leads.length });
  } catch (err) {
    console.error('[api] erro:', err);
    return res.status(500).json({ error: String(err), leads: [] });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.listen(PORT, () => {
  console.log(`\n🚀 Scraper server rodando em http://localhost:${PORT}`);
  console.log(`   POST /api/scrape-leads  — busca leads no Google Maps`);
  console.log(`   GET  /api/health        — verifica status\n`);
});

/**
 * Google Maps Scraper Server — v2
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
  const re = /instagram\.com\/(?!p\/|reel|reels|explore|stories|accounts|about|directory|_\/|__\/|shareddata|highlights)([A-Za-z0-9_.]{2,30})/gi;
  const matches = [...html.matchAll(re)];
  if (!matches.length) return null;
  return '@' + matches[0][1].replace(/\/$/, '');
}

function extractWhatsAppFromHtml(html) {
  const re = /(?:wa\.me|api\.whatsapp\.com\/send[?&]phone=)\/?([0-9]{10,15})/gi;
  const m = re.exec(html);
  return m ? m[1] : null;
}

// Tenta pegar Instagram/WhatsApp do site — timeout curto de 3s, não bloqueia
async function enrichFromWebsite(context, websiteUrl) {
  let page;
  try {
    const url = websiteUrl.startsWith('http') ? websiteUrl : 'https://' + websiteUrl;
    page = await context.newPage();
    // 3 segundos — se o site for lento, desiste e segue
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 3000 });
    const html = await page.content();
    await page.close().catch(() => { });
    return {
      instagram: extractInstagramFromHtml(html),
      whatsapp: extractWhatsAppFromHtml(html),
    };
  } catch {
    if (page) await page.close().catch(() => { });
    return { instagram: null, whatsapp: null };
  }
}

// ─── Extrai dados do painel de detalhes de um negócio ─────────────────────────

async function extractLeadFromPanel(page) {
  // Nome do negócio — seletor específico do painel de detalhe do Maps
  const name = await page.evaluate(() => {
    // Tenta vários seletores do Maps (a UI do Google muda frequentemente)
    const selectors = [
      'h1.DUwDvf',
      'h1.fontHeadlineSmall',
      '[role="main"] h1',
      'h1',
    ];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && el.innerText && el.innerText.trim().length > 1 && el.innerText.trim() !== 'Resultados') {
        return el.innerText.trim();
      }
    }
    return null;
  });

  if (!name) return null;

  // Endereço
  const address = await page.evaluate(() => {
    // Botão com tooltip de copiar endereço
    const addrBtn = document.querySelector('[data-tooltip="Copiar endereço"], [aria-label*="ndereço"]');
    if (addrBtn) return addrBtn.innerText?.trim() || '';
    // Fallback: aria-label descritivo
    const btns = document.querySelectorAll('button[aria-label]');
    for (const btn of btns) {
      const lbl = btn.getAttribute('aria-label') || '';
      if (lbl.includes(',') && (lbl.includes('SP') || lbl.includes('RJ') || lbl.includes('MG') || lbl.includes('Brasil'))) {
        return lbl.trim();
      }
    }
    return '';
  }).catch(() => '');

  // Telefone — múltiplos seletores
  const phone = await page.evaluate(() => {
    // data-tooltip com "telefone"
    const phoneEl = document.querySelector('[data-tooltip*="telefone"], [data-item-id*="phone"]');
    if (phoneEl) {
      const raw = phoneEl.getAttribute('aria-label') || phoneEl.innerText || '';
      return raw.replace(/[^\d+]/g, '');
    }
    // Busca botões com número de telefone no aria-label
    const btns = document.querySelectorAll('button[aria-label]');
    for (const btn of btns) {
      const lbl = btn.getAttribute('aria-label') || '';
      if (/\(\d{2}\)\s*\d{4,5}[\s-]?\d{4}/.test(lbl)) {
        return lbl.replace(/[^\d+]/g, '');
      }
    }
    // Span com padrão de telefone
    const spans = document.querySelectorAll('span');
    for (const span of spans) {
      if (/\(\d{2}\)\s*\d{4,5}[\s-]?\d{4}/.test(span.innerText)) {
        return span.innerText.replace(/[^\d+]/g, '');
      }
    }
    return '';
  }).catch(() => '');

  // Site
  const website = await page.evaluate(() => {
    const siteLink = document.querySelector('a[data-item-id*="authority"], a[aria-label*="site"], a[href^="http"]:not([href*="google"]):not([href*="goo.gl"])');
    if (siteLink) return siteLink.href;
    // Busca links externos em seção de contato
    const links = document.querySelectorAll('[data-section-id] a[href^="http"]');
    for (const link of links) {
      const h = link.href;
      if (!h.includes('google.com') && !h.includes('goo.gl') && !h.includes('maps.app')) {
        return h;
      }
    }
    return null;
  }).catch(() => null);

  // Rating e reviews
  const { rating, reviewCount } = await page.evaluate(() => {
    const ratingEl = document.querySelector('[role="img"][aria-label*="estrela"], [aria-label*="star"]');
    let rating = 0;
    if (ratingEl) {
      const m = (ratingEl.getAttribute('aria-label') || '').match(/(\d[.,]\d)/);
      if (m) rating = parseFloat(m[1].replace(',', '.'));
    }
    let reviewCount = 0;
    const revBtn = document.querySelector('button[aria-label*="avaliações"], button[aria-label*="reviews"]');
    if (revBtn) {
      const m = (revBtn.innerText || '').match(/[\d.,]+/);
      if (m) reviewCount = parseInt(m[0].replace(/\D/g, ''));
    }
    return { rating, reviewCount };
  }).catch(() => ({ rating: 0, reviewCount: 0 }));

  // Instagram e WhatsApp direto do painel
  const panelHtml = await page.content();
  const instagram = extractInstagramFromHtml(panelHtml);
  const waFromPanel = extractWhatsAppFromHtml(panelHtml);
  const whatsapp = waFromPanel || normalizePhone(phone) || null;

  return { name, address, phone: normalizePhone(phone), website, instagram, whatsapp, rating, reviewCount };
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
        '--disable-web-security',
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
        extraHTTPHeaders: { 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8' },
      });

      const page = await context.newPage();

      // Remove detecção de automação
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      });

      try {
        const searchTerm = [niche, ...keywords, city, state].filter(Boolean).join(' ');
        const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchTerm)}`;
        console.log('[scraper] buscando:', searchTerm);

        await page.goto(mapsUrl, { waitUntil: 'domcontentloaded', timeout: 40000 });

        // Espera a lista de resultados aparecer
        const hasFeed = await page.waitForSelector('[role="feed"]', { timeout: 18000 }).then(() => true).catch(() => false);

        if (!hasFeed) {
          console.log('[scraper] feed não encontrado em', city, '— pulando');
          continue;
        }

        // Scroll para carregar mais cards - Aumentado para achar leads sem site que ficam no fundo
        console.log('[scraper] fazendo scroll profundo para achar leads quentes...');
        const feed = await page.$('[role="feed"]');
        let lastCount = 0;
        for (let i = 0; i < 15; i++) { // Aumentado de 8 para 15
          const count = await page.$$eval('[role="feed"] [role="article"]', els => els.length).catch(() => 0);
          if (count >= perCity * 2) break; // Busca o dobro pra ter margem
          if (count > 0 && count === lastCount && i > 5) break;
          lastCount = count;
          if (feed) await feed.evaluate(el => { el.scrollTop += 4000; }); // Aumentado salto de 3000 para 4000
          await page.waitForTimeout(1000);
        }

        // Pega todos os articles (cards de resultado)
        const articleCount = await page.$$eval('[role="feed"] [role="article"]', els => els.length).catch(() => 0);
        console.log(`[scraper] ${city}: ${articleCount} resultados encontrados`);

        let cityLeads = 0;

        for (let idx = 0; idx < articleCount; idx++) {
          if (cityLeads >= perCity || allLeads.length >= quantity) break;

          try {
            // Re-pega os articles (DOM pode ter mudado)
            const articles = await page.$$('[role="feed"] [role="article"]');
            if (idx >= articles.length) break;

            const article = articles[idx];
            
            // Extrai nome da card antes de clicar (mais confiável)
            const cardName = await article.evaluate(el => {
              const nameEl = el.querySelector('.fontHeadlineSmall, .qBF1Pd');
              return nameEl ? nameEl.innerText.trim() : '';
            }).catch(() => '');

            // Clica no article para abrir painel de detalhe
            await article.click();
            await page.waitForTimeout(1200);

            // Aguarda o painel atualizar de forma OBRIGATÓRIA
            await page.waitForFunction(
              (name) => {
                const h1 = document.querySelector('h1');
                if (!h1 || !h1.innerText) return false;
                
                // Limpa nomes para comparação: remove emojis, pontuação e espaços extras
                const clean = (str) => str.toLowerCase()
                  .replace(/[^\w\s]/gi, '') // remove emojis e símbolos
                  .replace(/\s+/g, ' ')      // normaliza espaços
                  .trim();

                const h1Text = clean(h1.innerText);
                const targetName = clean(name);
                
                return h1Text.includes(targetName) || targetName.includes(h1Text);
              },
              cardName,
              { timeout: 10000 } // 10s de margem
            ).catch((err) => {
               // Se der timeout, tentamos dar um scroll no card e clicar de novo antes de desistir
               console.log(`[scraper] tentando re-clicar em "${cardName}"...`);
               return article.click().then(() => page.waitForTimeout(2000));
            });

            // Agora extrai dados do painel — temos certeza que é o lead correto
            let lead = await extractLeadFromPanel(page);

            // Se não extraiu nome do painel, usa o da card
            if (!lead && cardName) {
              lead = {
                name: cardName,
                address: `${city}, ${state}`,
                phone: '',
                website: null,
                instagram: null,
                whatsapp: null,
                rating: 0,
                reviewCount: 0,
              };
            }
            if (!lead) {
              // Fecha painel e continua
              await page.keyboard.press('Escape');
              await page.waitForTimeout(500);
              continue;
            }

            // Usa cardName se o painel retornou algo genérico
            if (lead.name === 'Resultados' || lead.name.length <= 1) {
              if (cardName) lead.name = cardName;
              else {
                await page.keyboard.press('Escape');
                await page.waitForTimeout(500);
                continue;
              }
            }

            // Enriquecimento: tenta pegar Instagram/WhatsApp do site (em paralelo, rápido)
            if (lead.website && (!lead.instagram || !lead.whatsapp)) {
              const extra = await enrichFromWebsite(context, lead.website);
              if (!lead.instagram && extra.instagram) lead.instagram = extra.instagram;
              if (!lead.whatsapp && extra.whatsapp) lead.whatsapp = extra.whatsapp;
            }

            const finalLead = {
              id: `gm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              name: lead.name,
              address: lead.address || `${city}, ${state}`,
              phone: lead.phone || '',
              whatsapp: lead.whatsapp || lead.phone || null,
              website: lead.website,
              instagram: lead.instagram,
              rating: lead.rating || 0,
              reviewCount: lead.reviewCount || 0,
              type: lead.website ? 'cold' : 'hot',
              niche,
              city,
              state,
              foundAt: new Date().toISOString(),
            };

            console.log(`[✓] ${finalLead.name} | tel: ${finalLead.phone} | ig: ${finalLead.instagram} | wa: ${finalLead.whatsapp}`);
            allLeads.push(finalLead);
            cityLeads++;

            // Fecha painel: pressiona Escape ou botão de fechar
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);

            // Garante que a lista volta a aparecer
            await page.waitForSelector('[role="feed"]', { timeout: 5000 }).catch(() => { });

          } catch (err) {
            console.warn(`[scraper] erro no card ${idx}:`, err.message?.slice(0, 80));
            await page.keyboard.press('Escape').catch(() => { });
            await page.waitForTimeout(500);
          }
        }

        console.log(`[scraper] ${city}: ${cityLeads} leads extraídos`);

      } catch (err) {
        console.error(`[scraper] erro na cidade ${city}:`, err.message?.slice(0, 100));
      } finally {
        await page.close().catch(() => { });
        await context.close().catch(() => { });
      }
    }

    return allLeads;

  } finally {
    if (browser) await browser.close().catch(() => { });
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.post('/api/scrape-leads', async (req, res) => {
  const { niche, keywords = [], cities = [], state = 'SP', quantity = 20 } = req.body;

  if (!niche || !cities.length) {
    return res.status(400).json({ error: 'niche e cities são obrigatórios', leads: [] });
  }

  const qty = Math.min(parseInt(quantity) || 20, 200); // max 200

  try {
    const leads = await scrapeGoogleMaps({ niche, keywords, cities, state, quantity: qty });
    return res.json({ leads, total: leads.length });
  } catch (err) {
    console.error('[api] erro:', err);
    return res.status(500).json({ error: String(err), leads: [] });
  }
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

const server = app.listen(PORT, () => {
  console.log(`\n🚀 Scraper server rodando em http://localhost:${PORT}`);
  console.log(`   POST /api/scrape-leads  — busca leads no Google Maps`);
  console.log(`   GET  /api/health        — verifica status\n`);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`\n⚠️  Porta ${PORT} já em uso — servidor já está rodando!\n`);
    process.exit(0);
  } else {
    console.error('Erro no servidor:', err);
    process.exit(1);
  }
});

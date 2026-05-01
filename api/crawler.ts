import axios from "axios";
import * as cheerio from "cheerio";

export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  const { q, quantity = 20 } = req.query;

  if (!q) return res.status(400).json({ error: "Query q is required" });

  try {
    // 1. Busca Profunda no Bing (Backend) - Tenta pegar até 3 páginas para garantir volume
    const searchUrls = [
      `https://www.bing.com/search?q=${encodeURIComponent(q as string)}`,
      `https://www.bing.com/search?q=${encodeURIComponent(q as string)}&first=11`,
      `https://www.bing.com/search?q=${encodeURIComponent(q as string)}&first=21`
    ];

    const sites = new Set<string>();
    
    for (const url of searchUrls) {
      try {
        const { data } = await axios.get(url, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
          timeout: 5000
        });
        const $ = cheerio.load(data);
        $('li.b_algo h2 a').each((_, el) => {
          const href = $(el).attr('href');
          if (href && href.startsWith('http') && !href.includes('google.com') && !href.includes('bing.com')) {
            sites.add(new URL(href).origin);
          }
        });
        if (sites.size >= parseInt(quantity as string)) break;
      } catch (e) {
        console.error("[Crawler] Falha ao ler página do Bing");
      }
    }

    const leads = [];
    const siteList = [...sites].slice(0, parseInt(quantity as string));

    // 2. Extração Paralela (P-Queue) ou Map Limitado
    const extractionTasks = siteList.map(async (siteUrl) => {
      try {
        const { data: siteHtml } = await axios.get(siteUrl, {
          timeout: 7000,
          headers: { "User-Agent": "Mozilla/5.0" },
          validateStatus: () => true
        });

        const $site = cheerio.load(siteHtml);
        const whatsappSet = new Set<string>();
        const instagramSet = new Set<string>();

        // Busca links de WhatsApp
        $site('a').each((_, el) => {
          const href = $site(el).attr('href') || '';
          if (href.includes('wa.me') || href.includes('api.whatsapp.com') || href.includes('whatsapp.com/send')) {
             const phone = href.replace(/\D/g, '');
             if (phone.length >= 10 && phone.length <= 13) whatsappSet.add(phone.startsWith('55') ? phone : `55${phone}`);
          }
          if (href.includes('instagram.com/')) {
            const handle = href.split('instagram.com/')[1]?.split('/')[0]?.replace('@', '').split('?')[0];
            if (handle && !['p', 'explore', 'reels', 'stories'].includes(handle)) instagramSet.add(`@${handle}`);
          }
        });

        // Busca no texto do site como Fallback
        const bodyText = $site('body').text();
        const phoneRegex = /(?:\+?55\s?)?\(?[1-9]{2}\)?\s?9?\d{4}[-.\s]?\d{4}/g;
        const phonesInText = bodyText.match(phoneRegex) || [];
        phonesInText.forEach(p => {
          const clean = p.replace(/\D/g, '');
          if (clean.length >= 10 && clean.length <= 11) whatsappSet.add(`55${clean}`);
        });

        return {
          url: siteUrl,
          whatsapp: [...whatsappSet].slice(0, 2),
          instagram: [...instagramSet].slice(0, 1),
          status: 'ok',
          name: siteUrl.replace(/https?:\/\/(www\.)?/, '').split('.')[0]
        };
      } catch (e) {
        return { url: siteUrl, status: 'error' };
      }
    });

    const results = await Promise.all(extractionTasks);
    return res.status(200).json({ leads: results.filter(r => r.status === 'ok') });

  } catch (error: any) {
    return res.status(500).json({ error: error.message });
  }
}

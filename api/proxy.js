import axios from 'axios';
import * as cheerio from 'cheerio';

export const config = {
  maxDuration: 60,
};

export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "URL is required" });

  try {
    // Usamos axios puro no backend para simular um navegador e evitar o erro 500 da Vercel
    const response = await axios.get(decodeURIComponent(url as string).replace(' ', '+'), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
        'Referer': 'https://www.google.com/'
      },
      timeout: 15000,
      maxRedirects: 5
    });

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', response.headers['content-type'] || 'text/html');
    return res.send(response.data);
  } catch (error: any) {
    console.error(`[Proxy] Erro ao buscar Google Maps:`, error.message);
    return res.status(500).json({ error: 500, detail: error.message });
  }
}
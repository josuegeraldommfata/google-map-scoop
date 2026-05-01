# Use a imagem oficial do Playwright que já vem com TODOS os navegadores e dependências
FROM mcr.microsoft.com/playwright:v1.49.0-noble

# Define o diretório de trabalho
WORKDIR /app

# Copia os arquivos de dependências
COPY package*.json ./

# Instala as dependências (incluindo o Express)
RUN npm install

# Instala apenas o Chromium (para economizar espaço)
RUN npx playwright install chromium

# Copia todo o resto do projeto
COPY . .

# Expõe a porta que a Render vai usar
EXPOSE 3001

# Comando para iniciar o servidor
CMD ["node", "server/scraper.mjs"]

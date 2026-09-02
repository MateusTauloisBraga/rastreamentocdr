# Rastreamento Caminhos de Rosa

Site local para acompanhar uma pessoa no percurso da Caminhos de Rosa usando um link compartilhado de rastreador.

## Requisitos

- Node.js 20 ou superior
- Acesso HTTPS liberado para o domínio do rastreador

O projeto não usa Python, então não há `requirements.txt`. A aplicação usa apenas módulos nativos do Node.js; o mapa Leaflet é carregado por CDN no navegador.

## Como Rodar

```bash
npm install
npm run dev
```

Depois abra:

- Mapa público: http://localhost:3000
- Configuração oculta: http://localhost:3000/configurar-rastreador

## Build Check

```bash
npm run build
```

## Dados Locais

Os arquivos em `data/*.json` guardam configuração e estado do rastreador. Eles ficam fora do Git para evitar versionar links ou tokens.

Por padrão, o rastreador é consultado a cada 15 minutos. Para alterar localmente, defina `POLL_MS` antes de iniciar o servidor.

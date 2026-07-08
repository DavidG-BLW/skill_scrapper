# skill_scrapper

Scrapea la reacción social a un evento y la entrega como un `.docx` con branding de Blackwell Strategy.

## Qué hace

Dado un sujeto (persona/marca) y un evento en una ventana de fechas, scrapea Facebook, Instagram, X,
TikTok y Google News vía Apify, filtra a las menciones que realmente ligan al sujeto con el
evento, baja comentarios de las piezas top (con detección de señales de bot/inflado), le entrega
los datos al agente de Claude que la invoca para que redacte el análisis ejecutivo (sin llamar a
ningún LLM externo), y renderiza el resultado en un `.docx` de diseño fijo: fuentes Fraunces/Geist,
paleta tinta/oro/azul, 7 secciones (Método, Resumen Ejecutivo, Volumen y Alcance, Narrativas
Dominantes, Lectura de Sentimiento, Riesgos y Recomendaciones, Preguntas y Respuestas Sugeridas).

El diseño viene de `scripts/report-docx.js` — un port directo del generador de reportes
original de Blackwell. Es fijo a propósito: solo cambia el contenido, nunca el layout.

Portado de los scripts originales de un solo sujeto (Pepe Aguilar) de `DashboardPP`,
generalizado para tomar cualquier sujeto vía un objeto `subjectConfig` (nombre, keywords de
relevancia, cuentas propias a excluir).

## Cómo invocarla

Pide un reporte de social listening / de evento para alguna persona o marca, o invoca `/skill_scrapper`.

## Requisitos

- `npm install` en este directorio, una vez.
- Variables de entorno: `APIFY_TOKEN`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — solo las necesita el paso `prepare`, y solo si la ventana de fechas no está ya scrapeada/en caché. Copia [`.env.example`](./.env.example) a `.env` y llena valores reales — `.env` está en `.gitignore` y nunca se sube. Si ya están exportadas en tu shell, no necesitas un archivo `.env` en absoluto. `OPENROUTER_API_KEY` **no se usa** — el texto del reporte lo escribe el agente que la invoca.
- Un `subjectConfig` para quien se esté monitoreando (ver [`SKILL.md`](./SKILL.md) para la forma exacta).

## Uso

Dos pasos — ver [`SKILL.md`](./SKILL.md) para el flujo completo:

```bash
# 1) scrapear + filtrar + armar el prompt (sin llamada a IA)
node --env-file=.env scripts/generate-event-report.js prepare \
  --subject='{"subjectName":"...","keywords":["..."]}' \
  --query="descripción corta del evento" --from=YYYY-MM-DD --to=YYYY-MM-DD \
  --context=./.event-report-context.json

# 2) el agente lee el prompt impreso y escribe ./analysis.json siguiendo su esquema

# 3) renderiza el .docx a partir de ese análisis (sin llamada a IA, sin scraping)
node scripts/generate-event-report.js finalize \
  --context=./.event-report-context.json --analysis=./analysis.json \
  --out=./BW-report.docx
```

## Archivos

- `scripts/subject-config.js` — forma de la configuración de sujeto, normalización, matching de relevancia, carga por CLI.
- `scripts/run-full-analysis.js` — el motor de scraping de Apify (el análisis IA por red es opcional/se salta cuando no se pasa `aiKey`, que es el caso aquí).
- `scripts/event-report.js` — `prepareEventReport` (scrapea+filtra+arma el prompt) y `finalizeEventReportData` (JSON del agente -> data lista para el docx).
- `scripts/report-docx.js` + `scripts/report-assets/` — el renderizador del diseño fijo de Blackwell (fuentes e íconos embebidos).
- `scripts/generate-event-report.js` — punto de entrada CLI con los subcomandos `prepare`/`finalize`.

## Ver también

- [`SKILL.md`](./SKILL.md) — instrucciones completas para el LLM

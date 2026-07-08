---
name: skill_scrapper
description: >
  Scrapea datos públicos de social listening (Facebook, Instagram, X, TikTok, Google News) vía
  Apify para un sujeto configurable, los filtra a un evento/momento específico, y genera un
  "Reporte de evento" con el branding de Blackwell Strategy como .docx con diseño fijo (fuentes
  Fraunces/Geist, paleta tinta/oro/azul, 7 secciones fijas). El texto del análisis ejecutivo lo
  redacta el propio agente de Claude que invoca la skill (sin llamar a ningún LLM externo). Úsala
  cuando el usuario pida scrapear/analizar la reacción social a un evento para una persona o
  marca y entregarlo como reporte Blackwell, o invoque /skill_scrapper. Siempre entrega
  el reporte en este formato exacto — nunca improvises un diseño distinto.
---

# Skill Scrapper (Social Listening Report)

## Propósito

Dado un sujeto (persona/marca) y un evento específico en una ventana de fechas, esta skill:
1. Scrapea menciones públicas en Facebook, Instagram, X, TikTok y Google News para esa ventana (vía Apify), a menos que ya estén scrapeadas y guardadas.
2. Filtra las menciones a las que realmente ligan al sujeto con el evento (no solo al sujeto, no solo al evento).
3. Baja comentarios de las piezas top y detecta señales de engagement inorgánico/bot.
4. Le entrega al agente (tú) un prompt con todos esos datos — **tú** redactas el análisis ejecutivo estructurado, sin llamar a ningún LLM externo.
5. Renderiza ese análisis en un `.docx` usando el diseño exacto de Blackwell Strategy — mismas fuentes, colores, layout y estructura de 7 secciones siempre.

**El diseño es fijo y nunca debe improvisarse ni alterarse.** Solo cambia el contenido entre reportes. Si te piden "hacer un reporte" para cualquier sujeto/evento, esta skill es el único camino — no escribas a mano un docx con un estilo distinto.

**El texto del reporte lo escribes tú (el agente), no una API externa.** No hay ninguna llamada a OpenRouter/OpenAI/API de Anthropic en esta skill para la redacción del reporte — `scripts/generate-event-report.js prepare` se detiene justo después de armar el prompt y lo imprime; tú lo lees, razonas sobre los datos reales scrapeados que contiene, y produces el JSON del análisis tú mismo, siguiendo exactamente el esquema del prompt. Luego `finalize` convierte ese JSON en el `.docx`. Nunca inventes datos que no estén en el prompt — el prompt ya contiene cada post/comentario que tienes permitido citar.

## Requisitos

Corre una vez por entorno: `npm install` dentro del directorio de esta skill (instala `@supabase/supabase-js`, `docx`, `jszip`).

Variables de entorno necesarias:
- `APIFY_TOKEN` — token personal de Apify. Solo lo requiere `prepare` si la ventana de fechas pedida no está ya scrapeada y en caché en Supabase.
- `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` — un proyecto de Supabase con las tablas `reports`, `scraped_posts`, `scraped_comments` (la tabla `reports` necesita la columna `subject_config jsonb`: `alter table reports add column if not exists subject_config jsonb;`). Supabase se usa para cachear los datos scrapeados por fecha+sujeto, así que volver a correr un reporte (o scrapear una ventana de varios días) no le vuelve a pagar a Apify por el mismo día dos veces.

`OPENROUTER_API_KEY` **no se usa** en esta skill. El texto del reporte lo escribes tú, el agente que la invoca.

### Cómo llegan las credenciales al agente

Son secretos — nunca deben vivir dentro de `SKILL.md`, los scripts, ni nada que se suba a git. Resuélvelos en este orden, y detente en el primero que funcione:

1. **Ya están en el entorno del proceso.** Si la sesión/shell del usuario ya exporta `APIFY_TOKEN`, `OPENROUTER_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` (ej. definidas en su perfil del sistema operativo, o en un proceso padre), las llamadas a Bash/PowerShell las heredan automáticamente — no hay que hacer nada.
2. **Un archivo `.env` local junto a este SKILL.md.** Copia `.env.example` a `.env`, llena valores reales, e invoca los scripts con el cargador de env-file nativo de Node: `node --env-file=.env scripts/generate-event-report.js ...`. `.env` está en `.gitignore` — nunca lo quites de `.gitignore`, nunca hagas `cat`/lo imprimas de vuelta en el chat, nunca escribas su contenido en archivos de memoria ni en mensajes de commit.
3. **Reusar el `.env` de otro proyecto.** Si las mismas credenciales ya existen en otra parte del workspace del usuario (ej. el `.env` de una app hermana), apunta `--env-file=` directamente a esa ruta en vez de duplicar los secretos en un segundo archivo.
4. **Pregúntale al usuario.** Si nada de lo anterior resuelve, pregunta cuáles de las 4 variables faltan y cómo prefiere dártelas (pegar valores para escribir un `.env` local, o apuntar a un archivo ya existente). Nunca inventes, adivines, ni reutilices credenciales de ejemplo/placeholder como si fueran reales.

Nunca imprimas valores completos de credenciales en respuestas, logs, ni mensajes de commit — al confirmar que una variable está definida, reporta solo que está presente (y opcionalmente su longitud), no su valor.

## Configuración del sujeto

Cada corrida necesita un `subjectConfig` que describa a quién/qué se está monitoreando:

```json
{
  "subjectName": "Nombre Completo",
  "keywords": ["nombre completo", "apodo", "variante de hashtag"],
  "newsKeywords": ["keywords mas estrictos para Google News, opcional — si falta usa keywords"],
  "ownedAccounts": {
    "instagram": "usuario", "tiktok": "usuario",
    "x": "https://x.com/usuario", "facebook": "id de pagina",
    "youtubeChannelId": "UC..."
  },
  "excludeUsernames": ["handles extra que nunca se traten como aliados/criticos"]
}
```

Pídele al usuario `subjectName` y `keywords` como mínimo. `ownedAccounts` es opcional pero mejora los resultados (deja que el reporte excluya los propios posts del sujeto de ser malinterpretados como reacción de terceros). Persiste la configuración del sujeto que te dé el usuario (ej. escríbela en un JSON pequeño en el directorio de trabajo) para que corridas repetidas del mismo sujeto no requieran volver a preguntar.

## Cómo correrla

**Paso 1 — prepare** (scrapea + filtra + arma el prompt; sin llamada a IA):

```bash
node --env-file=.env scripts/generate-event-report.js prepare \
  --subject='<JSON de subjectConfig, o usa --subject-file=ruta.json>' \
  --query="descripción corta del evento, ej. 'México vs Inglaterra'" \
  --from=YYYY-MM-DD --to=YYYY-MM-DD \
  --context=./.event-report-context.json
```

Quita `--env-file=.env` si las credenciales ya están exportadas en el shell (ver "Cómo llegan las credenciales al agente" arriba). Este paso solo necesita `APIFY_TOKEN`/`SUPABASE_*` si la ventana no está ya en caché.

- `--query` debe ser una descripción corta y humana del evento — se usa tanto para extraer keywords como de título de respaldo.
- `--from`/`--to` definen la ventana de scraping/análisis (usualmente el día del evento, a veces ±1 día). Si se omite `--to`, toma el valor de `--from`.
- `--context` es opcional; por default `./.event-report-context.json` en el directorio actual.
- El script transmite progreso a stdout (fases de scraping, conteo de comentarios). Comparte el progreso relevante con el usuario; no esperes en silencio.
- Termina imprimiendo el prompt completo en stdout, seguido del esquema JSON exacto a llenar.

**Paso 2 — tú redactas el análisis.** Lee el prompt impreso con cuidado. Usando *solo* los datos que contiene (posts, comentarios, señales — nunca nada fuera de ahí), escribe el objeto JSON con la estructura exacta que pide el prompt (`titulo_evento`, `metodo`, `resumen`, `piezas`, `narrativas`, `sentimiento`, `riesgos`, `qa`, etc.). Guárdalo en un archivo, ej. `./analysis.json`. Aplica las mismas reglas duras que lista el prompt: no inventes cifras/citas, deduplica piezas casi idénticas, señala engagement inorgánico (`topShare`/`emojiPct` altos), varía el `tono` por pieza en vez de poner "Neutral" por default, cita comentarios reales de forma textual.

**Paso 3 — finalize** (renderiza el `.docx` a partir de tu análisis; sin llamada a IA, sin scraping):

```bash
node scripts/generate-event-report.js finalize \
  --context=./.event-report-context.json --analysis=./analysis.json \
  --out=./BW-report.docx
```

- `--out` es opcional; por default `./<folio-generado>.docx` en el directorio actual.

Si tiene éxito, imprime la ruta de salida y una línea de estadísticas (piezas/reacciones/comentarios/vistas incluidas en el reporte). Reporta tanto la ruta del archivo como un resumen humano corto de lo encontrado — el usuario aún necesita saber si la historia es "semana tranquila" vs. "narrativa activa."

## Límites

- No fabriques datos scrapeados, citas ni métricas — si las llamadas a Apify fallan o no devuelven nada, muestra el error en vez de inventar contenido de relleno. Aplica la misma regla al redactar el JSON del análisis: usa solo lo que está en el prompt preparado.
- No cambies los colores, fuentes, márgenes ni el orden de secciones de `scripts/report-docx.js`. Ese archivo **es** el diseño aprobado; trátalo como fuente de diseño de solo lectura, no como punto de partida para restilizarlo.
- Esta skill solo cubre reportes de ventana de evento (un rango de fechas acotado ligado a un suceso específico). No hace reportes periódicos/de panorama diario.
- Si aún no existe una configuración de sujeto para la persona/marca en cuestión, pregúntale al usuario en vez de adivinar keywords.
- Nunca llames a una API de LLM externa (OpenRouter, llamadas crudas al SDK de Anthropic/OpenAI, etc.) para redactar el texto del reporte — ese es tu trabajo como agente que corre esta skill.

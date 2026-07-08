/**
 * generate-event-report.js — Punto de entrada CLI de la skill, en dos pasos. El texto del
 * reporte NO lo escribe una API externa: lo redacta el agente de Claude que está ejecutando
 * esta skill, siguiendo el prompt y el esquema JSON que arma el paso "prepare".
 *
 * Paso 1 — prepare: scrapea (si falta), filtra al sujeto+evento, baja comentarios y arma el
 * prompt. Guarda el contexto en un JSON y lo imprime para que el agente lo lea.
 *
 *   node scripts/generate-event-report.js prepare \
 *     --subject='{"subjectName":"...","keywords":[...],"ownedAccounts":{...}}' \
 *     --query="México vs Inglaterra" --from=2026-07-05 --to=2026-07-06 \
 *     --context=./.event-report-context.json
 *
 * Paso 2 — el agente lee el prompt impreso, redacta el JSON del análisis (la estructura
 * exacta que pide el prompt) y lo guarda en un archivo, ej. ./analysis.json.
 *
 * Paso 3 — finalize: toma el contexto guardado + el JSON del agente y genera el .docx final.
 *
 *   node scripts/generate-event-report.js finalize \
 *     --context=./.event-report-context.json --analysis=./analysis.json \
 *     --out=./BW-reporte.docx
 *
 * Variables de entorno:
 *   APIFY_TOKEN, SUPABASE_URL, SUPABASE_SERVICE_KEY — solo hacen falta si el paso "prepare"
 *   necesita scrapear días que aún no estén en Supabase. Ya no se usa ni se requiere
 *   OPENROUTER_API_KEY: el texto del reporte lo genera el propio agente, no un LLM externo.
 */
import fs from 'fs';
import path from 'path';
import { prepareEventReport, finalizeEventReportData } from './event-report.js';
import { buildReportDocx } from './report-docx.js';
import { loadSubjectConfigFromCli } from './subject-config.js';

function parseArgs(argv) {
  const get = (prefix) => argv.find(a => a.startsWith(prefix))?.slice(prefix.length);
  return {
    query: get('--query='),
    from: get('--from='),
    to: get('--to=') || get('--from='),
    out: get('--out='),
    context: get('--context=') || './.event-report-context.json',
    analysis: get('--analysis='),
  };
}

const emit = (ev) => {
  if (ev.type === 'phase') console.log(`▶ ${ev.msg}`);
  else if (ev.type === 'info') console.log(`  · ${ev.msg}`);
  else if (ev.type === 'error') console.error(`  ✗ ${ev.msg}`);
  else if (ev.type === 'saved') console.log(`  └ ${ev.net}: ${ev.count} posts`);
  else if (ev.type === 'comments') console.log(`  └ ${ev.platform} ${ev.url}: ${ev.count} comentarios`);
};

async function runPrepare(argv) {
  const { query, from, to, context } = parseArgs(argv);
  if (!query || !from) {
    console.error(
      'Uso: node scripts/generate-event-report.js prepare --subject=\'{"subjectName":"...","keywords":[...]}\' ' +
      '--query="<evento>" --from=YYYY-MM-DD [--to=YYYY-MM-DD] [--context=ruta.json]'
    );
    process.exit(1);
  }
  const subjectConfig = loadSubjectConfigFromCli(argv);

  const { prompt, cands, cfg, query: q, to: toResolved } = await prepareEventReport({
    apifyToken: process.env.APIFY_TOKEN || null,
    query, from, to, subjectConfig, emit,
  });

  const contextPath = path.resolve(context);
  fs.writeFileSync(contextPath, JSON.stringify({ cands, cfg, query: q, to: toResolved }, null, 2));

  console.log(`\n✓ Contexto guardado en: ${contextPath}`);
  console.log(`  (${cands.length} piezas candidatas)`);
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log('SIGUIENTE PASO — agente: lee este prompt, redacta el JSON pedido');
  console.log('EXACTAMENTE con esta estructura, y guárdalo en un archivo.');
  console.log('════════════════════════════════════════════════════════════════\n');
  console.log(prompt);
  console.log('\n════════════════════════════════════════════════════════════════');
  console.log(`Luego corre: node scripts/generate-event-report.js finalize --context=${context} --analysis=<ruta-del-json-que-escribiste> [--out=ruta.docx]`);
}

async function runFinalize(argv) {
  const { context, analysis, out } = parseArgs(argv);
  if (!analysis) {
    console.error('Uso: node scripts/generate-event-report.js finalize --context=ruta.json --analysis=ruta.json [--out=ruta.docx]');
    process.exit(1);
  }
  const contextPath = path.resolve(context);
  const analysisPath = path.resolve(analysis);
  if (!fs.existsSync(contextPath)) throw new Error(`No existe el archivo de contexto: ${contextPath}. Corre primero "prepare".`);
  if (!fs.existsSync(analysisPath)) throw new Error(`No existe el archivo de análisis: ${analysisPath}. El agente debe escribirlo primero.`);

  const { cands, cfg, query, to } = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
  const analysisJson = JSON.parse(fs.readFileSync(analysisPath, 'utf8'));

  const data = finalizeEventReportData({ query, to, analysis: analysisJson, cands, cfg });

  console.log('▶ Generando el .docx...');
  const buf = await buildReportDocx(data);
  const outPath = path.resolve(out || `./${data.meta.folio}.docx`);
  fs.writeFileSync(outPath, buf);
  console.log(`✓ Reporte generado: ${outPath}`);
  console.log(`  Piezas: ${data._stats.piezas} · Reacciones: ${data._stats.reacciones} · Comentarios: ${data._stats.comentarios} · Vistas: ${data._stats.vistas}`);
}

async function main() {
  const [sub, ...rest] = process.argv.slice(2);
  if (sub === 'prepare') await runPrepare(rest);
  else if (sub === 'finalize') await runFinalize(rest);
  else {
    console.error(
      'Uso:\n' +
      '  node scripts/generate-event-report.js prepare --subject=\'{...}\' --query="..." --from=YYYY-MM-DD [--to=...] [--context=ruta.json]\n' +
      '  node scripts/generate-event-report.js finalize --context=ruta.json --analysis=ruta.json [--out=ruta.docx]'
    );
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });

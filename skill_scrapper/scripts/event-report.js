/**
 * event-report.js — Arma el "Reporte de evento" para cualquier sujeto de monitoreo.
 * Generalización de DashboardPP/scripts/event-report.js: en vez de tener "Pepe Aguilar"
 * fijo, toma un subjectConfig (mismo formato que subject-config.js) con nombre, keywords
 * de relevancia y cuentas propias a excluir.
 *
 * Flujo: (scrapear si falta) → filtrar a sujeto + query del evento → comentarios de piezas
 *        top → contexto del último panorama → IA arma el análisis → data para report-docx.
 */
import { runFullAnalysis, scrapeCommentsForUrls, supabase } from './run-full-analysis.js';
import { normalizeSubjectConfig, relevanceMatcher, ownedUsernamesToExclude } from './subject-config.js';

const MESES = ['ENE','FEB','MAR','ABR','MAY','JUN','JUL','AGO','SEP','OCT','NOV','DIC'];
const strip = s => (s||'').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
const dateRange = (from, to) => { const out=[]; let d=new Date(from+'T12:00:00Z'); const end=new Date(to+'T12:00:00Z'); while(d<=end){ out.push(d.toISOString().slice(0,10)); d.setUTCDate(d.getUTCDate()+1); } return out; };
const STOP = new Set(['vs','contra','de','del','la','el','los','las','en','y','a','partido','evento','mundial','2026','con','por']);

function keywordsFrom(query){
  const words = strip(query).split(/[^a-z0-9]+/).filter(w => w.length>=4 && !STOP.has(w));
  return [...new Set([strip(query), ...words])].filter(Boolean);
}

// Iniciales del sujeto para el folio (ej. "Pepe Aguilar" -> "PA", "Cher" -> "CH").
function subjectInitials(name){
  const words = String(name||'').trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return words.slice(0,2).map(w => w[0]).join('').toUpperCase();
  return (words[0] || 'SU').slice(0,2).toUpperCase();
}

// Todo lo que sigue está filtrado por subjectName (subject_config->>subjectName) para que
// dos sujetos distintos scrapeados en la misma fecha no se mezclen entre sí.
async function hasScraped(date, subjectName){
  let q = supabase.from('reports').select('id').eq('date_key',date).neq('theme_key','resumen');
  if (subjectName) q = q.eq('subject_config->>subjectName', subjectName);
  const { data: reps } = await q;
  if(!reps?.length) return false;
  const { count } = await supabase.from('scraped_posts').select('id',{count:'exact',head:true}).in('report_id', reps.map(r=>r.id));
  return (count||0) > 0;
}

async function fetchWindowPosts(dates, subjectName){
  let q = supabase.from('reports').select('id').in('date_key',dates).neq('theme_key','resumen');
  if (subjectName) q = q.eq('subject_config->>subjectName', subjectName);
  const { data: reps } = await q;
  if(!reps?.length) return [];
  const { data: posts } = await supabase.from('scraped_posts')
    .select('id,platform,username,text,url,published_date,likes,comments_count,views').in('report_id', reps.map(r=>r.id)).limit(2000);
  const byUrl={}; for(const p of (posts||[])){ const k=p.url||p.id; if(!byUrl[k] || (p.likes+p.views)>(byUrl[k].likes+byUrl[k].views)) byUrl[k]=p; }
  return Object.values(byUrl);
}

async function latestResumen(toDate, subjectName){
  let q = supabase.from('reports').select('date_key,ai_analysis')
    .eq('theme_key','resumen').lte('date_key',toDate).not('ai_analysis','is',null);
  if (subjectName) q = q.eq('subject_config->>subjectName', subjectName);
  const { data } = await q.order('date_key',{ascending:false}).limit(1);
  return data?.[0] || null;
}

const reach = p => (p.views||0) + (p.likes||0)*5;

function commentSignal(comments){
  const n = comments?.length || 0; if(!n) return null;
  const byAuthor = {}; let emoji = 0;
  for(const c of comments){ const a=(c.author||'?'); byAuthor[a]=(byAuthor[a]||0)+1; if(!/[a-záéíóúñü]/i.test(c.text||'')) emoji++; }
  const sorted = Object.entries(byAuthor).sort((a,b)=>b[1]-a[1]);
  return { n, topAuthor: sorted[0][0], topCount: sorted[0][1], topShare: Math.round(sorted[0][1]/n*100), emojiPct: Math.round(emoji/n*100) };
}

function buildPrompt({ query, from, to, cands, commentsByUrl, signalByUrl, ctx, cfg }){
  const name = cfg.subjectName;
  let out = `Eres analista senior de reputacion y crisis para ${name} (Blackwell Strategy). Redacta un REPORTE ejecutivo, honesto, factual y bien escrito, SOLO sobre lo que liga a ${name} con el evento "${query}" (ventana ${from} a ${to}). El lector es el cliente; tono profesional, directo, sin relleno.\n\n`;
  out += `REGLAS DURAS:\n`;
  out += `- Usa SOLO los datos de abajo. No inventes cifras, autores ni frases.\n`;
  out += `- Cita comentarios/posts de forma TEXTUAL y COMPLETA (no cortes a media palabra; si el texto viene truncado con "…", no lo cites o parafrasea el sentido).\n`;
  out += `- Distingue con cuidado: si la mencion es a un tercero relacionado, al equipo/entorno del evento, o a otro tema y ${name} solo esta etiquetado, dilo y baja su relevancia. El objeto es ${name.toUpperCase()} + el evento.\n`;
  out += `- DEDUPLICA: si dos piezas cubren lo mismo (mismo evento/clip), quedate con una.\n`;
  out += `- SEÑALES DE BOTS/INFLADO: cada pieza trae una linea SEÑAL con % de comentarios de una sola cuenta y % emoji-only. Si topShare es alto (>=35%) o emojiPct alto (>=50%), trata ese "apoyo" como NO organico y decláralo explicitamente en el reporte (narrativa y riesgos).\n`;
  out += `- TONO por pieza: Positivo | Negativo | Reproche | Burla | Neutral | Critico. Se preciso, no pongas todo "Neutral".\n`;
  out += `- Si el volumen es bajo, dilo claramente (es un hallazgo valido, no lo infles).\n`;
  out += `- CARDS de comentario: la meta debe usar los datos DEL COMENTARIO (\"RED · @autor_del_comentario · N likes\"), nunca las metricas del post.\n\n`;
  if(ctx?.ai_analysis?.sentimiento){ const s=ctx.ai_analysis.sentimiento; out += `CONTEXTO (ultimo panorama ${ctx.date_key}): favorable ${s.favorable}% / neutral ${s.neutral}% / critico ${s.critico}%, riesgo ${ctx.ai_analysis.nivel_riesgo||'?'}. Usalo solo como telon de fondo.\n\n`; }
  out += `PIEZAS CANDIDATAS (elige SOLO las realmente relevantes a ${name}+evento; para la tabla usa su URL tal cual):\n`;
  cands.forEach((p,i)=>{
    out += `#${i+1} url:${p.url} | ${p.platform} | @${p.username} | ${(p.published_date||'').slice(0,10)} | likes:${p.likes} comentarios_declarados:${p.comments_count} vistas:${p.views}\n`;
    out += `   texto: "${(p.text||'').replace(/\s+/g,' ').slice(0,360)}"\n`;
    const sg = signalByUrl[p.url];
    if(sg) out += `   SEÑAL comentarios: ${sg.n} captados · cuenta top @${sg.topAuthor} aporta ${sg.topCount} (${sg.topShare}%) · emoji-only ${sg.emojiPct}%\n`;
    const cm = commentsByUrl[p.url];
    if(cm?.length){ out += `   comentarios: ` + cm.slice(0,20).map(c=>`@${c.author}(${c.likes||0}likes):"${(c.text||'').replace(/\s+/g,' ').slice(0,140)}"`).join(' | ') + `\n`; }
  });
  out += `\nDevuelve SOLO JSON valido (sin markdown fuera de los campos). Usa **negritas** dentro de los textos para enfatizar 1-2 frases clave. Estructura EXACTA:\n`;
  out += `{
 "titulo_evento": "nombre MUY corto del evento, max 4 palabras, SIN parentesis ni sufijos (ej: 'México vs Inglaterra', NO 'México vs Inglaterra (Mundial 2026) — Menciones a ${name}')",
 "metodo": "1-2 frases: que se midio y que se excluyo (menciona si el volumen fue bajo)",
 "resumen_sub": "titular corto y con gancho, con **negritas**",
 "resumen": "3-4 frases ejecutivas con **negritas**; el hallazgo principal primero",
 "piezas": [ {"url":"<de las candidatas>","titulo":"titulo corto y claro","tono":"Positivo|Negativo|Reproche|Burla|Neutral|Critico"} ],
 "narrativas": [ {"titulo":"**A · Nombre**: subtitulo","color":"blue|gold|red","intro":"1-2 frases","cards":[ {"label":"ETIQUETA MONO CORTA","quote":"cita textual completa","meta":"RED · @autor · N likes (del comentario o post citado)","accent":"blue|gold|red","metaIcon":"ig|tt|fb"} ]} ],
 "sentimiento_sub":"titular con **negritas**", "sentimiento":"2-3 frases; si el apoyo positivo no es organico (bots), dilo aqui",
 "riesgos":[ {"lead":"Titulo corto. ","rest":"detalle accionable"} ],
 "qa":[ {"tema":"pregunta/tema probable","respuesta":"linea de mensaje sugerida, lista para usar"} ]
}
Guia: 2-4 narrativas, cada una con 1-3 cards. Colores: azul=positivo/neutro, oro=matiz/fragil, rojo=negativo/alerta. Si hay bots, incluye una card o riesgo rojo que lo señale.`;
  return out;
}

// ── mini-markdown: **negritas** -> runs ──
function mdRuns(text, def={}){
  const runs=[]; const parts=String(text||'').replace(/\s+/g,' ').split(/(\*\*[^*]+\*\*)/g);
  for(let part of parts){ if(!part) continue; const m=part.match(/^\*\*([^*]+)\*\*$/);
    if(m){ runs.push({...def,t:m[1].trim(),b:true}); }
    else { part=part.replace(/\*+/g,''); if(part.trim()||/ $|^ /.test(part)) runs.push({...def,t:part}); } }
  return runs.length?runs:[{...def,t:''}];
}
const canalLabel = { instagram:'Instagram', tiktok:'TikTok', facebook:'Facebook' };

export function finalizeEventReportData({ query, to, analysis, cands, cfg }){
  const byUrl = Object.fromEntries(cands.map(p=>[p.url,p]));
  const chosen = (analysis.piezas||[]).map(x=>({ ...x, p:byUrl[x.url] })).filter(x=>x.p);
  const sum=(k)=>chosen.reduce((s,x)=>s+(+x.p[k]||0),0);
  const nReacc=sum('likes'), nCom=sum('comments_count'), nViews=sum('views');
  const fmt=n=> n>=1000 ? (n/1000).toFixed(1).replace(/\.0$/,'')+'K' : String(n);

  const d = new Date(to+'T12:00:00Z');
  const yy=String(d.getUTCFullYear()).slice(2), mm=String(d.getUTCMonth()+1).padStart(2,'0');
  const slug = strip(analysis.titulo_evento||query).replace(/[^a-z0-9]/g,'').toUpperCase().slice(0,10) || 'EVENTO';
  const initials = subjectInitials(cfg.subjectName);
  const folio = `BW-${yy}-${mm}-${initials}-${slug}-001`;
  const fechaLabel = `${String(d.getUTCDate()).padStart(2,'0')} · ${MESES[d.getUTCMonth()]} · ${d.getUTCFullYear()}`;
  const evento = (analysis.titulo_evento || query).replace(/\s*[—–-].*$/,'').replace(/\s*\(.*$/,'').trim() || query;
  const capWords = (s, max) => { s = s.trim(); if (s.length <= max) return s; return s.slice(0, max).replace(/\s+\S*$/, '') || s.slice(0, max); };
  const firstName = cfg.subjectName.split(/\s+/)[0].toUpperCase();

  const canalesPresentes = [...new Set(chosen.map(x=>x.p.platform))];
  const fuentes = canalesPresentes.map(c=>({ icon:({instagram:'ig',tiktok:'tt',facebook:'fb'}[c]), label:canalLabel[c]||c }));

  return {
    meta:{
      folio, fechaLabel, kicker:`${cfg.subjectName.toUpperCase()} · ${capWords(evento, 26).toUpperCase()}`,
      tituloRuns:[{t:'Reacción pública a '},{t:cfg.subjectName,b:true},{t:' en torno a '},{t:evento,b:true}],
      fuentes,
    },
    metodo:{ sub:[{t:'Qué mide este reporte y '},{t:'qué se dejó fuera',b:true},{t:'.'}], paras:[ mdRuns(analysis.metodo) ] },
    resumen:{ sub:mdRuns(analysis.resumen_sub), paras:[ mdRuns(analysis.resumen) ], stats:[
      { label:`PIEZAS · ${firstName}`, idx:'01', big:String(chosen.length), cap:'LIGADAS AL EVENTO' },
      { label:'REACCIONES', idx:'02', big:fmt(nReacc), cap:`EN ${chosen.length} PIEZAS` },
      { label:'ALCANCE', idx:'03', big:fmt(nViews)||'—', cap:`VISTAS · ${nCom} COMENT` },
    ]},
    volumen:{ sub:[{t:'Las piezas que '},{t:`ligan a ${cfg.subjectName} con el evento`,b:true},{t:'.'}],
      intro:[{t:'Totales: '},{t:`${chosen.length} piezas · ${nReacc} reacciones · ${nCom} comentarios · ${nViews} vistas`,b:true},{t:'.'}],
      piezas: chosen.slice().sort((a,b)=>reach(b.p)-reach(a.p)).map(x=>({
        titulo:x.titulo, url:x.url, canal:x.p.platform, fecha:(x.p.published_date||'').slice(5,10),
        alcance: x.p.views ? `${x.p.views.toLocaleString('en')} v` : (x.p.comments_count?`${x.p.comments_count} com`:'—'),
        reacc: (x.p.likes||0).toLocaleString('en'), tono:x.tono||'',
      })) },
    narrativas:{ sub:[{t:'Cómo se '},{t:`encuadra a ${cfg.subjectName}`,b:true},{t:'.'}],
      bloques:(analysis.narrativas||[]).map(n=>({ tituloRuns:mdRuns(n.titulo,{c:n.color||'ink'}), intro:[{t:n.intro||''}],
        cards:(n.cards||[]).map(c=>({ accent:c.accent||n.color||'blue', label:c.label||'', quote:c.quote||'', meta:c.meta||'', metaIcon:c.metaIcon })) })) },
    sentimiento:{ sub:mdRuns(analysis.sentimiento_sub), paras:[ mdRuns(analysis.sentimiento) ] },
    riesgos:{ sub:[{t:'Riesgos y '},{t:'recomendaciones',b:true},{t:'.'}], bullets:(analysis.riesgos||[]).map(b=>({ lead:b.lead||'', rest:b.rest||'' })) },
    qa:{ sub:[{t:'Líneas de mensaje '},{t:'ante coyuntura',b:true},{t:'.'}],
      filas:(analysis.qa||[]).map(f=>({ tema:f.tema||'', respuesta:[ {runs:mdRuns(f.respuesta)} ] })) },
    _stats:{ piezas:chosen.length, reacciones:nReacc, comentarios:nCom, vistas:nViews },
  };
}

// Fase de preparación: scrapea (si falta), filtra al sujeto+evento, baja comentarios y arma
// el prompt del reporte. NO llama a ningún LLM externo — el texto lo redacta el agente de
// Claude que está ejecutando esta skill, leyendo `prompt` y devolviendo el JSON pedido ahí.
// apifyToken es opcional: solo se usa si faltan datos de algún día del rango por scrapear.
export async function prepareEventReport({ apifyToken, query, from, to, subjectConfig, emit=()=>{} }){
  const cfg = normalizeSubjectConfig(subjectConfig);
  const dates = dateRange(from, to);
  // 1) scrapear fechas faltantes (solo para este sujeto)
  for(const d of dates){
    if(await hasScraped(d, cfg.subjectName)){ emit({type:'info',msg:`Datos de ${cfg.subjectName} en ${d} ya en Supabase.`}); continue; }
    if(!apifyToken) throw new Error(`Sin datos de ${d} y no se dio APIFY_TOKEN para scrapearlos.`);
    emit({type:'phase',msg:`Sin datos de ${d}; scrapeando con Apify...`});
    // aiKey se omite a propósito: el análisis diario por red no lo necesita este reporte de
    // evento (solo lee los posts crudos), así que no se gasta OpenRouter en el backfill.
    await runFullAnalysis({ apifyToken, aiKey:null, date:d, subjectConfig:cfg, emit:(e)=>emit({...e,scope:'scrape'}) });
  }
  // 2) filtrar a sujeto + evento
  const kws = keywordsFrom(query);
  const posts = await fetchWindowPosts(dates, cfg.subjectName);
  const isSubject = relevanceMatcher(cfg.keywords);
  const subject = p => isSubject((p.text||'')+' '+(p.username||''));
  const inWin = p => dates.includes((p.published_date||'').slice(0,10));
  const ownedSet = new Set(ownedUsernamesToExclude(cfg));
  const owned = p => ownedSet.has((p.username||'').trim().toLowerCase().replace(/^@/,''));
  let cands = posts.filter(p => inWin(p) && !owned(p) && subject(p) && kws.some(k => strip(p.text).includes(k)))
    .sort((a,b)=>reach(b)-reach(a));
  // dedup near-duplicados (misma cuenta + mismo inicio de texto)
  const seen = new Set();
  cands = cands.filter(p => { const key=(p.username||'')+'|'+strip(p.text).slice(0,30); if(seen.has(key)) return false; seen.add(key); return true; }).slice(0,18);
  emit({type:'phase',msg:`${cands.length} piezas candidatas (${cfg.subjectName} + "${query}").`});
  if(!cands.length) throw new Error(`No se encontraron piezas de ${cfg.subjectName} ligadas a "${query}" en la ventana.`);

  // 3) comentarios de las piezas top + señales de inflado
  const top = cands.slice(0,7);
  emit({type:'phase',msg:`Bajando comentarios de ${top.length} piezas top...`});
  const cmts = await scrapeCommentsForUrls({ apifyToken, items: top.map(p=>({platform:p.platform,url:p.url})), limit:300, emit });
  const commentsByUrl = {}, signalByUrl = {};
  for(const r of cmts) if(!r.error){ commentsByUrl[r.url]=r.comments; const sg=commentSignal(r.comments); if(sg) signalByUrl[r.url]=sg; }

  // 4) contexto del último panorama (best-effort, solo para telón de fondo en el prompt)
  const ctx = await latestResumen(to, cfg.subjectName);
  const prompt = buildPrompt({ query, from, to, cands, commentsByUrl, signalByUrl, ctx, cfg });
  emit({type:'info',msg:'Prompt listo. El agente debe redactar el analisis JSON y pasarlo a finalizeEventReportData.'});

  // cands se devuelve "limpio" (sin comentarios/señales embebidos) porque finalizeEventReportData
  // solo necesita url/platform/username/published_date/likes/comments_count/views por pieza.
  return { prompt, cands, cfg, query, to };
}

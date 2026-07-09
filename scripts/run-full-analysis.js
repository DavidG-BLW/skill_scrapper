/**
 * run-full-analysis.js
 * Orquestador completo: Apify público + propios → comentarios → IA por red → Panorama Opus
 *
 * Uso directo:
 *   node scripts/scraper/run-full-analysis.js <APIFY_TOKEN> <OPENROUTER_KEY> [--date=2026-07-01]
 *
 * También usado por analizar-server.js como módulo.
 */

import { createClient } from '@supabase/supabase-js';
import {
  normalizeSubjectConfig, relevanceMatcher, buildOrTerms, hashtagTerms,
  ownedUsernamesToExclude, loadSubjectConfigFromCli,
} from './subject-config.js';

// ─── Supabase ─────────────────────────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://aeywtloohrhyxvmxqzqe.supabase.co';
const SUPABASE_KEY =
  process.env.SUPABASE_SERVICE_KEY ||
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFleXd0bG9vaHJoeXh2bXhxenFlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODI4MzY2NzksImV4cCI6MjA5ODQxMjY3OX0.um2x046pEAJhlK6g98brVPFbc1nKFO8ixSUzmoU8dZw';
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ─── Helpers Apify ────────────────────────────────────────────────────────────
async function apifyRun(token, actorId, input, maxChargeUsd) {
  const encoded = actorId.replace('/', '~');
  const url = `https://api.apify.com/v2/acts/${encoded}/runs?token=${token}&waitForFinish=300&maxTotalChargeUsd=${maxChargeUsd}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`Apify ${actorId} → ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.data || data;
}

async function apifyDataset(token, datasetId, limit = 300) {
  const url = `https://api.apify.com/v2/datasets/${datasetId}/items?token=${token}&limit=${limit}&clean=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Dataset ${datasetId} → ${res.status}`);
  return res.json();
}

async function runActor(token, actorId, input, maxCharge, label) {
  const run = await apifyRun(token, actorId, input, maxCharge);
  const items = await apifyDataset(token, run.defaultDatasetId);
  return items;
}

const nextDay  = d => { const dt = new Date(d+'T12:00:00Z'); dt.setDate(dt.getDate()+1); return dt.toISOString().slice(0,10); };
const daysAgo  = (d, n) => { const dt = new Date(d+'T12:00:00Z'); dt.setDate(dt.getDate()-n); return dt.toISOString().slice(0,10); };
const inDate   = (dateStr, from, to) => { if (!dateStr) return true; const d = dateStr.slice(0,10); return d >= from && d < to; };

// ─── Supabase helpers ─────────────────────────────────────────────────────────
async function upsertReport(themeKey, themeLabel, dateKey, subjectConfig) {
  // La fila de "reports" para (fecha, tema) debe ser única POR SUJETO — si no, dos sujetos
  // distintos scrapeados el mismo día terminan compartiendo report_id y pisándose el subject_config.
  let q = supabase.from('reports').select('id').eq('date_key', dateKey).eq('theme_key', themeKey);
  if (subjectConfig?.subjectName) q = q.eq('subject_config->>subjectName', subjectConfig.subjectName);
  const { data: ex } = await q.limit(1);
  if (ex?.length) {
    return ex[0].id;
  }
  const base = { date_key: dateKey, theme_key: themeKey, theme_label: themeLabel, filename: `apify-${themeKey}-${dateKey}` };
  const { data, error } = await supabase.from('reports')
    .insert(subjectConfig ? { ...base, subject_config: subjectConfig } : base)
    .select('id').single();
  if (error) {
    // Si el insert con subject_config falla, NO caemos en silencio a insertar sin ella —
    // eso deja subject_config en null y hace que toda lectura filtrada por sujeto (hasScraped,
    // fetchWindowPosts) devuelva vacío para siempre, sin ningún error visible hasta mucho después
    // ("0 piezas candidatas" sin explicación). Mejor fallar aquí mismo con un mensaje claro.
    if (subjectConfig && /subject_config/i.test(error.message)) {
      throw new Error(
        `No se pudo guardar subject_config en "reports" (${error.message}). ` +
        `A este Supabase le falta la columna: corre "alter table reports add column if not exists subject_config jsonb;" antes de reintentar.`
      );
    }
    throw new Error(error.message);
  }
  return data.id;
}

async function insertPosts(reportId, themeKey, posts) {
  if (!posts.length) return [];
  const rows = posts.map(p => ({ ...p, report_id: reportId, theme_key: themeKey, sentiment: null }));
  const { data, error } = await supabase.from('scraped_posts').insert(rows).select('id, url, likes, comments_count');
  if (error) throw new Error(error.message);
  return data || [];
}

async function insertComments(postId, comments) {
  if (!comments.length) return;
  const rows = comments.map(c => ({ ...c, post_id: postId }));
  const { error } = await supabase.from('scraped_comments').insert(rows);
  if (error) throw new Error(error.message);
}

// ─── Normalizadores ───────────────────────────────────────────────────────────
const normX = (items, from, to, isRelevant) => items.map(p => ({
  platform:'x', username: p.author?.userName || p.user?.screen_name || '',
  text: p.full_text || p.text || '', url: p.permalink || p.url || '',
  published_date: p.created_at || p.createdAt || null,
  likes: +( p.likeCount || p.likes || 0), comments_count: +(p.replyCount || p.comments || 0),
  retweets: +(p.retweetCount || p.retweets || 0), views: +(p.viewCount || p.views || 0), shares: 0,
})).filter(p => p.text && p.url && inDate(p.published_date, from, to) && isRelevant(p.text));

const normFacebook = (items, from, to, isRelevant) => items.map(p => {
  const rx = +(p.reactions_count || p.reactionsCount || 0);
  return {
    platform:'facebook', username: p.author?.name || p.authorName || '',
    text: p.message || p.text || '', url: p.url || p.postUrl || '',
    published_date: p.date || p.publishedAt || null,
    likes: rx || +(p.like || p.likes || 0),
    comments_count: +(p.comments_count || p.commentsCount || 0),
    shares: +(p.reshare_count || p.shares || 0), retweets:0, views:0,
  };
}).filter(p => p.text && p.url && inDate(p.published_date, from, to) && isRelevant(p.text));

const normInstagram = (items, from, to, isRelevant) => items.map(p => {
  const code = p.code || p.shortCode || '';
  return {
    platform:'instagram', username: p.owner?.username || p.ownerUsername || p.username || '',
    text: p.caption || p.text || '', url: p.url || p.postUrl || (code ? `https://www.instagram.com/p/${code}/` : ''),
    published_date: p.createdAt || p.taken_at_date || p.timestamp || null,
    likes: +(p.likeCount || p.likesCount || 0), comments_count: +(p.commentCount || p.commentsCount || 0),
    views: +(p.video?.playCount || p.videoPlayCount || 0), shares:0, retweets:0,
  };
}).filter(p => p.text && p.url && inDate(p.published_date, from, to) && isRelevant(p.text + p.username));

const normTikTok = (items, from, to, isRelevant) => items.map(p => ({
  platform:'tiktok', username: p.author || p.nickname || p.authorMeta?.name || '',
  text: p.desc || p.description || '', url: p.url || p.webVideoUrl || '',
  published_date: p.createTimeISO || p.createdAt || (p.createTime ? new Date(p.createTime*1000).toISOString() : null),
  likes: +(p.diggCount || p.likes || 0), comments_count: +(p.commentCount || p.comments || 0),
  shares: +(p.shareCount || 0), views: +(p.playCount || p.plays || 0), retweets:0,
  followers: +(p.followers || p.authorMeta?.fans || 0),
  _subs: p.videoMeta?.subtitleLinks || p.subtitleLinks || null,
})).filter(p => p.text && p.url && inDate(p.published_date, from, to) && isRelevant(p.text + p.username));

const normGoogleNews = (items, from, to, isRelevantNews) => items.map(p => ({
  platform:'google_news', username: p.source || p.sourceDomain || '',
  text: p.title || '', url: p.articleUrl || p.link || '',
  published_date: p.publishedAt || p.date || null,
  likes:0, comments_count:0, shares:0, retweets:0, views:0,
})).filter(p => p.text && p.url && inDate(p.published_date, from, to) && isRelevantNews(p.text));

// Owned normalizers — sin filtro de fecha, últimos 5 posts del perfil
const normOwnedInstagram = (items, ownedAccounts) => {
  const posts = items.flatMap(profile => (profile.latestPosts || []));
  return posts.slice(0, 5).map(p => ({
    platform:'instagram', username: items[0]?.username || ownedAccounts.instagram || '',
    text: p.caption || p.alt || '', url: p.url || '',
    published_date: p.timestamp || p.taken_at_date || null,
    likes: +(p.likesCount || p.likeCount || 0), comments_count: +(p.commentsCount || p.commentCount || 0),
    views: +(p.videoViewCount || 0), shares:0, retweets:0,
  })).filter(p => p.url);
};

const normOwnedFacebook = (items, subjectName) => items.slice(0, 5).map(p => ({
  platform:'facebook', username: p.authorName || subjectName,
  text: p.text || p.message || '', url: p.permalink || p.url || '',
  published_date: p.publishTimeIso || p.date || null,
  likes: +(p.reactionCount || p.reactionsCount || 0),
  comments_count: +(p.commentCount || 0), shares:0, retweets:0, views:0,
})).filter(p => p.url);

const normOwnedTikTok = (items, ownedAccounts) => items
  .filter(p => !p.isPinned)
  .slice(0, 5)
  .map(p => ({
    platform:'tiktok', username: p.authorMeta?.name || ownedAccounts.tiktok || '',
    text: p.text || p.desc || '', url: p.webVideoUrl || '',
    published_date: p.createTimeISO || (p.createTime ? new Date(p.createTime*1000).toISOString() : null),
    likes: +(p.diggCount || 0), comments_count: +(p.commentCount || 0),
    shares: +(p.shareCount || 0), views: +(p.playCount || 0), retweets:0,
    _subs: p.videoMeta?.subtitleLinks || p.subtitleLinks || null,
  })).filter(p => p.url);

// Descarga los subtitulos automaticos de TikTok (WebVTT, gratis) y los anexa al texto del post.
// Solo los top N por views para no alargar la corrida.
async function attachTikTokTranscripts(posts, maxVideos = 10) {
  const candidates = posts.filter(p => Array.isArray(p._subs) && p._subs.length)
    .sort((a,b) => (b.views||0) - (a.views||0))
    .slice(0, maxVideos);
  for (const p of candidates) {
    try {
      const sub = p._subs.find(s => /^(es|spa)/i.test(s.language || s.lang || s.languageCode || ''))
        || p._subs.find(s => /^(en|eng)/i.test(s.language || s.lang || s.languageCode || ''))
        || p._subs[0];
      const vttUrl = sub?.downloadLink || sub?.url || (typeof sub === 'string' ? sub : null);
      if (!vttUrl) continue;
      const res = await fetch(vttUrl);
      if (!res.ok) continue;
      const vtt = await res.text();
      const text = vtt
        .replace(/^WEBVTT[^\n]*\n/,'')
        .replace(/^\d+\s*$/gm,'')
        .replace(/\d{2}:\d{2}[:.,\d]*\s*-->\s*[\d:.,]+[^\n]*/g,'')
        .replace(/<[^>]+>/g,'')
        .split('\n').map(l => l.trim()).filter(Boolean)
        // Collapse consecutive duplicate lines (VTT repeats them)
        .filter((l, i, arr) => l !== arr[i-1])
        .join(' ')
        .replace(/\s+/g,' ').trim();
      if (text) p.text = `${p.text}\n[TRANSCRIPCION DEL VIDEO]: ${text.slice(0, 900)}`;
    } catch { /* transcript is best-effort */ }
  }
  posts.forEach(p => { delete p._subs; });
  return posts;
}

const normOwnedX = (items, ownedAccounts) => {
  const xHandle = (ownedAccounts.x || '').split('/').filter(Boolean).pop() || '';
  return items.slice(0, 5).map(p => ({
    platform:'x', username: p.author?.screenName || xHandle,
    text: p.postText || p.text || p.full_text || '',
    url: p.postUrl || p.url || p.permalink || '',
    published_date: p.timestamp ? new Date(p.timestamp).toISOString() : (p.created_at || p.createdAt || null),
    likes: +(p.favouriteCount || p.likeCount || p.likes || 0),
    comments_count: +(p.replyCount || p.replies || 0),
    retweets: +(p.repostCount || p.retweetCount || p.retweets || 0),
    views: +(p.viewCount || p.views || 0), shares:0,
  })).filter(p => p.url);
};

async function fetchYouTubeRSS(ownedAccounts, subjectName) {
  if (!ownedAccounts.youtubeChannelId) return [];
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${ownedAccounts.youtubeChannelId}`;
  const res = await fetch(feedUrl);
  const xml = await res.text();
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1]);
  return entries.slice(0, 5).map(e => {
    const videoId = (e.match(/<yt:videoId>(.*?)<\/yt:videoId>/) || [])[1] || '';
    const title   = (e.match(/<title>(.*?)<\/title>/)           || [])[1] || '';
    const pub     = (e.match(/<published>(.*?)<\/published>/)    || [])[1] || '';
    return {
      platform:'youtube', username: subjectName,
      text: title, url: `https://www.youtube.com/watch?v=${videoId}`,
      published_date: pub, likes:0, comments_count:0, shares:0, retweets:0, views:0,
    };
  }).filter(p => p.url && p.text);
}

// ─── Comment normalizers ──────────────────────────────────────────────────────
const normCommentIG = items => items.map(c => ({
  text: c.text || c.ownerText || '', author: c.ownerUsername || c.owner?.username || '',
  published_time: c.timestamp || null, likes: +(c.likesCount || 0), replies:0, url: c.url || '',
})).filter(c => c.text);

const normCommentFB = items => items.map(c => ({
  text: c.text || '', author: c.profileName || c.authorName || '',
  published_time: c.date || null, likes: +(c.likesCount || 0), replies:0, url: c.commentUrl || '',
})).filter(c => c.text);

const normCommentTT = items => items.map(c => ({
  text: c.text || '', author: c.uniqueId || c.user?.uniqueId || '',
  published_time: c.createTimeISO || null, likes: +(c.diggCount || 0),
  replies: +(c.replyCommentTotal || 0), url: '',
})).filter(c => c.text);

const normCommentYT = items => items.map(c => ({
  text: c.text || c.commentText || '', author: c.authorText || c.author || '',
  published_time: null, likes: +(c.voteCount || c.likeCount || 0), replies: +(c.replyCount || 0), url: c.commentUrl || '',
})).filter(c => c.text);

const normCommentX = items => items.map(c => ({
  text: c.replyText || c.text || '', author: c.author?.userName || '',
  published_time: c.created_at || c.createdAt || null, likes: +(c.likeCount || c.likes || 0),
  replies: +(c.replyCount || 0), url: c.replyUrl || c.url || '',
})).filter(c => c.text);

// ─── AI analysis helpers ──────────────────────────────────────────────────────
function truncate(text, max = 420) {
  const clean = String(text||'').replace(/\s+/g,' ').trim();
  return clean.length > max ? clean.slice(0, max)+'...' : clean;
}

function buildDataPrompt({ report, posts, comments, previousAnalysis }) {
  let out = `DATOS EXTRAIDOS PARA ANALISIS — ${report.theme_key} / ${report.date_key}\n\n`;
  if (previousAnalysis) {
    out += `--- ANALISIS DEL PERIODO ANTERIOR (${previousAnalysis.date_key}) PARA COMPARAR TENDENCIA ---\n`;
    const ps = previousAnalysis.ai_analysis?.sentimiento || {};
    out += `Sentimiento anterior: favorable ${ps.favorable ?? '?'}% / neutral ${ps.neutral ?? '?'}% / critico ${ps.critico ?? '?'}%\n`;
    out += `Riesgo anterior: ${previousAnalysis.ai_analysis?.nivel_riesgo || 'desconocido'}\n`;
    const prevAlertas = previousAnalysis.ai_analysis?.alertas || [];
    if (prevAlertas.length) {
      out += `Alertas anteriores (verifica si siguen activas o se resolvieron):\n`;
      prevAlertas.slice(0,5).forEach(a => { out += `  - ${typeof a === 'string' ? a : (a.text || a.alerta || '')}\n`; });
    }
    out += `\n`;
  }
  out += `--- PUBLICACIONES (${posts.length}) ---\n`;
  posts.forEach((p, i) => {
    out += `${i+1}. [${p.platform}] @${p.username} | ${p.published_date?.slice(0,10)} | likes:${p.likes} comentarios:${p.comments_count} views:${p.views} | "${truncate(p.text)}" | ${p.url}\n`;
  });
  if (comments.length) {
    // Muestra representativa: los más gustados primero (no todos, para no inflar el prompt)
    const sample = [...comments].sort((a,b) => (b.likes||0)-(a.likes||0)).slice(0, 40);
    out += `\n--- MUESTRA DE COMENTARIOS (${sample.length} de ${comments.length}, ordenados por likes) ---\n`;
    sample.forEach((c,i) => {
      out += `${i+1}. @${c.author} | likes:${c.likes} | "${truncate(c.text, 300)}"\n`;
    });
  }
  return out;
}

// Panorama: consolida los resultados YA analizados por red (no re-analiza comentarios crudos)
function buildResumenPrompt({ networkResults, previousAnalysis }) {
  const asList = x => Array.isArray(x) ? x : (x ? [x] : []);
  let out = `RESULTADOS DE ANALISIS POR RED (ya procesados por la IA de cada red). Tu trabajo: CONSOLIDAR un panorama global a partir de estos resultados. NO tienes comentarios crudos y no los necesitas; confía en estos análisis.\n\n`;
  if (previousAnalysis) {
    const ps = previousAnalysis.ai_analysis?.sentimiento || {};
    out += `--- PERIODO ANTERIOR (${previousAnalysis.date_key}) PARA COMPARAR ---\n`;
    out += `Sentimiento anterior: favorable ${ps.favorable ?? '?'}% / neutral ${ps.neutral ?? '?'}% / critico ${ps.critico ?? '?'}%. Riesgo: ${previousAnalysis.ai_analysis?.nivel_riesgo || '?'}.\n`;
    asList(previousAnalysis.ai_analysis?.alertas).slice(0,5).forEach(a => { out += `  Alerta previa: ${typeof a === 'string' ? a : (a.text||a.alerta||'')}\n`; });
    out += `\n`;
  }
  for (const { theme, ai } of networkResults) {
    if (!ai) continue;
    const s = ai.sentimiento || {};
    out += `## ${theme.toUpperCase()} — favorable ${s.favorable ?? '?'}% / neutral ${s.neutral ?? '?'}% / critico ${s.critico ?? '?'}%. Riesgo: ${ai.nivel_riesgo || '?'}.\n`;
    asList(ai.resumen_ejecutivo).forEach(p => { out += `  · ${p}\n`; });
    const lect = ai.desglose_por_red?.[theme]?.lectura;
    if (lect) out += `  Lectura: ${lect}\n`;
    asList(ai.alertas).slice(0,4).forEach(a => { out += `  Alerta: ${typeof a === 'string' ? a : (a.text||a.alerta||'')}\n`; });
    asList(ai.oportunidades).slice(0,3).forEach(o => { out += `  Oportunidad: ${o}\n`; });
    const al = asList(ai.analisis_voces?.aliados_destacados).slice(0,5).map(v => v.username).filter(Boolean);
    const cr = asList(ai.analisis_voces?.criticos_destacados).slice(0,5).map(v => v.username).filter(Boolean);
    const md = asList(ai.analisis_voces?.medios_destacados).map(m => m.nombre).filter(Boolean);
    if (al.length) out += `  Aliados: ${al.join(', ')}\n`;
    if (cr.length) out += `  Contrarios: ${cr.join(', ')}\n`;
    if (md.length) out += `  Medios: ${md.join(', ')}\n`;
    out += `\n`;
  }
  return out;
}

const GENERIC_AI_PROMPT_SYSTEM = 'Eres un analista senior de reputacion y crisis. Responde solo JSON valido, sin markdown.';
const buildAIPromptSystem = (subjectName) =>
  `Eres un analista senior de reputacion y crisis para ${subjectName}. Responde solo JSON valido, sin markdown.`;

const AI_PROMPT_TEMPLATE = (dataPrompt, subjectConfig) => `Analiza los datos y devuelve SOLO JSON con esta estructura exacta.
ATENCION: los numeros de abajo son marcadores de posicion ("__CALCULA__"). DEBES reemplazarlos contando los posts/comentarios reales de los datos. Si entregas 15/68/17 o cualquier numero del ejemplo sin haberlo calculado, la respuesta es invalida.
{
  "resumen_ejecutivo": ["punto 1","punto 2","punto 3","punto 4"],
  "sentimiento": {"favorable":"__CALCULA__","neutral":"__CALCULA__","critico":"__CALCULA__"},
  "nivel_riesgo": "bajo|medio|alto|muy_alto (segun los datos)",
  "desglose_por_red": {
    "facebook":{"sentimiento":{"favorable":"__CALCULA__","neutral":"__CALCULA__","critico":"__CALCULA__"},"lectura":"2-3 frases: que pasa en esta red, quien mueve la conversacion, con ejemplos concretos de los datos","focos":["narrativa concreta detectada"],"recomendacion":"accion especifica para ESTA red","tendencia":"mejorando | estable | empeorando"}
  },
  "comparativa_historica": {
    "resumen": "2-3 frases de como evoluciono vs el periodo anterior (solo si se dio analisis anterior; si no, omite este campo)",
    "delta_favorable": 5,
    "delta_critico": -3,
    "alertas_resueltas": ["alerta anterior que ya no aparece"],
    "alertas_persistentes": ["alerta que sigue activa"]
  },
  "alertas": ["alerta 1"],
  "plan_accion": ["accion 1"],
  "oportunidades": ["oportunidad 1"],
  "analisis_voces": {
    "aliados_destacados": [{"username":"","platform":"","comentario_o_post":"","impacto":"Alto","tier":"micro","keywords":[],"followers":0,"likes":0,"engagement":0}],
    "criticos_destacados": [{"username":"","platform":"","comentario_o_post":"","impacto":"Medio","tier":"micro","keywords":[],"followers":0,"likes":0,"engagement":0}],
    "medios_destacados": [{"nombre":"El Heraldo de Mexico","dominio":"heraldodemexico.com.mx","platform":"google_news","alcance":"macro","notas":7,"tono":"neutral","temas":["cobertura Mundial","Nodal-Angela"],"titular_ejemplo":"titular real de una de sus notas"}]
  }
}

Reglas duras:
- No inventes datos. Aliados/criticos deben existir en los datos. Los porcentajes suman 100.
- NO incluyas las cuentas propias de ${subjectConfig.subjectName} (${ownedUsernamesToExclude(subjectConfig).join(', ') || 'sin cuentas registradas'}) ni a él/ella mismo/a como aliado o contrario: es el sujeto del análisis, no una voz externa.
- SE ESPECIFICO SIEMPRE: cada punto del resumen_ejecutivo, cada alerta y cada oportunidad debe decir QUIEN (autor con @ o nombre del medio), DONDE (en que red), CUANDO (fecha) y CUANTO (numeros reales: likes, comentarios, views, cantidad de notas o posts). Prohibido lo ambiguo tipo "se confirma X" o "hay criticas" sin decir quien lo publico, en que red y con que engagement. Ejemplo MAL: "Se confirma la realizacion de conciertos en Colombia". Ejemplo BIEN: "El Heraldo de Mexico publico el 1 jul la confirmacion de conciertos en Neiva, Colombia; la nota fue replicada en 3 medios mas y el post de @radioformula en X junto 5,839 likes".
- CUANDO HAYA COMENTARIOS EXTRAIDOS: cita 1-2 comentarios textualmente (entre comillas, breves) que representen lo que dijo la gente, para no quedarte solo en la metrica. Ejemplo: "el post junto 450k likes; los comentarios celebran ('por fin unidos como familia') aunque algunos critican ('puro show mediatico')". Prioriza citar comentarios reales por encima de generalizar.
- LOS NUMEROS DEL EJEMPLO SON ILUSTRATIVOS. NO los copies. Calcula los porcentajes REALES: cuenta cuantos posts/comentarios son favorables, neutrales y criticos en los datos y convierte a porcentaje. Muestra tu conteo en la lectura (ej: "de 45 comentarios, 12 favorables, 8 criticos").
- NUNCA uses 0/100/0 como fallback. Si una red no tiene muestra suficiente para clasificar, OMITELA del desglose_por_red. Solo incluye redes con evidencia real.
- La lectura de cada red debe citar evidencia concreta (autores, temas, numeros), no generalidades.
- medios_destacados es EXCLUSIVAMENTE para fuentes de prensa de google_news (notas de prensa). NO pongas ahi cuentas de Instagram/Facebook/X/TikTok aunque sean paginas de medios o espectaculos — esas van en aliados_destacados o criticos_destacados segun su tono. Incluye toda fuente de google_news con al menos 1 nota: nombre, dominio web del medio (ej "heraldodemexico.com.mx" — deducelo de la URL de la nota si esta en los datos), platform "google_news", alcance ("macro" nacional, "medio" regional), cuantas notas, tono y temas.
- Si se dio analisis del periodo anterior, calcula tendencia por red y llena comparativa_historica con deltas reales. Si no, omite comparativa_historica y usa "estable".

${dataPrompt}`;

export async function callAI(apiKey, prompt, models, systemPrompt = GENERIC_AI_PROMPT_SYSTEM) {
  for (const model of models) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/BrandonBlackwell-ui/DashboardPP',
        'X-Title': 'Blackwell Dashboard',
      },
      body: JSON.stringify({
        model, response_format: { type: 'json_object' },
        messages: [
          { role:'system', content: systemPrompt },
          { role:'user', content: prompt },
        ],
      }),
    });
    const json = await res.json();
    if (json.error) { console.warn(`${model} falló: ${json.error.message}`); continue; }
    const text = json.choices?.[0]?.message?.content;
    if (!text) continue;
    const start = text.indexOf('{'); const end = text.lastIndexOf('}');
    if (start === -1 || end === -1) continue;
    try { return { model, analysis: JSON.parse(text.slice(start, end+1)) }; }
    catch { continue; }
  }
  throw new Error('Todos los modelos AI fallaron');
}

async function enrichAndSaveAI(apiKey, themeKey, dateKey, allPostsByTheme, subjectConfig) {
  const { data: rep } = await supabase.from('reports').select('id,theme_key,date_key').eq('date_key', dateKey).eq('theme_key', themeKey).limit(1);
  if (!rep?.length) return null;
  const report = rep[0];

  const models = themeKey === 'resumen'
    ? ['z-ai/glm-5.2', 'anthropic/claude-sonnet-5', 'google/gemini-2.5-flash']
    : ['z-ai/glm-5.2', 'google/gemini-2.5-flash-lite', 'google/gemini-2.5-flash'];

  // Análisis del período anterior → deja calcular tendencia real
  let previousAnalysis = null;
  {
    const { data: prev } = await supabase.from('reports')
      .select('date_key, ai_analysis')
      .eq('theme_key', themeKey)
      .lt('date_key', dateKey)
      .not('ai_analysis', 'is', null)
      .order('date_key', { ascending: false })
      .limit(1);
    if (prev?.length) previousAnalysis = prev[0];
  }

  let posts = [];
  let prompt;

  if (themeKey === 'resumen') {
    // Panorama: consolida los resultados YA analizados por red (no re-lee comentarios crudos)
    const { data: netReps } = await supabase.from('reports')
      .select('theme_key, ai_analysis')
      .eq('date_key', dateKey)
      .neq('theme_key', 'resumen')
      .not('ai_analysis', 'is', null);
    const networkResults = (netReps || [])
      .map(r => ({ theme: r.theme_key, ai: r.ai_analysis }))
      .filter(r => r.ai);
    // Posts (sin comentarios) solo para enriquecer métricas de voces
    const { data: allReps } = await supabase.from('reports').select('id').eq('date_key', dateKey).neq('theme_key', 'resumen');
    const allRepIds = (allReps || []).map(r => r.id);
    if (allRepIds.length) {
      const { data: allPostRecs } = await supabase.from('scraped_posts')
        .select('platform,username,text,url,published_date,likes,comments_count,views,followers')
        .in('report_id', allRepIds);
      posts = allPostRecs || [];
    }
    prompt = AI_PROMPT_TEMPLATE(buildResumenPrompt({ networkResults, previousAnalysis }), subjectConfig);
  } else {
    // Red individual: posts + muestra de comentarios crudos
    posts = allPostsByTheme[themeKey] || [];
    const { data: postRecs } = await supabase.from('scraped_posts')
      .select('id,platform,username,text,url,published_date,likes,comments_count,views,followers')
      .eq('report_id', report.id);
    const postIds = (postRecs || []).map(p => p.id);
    if (!posts.length && postRecs?.length) posts = postRecs;
    let comments = [];
    if (postIds.length) {
      const { data: cmts } = await supabase.from('scraped_comments').select('*').in('post_id', postIds);
      comments = cmts || [];
    }
    prompt = AI_PROMPT_TEMPLATE(buildDataPrompt({ report, posts, comments, previousAnalysis }), subjectConfig);
  }

  const { model, analysis } = await callAI(apiKey, prompt, models, buildAIPromptSystem(subjectConfig.subjectName));

  // Normaliza sentimiento a enteros (GLM a veces devuelve "33", "25%" o "37.5")
  const toInt = v => { const n = Math.round(parseFloat(String(v).replace(/[^0-9.-]/g, ''))); return Number.isFinite(n) ? n : 0; };
  const fixSent = s => {
    if (!s || typeof s !== 'object') return s;
    return { favorable: toInt(s.favorable), neutral: toInt(s.neutral), critico: toInt(s.critico) };
  };
  if (analysis.sentimiento) analysis.sentimiento = fixSent(analysis.sentimiento);
  if (analysis.desglose_por_red) {
    for (const k of Object.keys(analysis.desglose_por_red)) {
      const red = analysis.desglose_por_red[k];
      if (red?.sentimiento) red.sentimiento = fixSent(red.sentimiento);
    }
  }
  if (analysis.comparativa_historica) {
    analysis.comparativa_historica.delta_favorable = toInt(analysis.comparativa_historica.delta_favorable);
    analysis.comparativa_historica.delta_critico = toInt(analysis.comparativa_historica.delta_critico);
  }

  // Enrich voice metrics from real scraped data
  const metricsMap = {};
  posts.forEach(p => {
    const key = (p.username||'').toLowerCase().replace(/^@/,'');
    if (!key) return;
    if (!metricsMap[key]) metricsMap[key] = { likes:0, comments:0, views:0, followers:0, engagement:0 };
    metricsMap[key].likes    += +(p.likes||0);
    metricsMap[key].comments += +(p.comments_count||0);
    metricsMap[key].views    += +(p.views||0);
    metricsMap[key].followers = Math.max(metricsMap[key].followers, +(p.followers||0));
    metricsMap[key].engagement = metricsMap[key].likes + metricsMap[key].comments*2 + metricsMap[key].views*0.01;
  });
  const enrich = v => {
    const m = metricsMap[(v.username||'').toLowerCase().replace(/^@/,'')] || {};
    return { ...v, followers: m.followers||v.followers||0, likes: m.likes||v.likes||0, engagement: Math.round(m.engagement||v.engagement||0) };
  };
  if (analysis.analisis_voces?.aliados_destacados) analysis.analisis_voces.aliados_destacados = analysis.analisis_voces.aliados_destacados.map(enrich);
  if (analysis.analisis_voces?.criticos_destacados) analysis.analisis_voces.criticos_destacados = analysis.analisis_voces.criticos_destacados.map(enrich);

  // Nuevo análisis = borrador; el admin debe aprobarlo para que lo vea el cliente.
  // Resiliente por si la columna 'approved' aún no existe en Supabase.
  const { error: upErr } = await supabase.from('reports').update({ ai_analysis: analysis, approved: false }).eq('id', report.id);
  if (upErr) await supabase.from('reports').update({ ai_analysis: analysis }).eq('id', report.id);
  return { themeKey, model, sentimiento: analysis.sentimiento, nivel_riesgo: analysis.nivel_riesgo };
}

// ─── Exportable orchestrator ──────────────────────────────────────────────────
export async function runFullAnalysis({ apifyToken, aiKey, date, subjectConfig, emit = console.log }) {
  const cfg        = normalizeSubjectConfig(subjectConfig);
  const OWNED       = cfg.ownedAccounts;
  const isRelevant     = relevanceMatcher(cfg.keywords);
  const isRelevantNews = relevanceMatcher(cfg.newsKeywords);
  const DATE       = date || new Date().toISOString().slice(0,10);
  const DNEXT      = nextDay(DATE);
  const OWNED_FROM = daysAgo(DATE, 7); // propios: últimos 7 días

  const summary = { date: DATE, phases: {}, posts: {}, comments: {}, ai: {}, startedAt: new Date().toISOString() };
  const allSavedPosts = {}; // themeKey → array of saved post records {id, url, likes, comments_count}

  // ── FASE A: Todo Apify en paralelo ─────────────────────────────────────────
  emit({ type:'phase', phase:'A', msg:'Iniciando scraping en paralelo (público + propios)...' });

  const orTerms = buildOrTerms(cfg, 1);
  const orQuery = orTerms.map(t => `"${t}"`).join(' OR ');
  const hashKws = hashtagTerms(cfg, 3);
  const runOwned = (val, fn) => (val ? fn() : Promise.resolve([]));

  const [fbR, igR, xR, ttR, gnR, ownIgR, ownFbR, ownTtR, ownYtR, ownXR] = await Promise.allSettled([
    // Público
    runActor(apifyToken, 'igview-owner/facebook-old-posts-search',
      { query:orQuery, startDate:DATE, endDate:DATE, maxResults:50 }, 0.12, 'fb_search'),
    runActor(apifyToken, 'apidojo/instagram-hashtag-scraper',
      { keyword:hashKws[0], until:DATE, getPosts:true, getReels:false, maxItems:25 }, 0.05, 'ig_hash1').then(async r1 => {
        let all = [...r1];
        for (const kw of hashKws.slice(1)) {
          const r = await runActor(apifyToken, 'apidojo/instagram-hashtag-scraper',
            { keyword:kw, until:DATE, getPosts:true, getReels:false, maxItems:25 }, 0.05, 'ig_hash_extra');
          all = [...all, ...r];
        }
        return all;
      }),
    runActor(apifyToken, 'apidojo/tweet-scraper',
      { searchTerms:[`${orQuery} -filter:retweets -filter:replies since:${DATE} until:${DNEXT}`],
        sort:'Top', maxItems:100 }, 0.10, 'x_search'),
    runActor(apifyToken, 'sentry/tiktok-search-api',
      { keywords:orTerms, maxVideosPerKeyword:15, maxVideosTotal:30, sortOrder:'mostViews', datePosted:'today', includePhotoPosts:false }, 0.15, 'tt_search'),
    runActor(apifyToken, 'sourabhbgp/google-news-scraper',
      { urls:[`"${cfg.subjectName}"`], mode:'search', maxResults:20, dateFrom:DATE, dateTo:DATE, language:'es', country:'MX', includeFullText:false, fullCoverage:false }, 0.04, 'gn'),
    // Propios
    runOwned(OWNED.instagram, () => runActor(apifyToken, 'coderx/instagram-profile-scraper-api',
      { usernames:[OWNED.instagram] }, 0.03, 'own_ig')),
    runOwned(OWNED.facebook, () => runActor(apifyToken, 'unseenuser/fb-posts',
      { mode:'profile', sources:[OWNED.facebook], maxPosts:5, includeTopComments:false, fetchAllComments:false, fetchCommentReplies:false, enrichSinglePostFields:false }, 0.05, 'own_fb')),
    runOwned(OWNED.tiktok, () => runActor(apifyToken, 'clockworks/tiktok-profile-scraper',
      { profiles:[OWNED.tiktok], resultsPerPage:13, shouldDownloadCovers:false, shouldDownloadSlideshowImages:false, shouldDownloadSubtitles:false, shouldDownloadVideos:false }, 0.04, 'own_tt')),
    fetchYouTubeRSS(OWNED, cfg.subjectName),
    runOwned(OWNED.x, () => runActor(apifyToken, 'scraper_one/x-profile-posts-scraper',
      { profileUrls:[OWNED.x], resultsLimit:10, skipPinnedPosts:true }, 0.05, 'own_x')),
  ]);

  emit({ type:'phase_done', phase:'A', msg:'Scraping completado. Guardando en Supabase...' });

  // Normalizar y guardar — público
  const nets = [
    { key:'facebook',    result:fbR,  norm: items => normFacebook(items, DATE, DNEXT, isRelevant),       label:'Facebook',    cap:50  },
    { key:'instagram',   result:igR,  norm: items => normInstagram(items, DATE, DNEXT, isRelevant),      label:'Instagram',   cap:75  },
    { key:'x',           result:xR,   norm: items => normX(items, DATE, DNEXT, isRelevant),              label:'X',           cap:100 },
    { key:'tiktok',      result:ttR,  norm: items => normTikTok(items, DATE, DNEXT, isRelevant),         label:'TikTok',      cap:30  },
    { key:'google_news', result:gnR,  norm: items => normGoogleNews(items, DATE, DNEXT, isRelevantNews), label:'Google News', cap:20  },
  ];

  for (const { key, result, norm, label, cap } of nets) {
    if (result.status === 'rejected') {
      const errMsg = result.reason?.message || String(result.reason);
      summary.posts[key] = { error: errMsg };
      emit({ type:'error', msg: `${key}: ${errMsg}` });
      continue;
    }
    const rawCount = Array.isArray(result.value) ? result.value.length : 0;
    const posts = norm(result.value);
    if (key === 'tiktok') await attachTikTokTranscripts(posts);
    const truncated = cap && rawCount >= cap;
    summary.posts[key] = { count: posts.length, raw: rawCount, truncated };
    emit({ type:'saved', net:key, count:posts.length });
    if (truncated) {
      emit({ type:'warn', net:key, msg:`${label} llegó al tope de ${cap} resultados — probablemente hay más publicaciones de este día que no se extrajeron.` });
    }
    if (!posts.length) continue;
    const reportId = await upsertReport(key, label, DATE, cfg);
    const saved = await insertPosts(reportId, key, posts);
    allSavedPosts[key] = saved;
  }

  // Normalizar y guardar — propios
  const ownedNorms = [
    { key:'instagram', result:ownIgR, norm: items => normOwnedInstagram(items, OWNED) },
    { key:'facebook',  result:ownFbR, norm: items => normOwnedFacebook(items, cfg.subjectName) },
    { key:'tiktok',    result:ownTtR, norm: items => normOwnedTikTok(items, OWNED) },
    { key:'youtube',   result:ownYtR, norm: items => items }, // already normalized by fetchYouTubeRSS
    { key:'x',         result:ownXR,  norm: items => normOwnedX(items, OWNED) },
  ];

  const ownedPostsByPlatform = {};
  const reportIdOwned = await upsertReport('redes_propias', 'Redes Propias', DATE, cfg);

  for (const { key, result, norm } of ownedNorms) {
    if (result.status === 'rejected') {
      const errMsg = result.reason?.message || String(result.reason);
      summary.posts[`owned_${key}`] = { error: errMsg };
      emit({ type:'error', msg:`owned_${key}: ${errMsg}` });
      continue;
    }
    const rawCount = Array.isArray(result.value) ? result.value.length : 0;
    const posts = norm(result.value);
    if (key === 'tiktok') await attachTikTokTranscripts(posts);
    summary.posts[`owned_${key}`] = { count: posts.length, raw: rawCount };
    emit({ type:'saved', net:`owned_${key}`, count:posts.length });
    if (!posts.length) continue;
    const saved = await insertPosts(reportIdOwned, 'redes_propias', posts);
    ownedPostsByPlatform[key] = saved; // [{id, url, likes, comments_count}]
  }

  // ── FASE B: Comentarios propios en paralelo ───────────────────────────────
  emit({ type:'phase', phase:'B', msg:'Scraping comentarios de redes propias...' });

  const selectTopPosts = (posts, n=3) =>
    [...(posts||[])].sort((a,b) => (b.likes+b.comments_count*2) - (a.likes+a.comments_count*2)).slice(0, n);

  const commentJobs = [];

  // Filtra comentarios al día de análisis (para redes propias)
  const filterCommentsByDate = (comments, dateKey) =>
    comments.filter(c => !c.published_time || c.published_time.slice(0,10) === dateKey);

  const addCommentJob = (label, posts, actorId, inputFn, maxCharge, normFn, filterByDate = false) => {
    if (!posts.length) return;
    commentJobs.push(
      Promise.allSettled(posts.map(p =>
        runActor(apifyToken, actorId, inputFn(p), maxCharge, `cmnt_${label}`)
          .then(items => {
            let normed = normFn(items);
            if (filterByDate) normed = filterCommentsByDate(normed, DATE);
            emit({ type:'comments_scraped', net:label, url:p.url, count:normed.length });
            summary.comments[label] = (summary.comments[label] || 0) + normed.length;
            return insertComments(p.id, normed);
          })
          .catch(e => emit({ type:'error', msg:`cmnt_${label}: ${e.message}` }))
      ))
    );
  };

  const ownedIgPosts = selectTopPosts(ownedPostsByPlatform.instagram);
  const ownedFbPosts = selectTopPosts(ownedPostsByPlatform.facebook);
  const ownedTtPosts = selectTopPosts(ownedPostsByPlatform.tiktok);
  const ownedYtPosts = selectTopPosts(ownedPostsByPlatform.youtube);
  const ownedXPosts  = selectTopPosts(ownedPostsByPlatform.x);

  // Propios: solo comentarios de hoy (filterByDate = true)
  addCommentJob('owned_ig', ownedIgPosts, 'apify/instagram-comment-scraper',
    p => ({ directUrls:[p.url], resultsLimit:50, includeNestedComments:false }), 0.08, normCommentIG, true);

  addCommentJob('owned_fb', ownedFbPosts, 'apify/facebook-comments-scraper',
    p => ({ startUrls:[{url:p.url}], resultsLimit:50, includeNestedComments:false }), 0.05, normCommentFB, true);

  addCommentJob('owned_tt', ownedTtPosts, 'clockworks/tiktok-comments-scraper',
    p => ({ postURLs:[p.url], commentsPerPost:50, maxRepliesPerComment:0 }), 0.05, normCommentTT, true);

  // YouTube no devuelve fecha en comentarios — tomamos los 20 más recientes sin filtro
  addCommentJob('owned_yt', ownedYtPosts, 'apidojo/youtube-comments-scraper',
    p => ({ startUrls:[p.url], sort:'latest', maxItems:20, includeReplies:false }), 0.03, normCommentYT, false);

  addCommentJob('owned_x', ownedXPosts, 'scraper_one/x-post-replies-scraper',
    p => ({ postUrls:[p.url], maxItems:50 }), 0.05, normCommentX, true);

  // También: top posts de social listening por comentarios (FB, IG, TikTok)
  const selectTopByComments = (posts, n=3) =>
    [...(posts||[])].sort((a,b) => b.comments_count - a.comments_count).slice(0, n);

  // SL: top 3 por engagement (likes + comentarios×2), max 20 comentarios c/u
  const slFbPosts  = selectTopPosts(allSavedPosts.facebook);
  const slIgPosts  = selectTopPosts(allSavedPosts.instagram);
  const slTtPosts  = selectTopPosts(allSavedPosts.tiktok);
  const slXPosts   = selectTopPosts(allSavedPosts.x);

  // SL: sin filtro de fecha — queremos los 20 comentarios más recientes del post
  addCommentJob('sl_fb', slFbPosts, 'apify/facebook-comments-scraper',
    p => ({ startUrls:[{url:p.url}], resultsLimit:20, includeNestedComments:false }), 0.05, normCommentFB, false);

  addCommentJob('sl_ig', slIgPosts, 'apify/instagram-comment-scraper',
    p => ({ directUrls:[p.url], resultsLimit:20, includeNestedComments:false }), 0.08, normCommentIG, false);

  addCommentJob('sl_tt', slTtPosts, 'clockworks/tiktok-comments-scraper',
    p => ({ postURLs:[p.url], commentsPerPost:20, maxRepliesPerComment:0 }), 0.05, normCommentTT, false);

  addCommentJob('sl_x', slXPosts, 'scraper_one/x-post-replies-scraper',
    p => ({ postUrls:[p.url], maxItems:25 }), 0.05, normCommentX, false);

  await Promise.allSettled(commentJobs);
  emit({ type:'phase_done', phase:'B', msg:'Comentarios guardados (propios + social listening).' });

  // ── FASE C: AI por red en paralelo ────────────────────────────────────────
  // Se salta por completo si no se dio aiKey (ej. cuando esta corrida solo alimenta el
  // reporte de evento, que redacta el texto el agente y no necesita el panorama por red).
  if (aiKey) {
    emit({ type:'phase', phase:'C', msg:'Análisis IA por red (paralelo)...' });

    const aiNets = ['facebook','instagram','x','tiktok','google_news','redes_propias'];
    const aiResults = await Promise.allSettled(
      aiNets.map(net => enrichAndSaveAI(aiKey, net, DATE, allSavedPosts, cfg).then(r => { emit({ type:'ai_done', net, result:r }); return r; }))
    );

    aiResults.forEach((r, i) => {
      summary.ai[aiNets[i]] = r.status === 'fulfilled' ? r.value : { error: r.reason?.message };
    });
    emit({ type:'phase_done', phase:'C', msg:'Análisis IA por red completado.' });

    // ── FASE D: Panorama consolidado ─────────────────────────────────────────
    emit({ type:'phase', phase:'D', msg:'Panorama consolidado...' });
    try {
      // Ensure resumen report exists
      await upsertReport('resumen', 'Panorama Consolidado', DATE, cfg);
      const panorama = await enrichAndSaveAI(aiKey, 'resumen', DATE, allSavedPosts, cfg);
      summary.ai.resumen = panorama;
      emit({ type:'ai_done', net:'resumen', result:panorama });
    } catch(e) {
      summary.ai.resumen = { error: e.message };
      emit({ type:'error', phase:'D', msg:e.message });
    }
  } else {
    emit({ type:'info', msg:'Sin aiKey: se omiten las fases C/D (análisis IA por red y panorama). Solo se guardaron posts/comentarios crudos.' });
  }

  summary.finishedAt = new Date().toISOString();
  emit({ type:'done', summary });
  return summary;
}

// ─── Re-análisis IA sin scraping — usa los posts/comentarios ya guardados en Supabase ──
export async function runAIOnly({ aiKey, date, subjectConfig, emit = () => {} }) {
  const cfg = normalizeSubjectConfig(subjectConfig);
  const DATE = date || new Date().toISOString().slice(0, 10);
  const summary = { date: DATE, ai: {}, mode: 'ai-only', startedAt: new Date().toISOString() };

  emit({ type:'phase', phase:'C', msg:`Re-análisis IA con data existente del ${DATE} (sin Apify)...` });
  const aiNets = ['facebook','instagram','x','tiktok','google_news','redes_propias'];
  const results = await Promise.allSettled(
    aiNets.map(net => enrichAndSaveAI(aiKey, net, DATE, {}, cfg).then(r => { emit({ type:'ai_done', net, result:r }); return r; }))
  );
  results.forEach((r, i) => {
    summary.ai[aiNets[i]] = r.status === 'fulfilled' ? r.value : { error: r.reason?.message };
  });

  emit({ type:'phase', phase:'D', msg:'Panorama consolidado...' });
  try {
    await upsertReport('resumen', 'Panorama Consolidado', DATE, cfg);
    const panorama = await enrichAndSaveAI(aiKey, 'resumen', DATE, {}, cfg);
    summary.ai.resumen = panorama;
    emit({ type:'ai_done', net:'resumen', result:panorama });
  } catch(e) {
    summary.ai.resumen = { error: e.message };
    emit({ type:'error', phase:'D', msg:e.message });
  }

  summary.finishedAt = new Date().toISOString();
  emit({ type:'done', summary });
  return summary;
}

// ─── Scrape dirigido de TODOS los comentarios de URLs específicas (deep-dive) ──
// items: [{ platform:'instagram'|'tiktok'|'facebook', url }]. Devuelve todos los comentarios por pieza.
export async function scrapeCommentsForUrls({ apifyToken, items, limit = 300, emit = () => {} }) {
  const out = [];
  for (const { platform, url } of (items || [])) {
    try {
      let raw = [], comments = [];
      if (platform === 'instagram') {
        raw = await runActor(apifyToken, 'apify/instagram-comment-scraper',
          { directUrls:[url], resultsLimit:limit, includeNestedComments:false }, 0.30, 'dc_ig');
        comments = normCommentIG(raw);
      } else if (platform === 'tiktok') {
        raw = await runActor(apifyToken, 'clockworks/tiktok-comments-scraper',
          { postURLs:[url], commentsPerPost:limit, maxRepliesPerComment:0 }, 0.30, 'dc_tt');
        comments = normCommentTT(raw);
      } else if (platform === 'facebook') {
        raw = await runActor(apifyToken, 'apify/facebook-comments-scraper',
          { startUrls:[{ url }], resultsLimit:limit, includeNestedComments:false }, 0.25, 'dc_fb');
        comments = normCommentFB(raw);
      } else {
        throw new Error(`plataforma no soportada: ${platform}`);
      }
      comments.sort((a,b) => (b.likes||0) - (a.likes||0));
      emit({ type:'comments', platform, url, count: comments.length });
      out.push({ platform, url, count: comments.length, comments });
    } catch (e) {
      emit({ type:'error', platform, url, msg: e.message });
      out.push({ platform, url, error: e.message });
    }
  }
  return out;
}

// ─── CLI directo ──────────────────────────────────────────────────────────────
if (process.argv[1]?.endsWith('run-full-analysis.js')) {
  const args  = process.argv.slice(2);
  const apify = args.find(a => !a.startsWith('--'));
  const ai    = args.filter(a => !a.startsWith('--'))[1];
  const date  = args.find(a => a.startsWith('--date='))?.split('=')[1];

  if (!apify || !ai) {
    console.error(
      'Uso: node scripts/scraper/run-full-analysis.js <APIFY_TOKEN> <OPENROUTER_KEY> [--date=YYYY-MM-DD] ' +
      "--subject='{\"subjectName\":\"...\",\"keywords\":[...]}' (o --subject-file=/SUBJECT_CONFIG_JSON)"
    );
    process.exit(1);
  }

  const subjectConfig = loadSubjectConfigFromCli(args);

  const emit = ev => {
    if (ev.type === 'phase')      console.log(`\n▶ FASE ${ev.phase}: ${ev.msg}`);
    else if (ev.type === 'phase_done') console.log(`✓ ${ev.msg}`);
    else if (ev.type === 'saved') console.log(`  └ ${ev.net}: ${ev.count} posts guardados`);
    else if (ev.type === 'ai_done') console.log(`  └ AI ${ev.net}: ${ev.result?.sentimiento ? JSON.stringify(ev.result.sentimiento) : ev.result?.error}`);
    else if (ev.type === 'error') console.error(`  ✗ ${ev.msg}`);
    else if (ev.type === 'done')  console.log('\n═══ ANÁLISIS COMPLETO ═══\n', JSON.stringify(ev.summary, null, 2));
  };

  runFullAnalysis({ apifyToken: apify, aiKey: ai, date, subjectConfig, emit }).catch(e => { console.error(e); process.exit(1); });
}

/**
 * subject-config.js — Configuración dinámica del "sujeto" de monitoreo (nombre, keywords de
 * relevancia, cuentas propias y exclusiones), en vez de tenerlo fijo en cada script.
 *
 * Forma esperada:
 *   {
 *     subjectName: string,
 *     keywords: string[],
 *     newsKeywords?: string[],       // opcional, más estricto para Google News. Si falta, usa keywords.
 *     ownedAccounts?: { instagram?, tiktok?, x?, facebook?, youtubeChannelId? },
 *     excludeUsernames?: string[],   // cuentas propias extra a excluir de aliados/críticos en IA
 *   }
 */
import fs from 'fs';

export function normalizeSubjectConfig(input) {
  const cfg = input && typeof input === 'object' ? input : {};
  const subjectName = String(cfg.subjectName || '').trim();
  const keywords = Array.isArray(cfg.keywords) ? cfg.keywords.map(k => String(k).trim()).filter(Boolean) : [];
  if (!subjectName) throw new Error('subjectConfig inválido: falta subjectName.');
  if (!keywords.length) throw new Error('subjectConfig inválido: se requiere al menos un keyword.');

  const newsKeywords = Array.isArray(cfg.newsKeywords) && cfg.newsKeywords.length
    ? cfg.newsKeywords.map(k => String(k).trim()).filter(Boolean)
    : keywords;

  const rawOwned = cfg.ownedAccounts && typeof cfg.ownedAccounts === 'object' ? cfg.ownedAccounts : {};
  const ownedAccounts = {
    instagram: rawOwned.instagram ? String(rawOwned.instagram).trim() : '',
    tiktok: rawOwned.tiktok ? String(rawOwned.tiktok).trim() : '',
    x: rawOwned.x ? String(rawOwned.x).trim() : '',
    facebook: rawOwned.facebook ? String(rawOwned.facebook).trim() : '',
    youtubeChannelId: rawOwned.youtubeChannelId ? String(rawOwned.youtubeChannelId).trim() : '',
  };

  const excludeUsernames = Array.isArray(cfg.excludeUsernames)
    ? cfg.excludeUsernames.map(u => String(u).trim()).filter(Boolean)
    : [];

  return { subjectName, keywords, newsKeywords, ownedAccounts, excludeUsernames };
}

// Matcher de relevancia: true si el texto contiene alguno de los keywords (case-insensitive).
export function relevanceMatcher(keywords) {
  const kws = (keywords || []).map(k => k.toLowerCase()).filter(Boolean);
  return (text) => {
    const t = (text || '').toLowerCase();
    return kws.some(k => t.includes(k));
  };
}

export function slugKeyword(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Términos para queries tipo "OR" (búsquedas de texto libre en Facebook/X/TikTok).
// Devuelve [subjectName, ...hasta extraCount keywords distintos del nombre].
export function buildOrTerms({ subjectName, keywords = [] }, extraCount = 2) {
  const seen = new Set([subjectName.toLowerCase()]);
  const extras = [];
  for (const k of keywords) {
    const norm = k.trim();
    if (!norm || seen.has(norm.toLowerCase())) continue;
    seen.add(norm.toLowerCase());
    extras.push(norm);
    if (extras.length >= extraCount) break;
  }
  return [subjectName, ...extras];
}

// Términos tipo hashtag/handle (sin espacios ni acentos) para scrapers de hashtag/keyword.
export function hashtagTerms({ subjectName, keywords = [] }, max = 3) {
  const seen = new Set();
  const out = [];
  for (const k of [subjectName, ...keywords]) {
    const s = slugKeyword(k);
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

// Lista (lowercase, sin @) de cuentas propias + nombre del sujeto + exclusiones manuales,
// usada para no confundir al sujeto/sus propias cuentas con aliados o críticos.
export function ownedUsernamesToExclude(cfg) {
  const { ownedAccounts = {}, excludeUsernames = [], subjectName } = cfg;
  const xHandle = (ownedAccounts.x || '').split('/').filter(Boolean).pop() || '';
  return [...new Set([
    ownedAccounts.instagram, ownedAccounts.tiktok, ownedAccounts.facebook, xHandle,
    subjectName, ...(excludeUsernames || []),
  ].filter(Boolean).map(s => String(s).trim().toLowerCase().replace(/^@/, '')))];
}

// Carga subjectConfig para scripts CLI: --subject='<json>', --subject-file=ruta.json o SUBJECT_CONFIG_JSON.
export function loadSubjectConfigFromCli(args, { required = true } = {}) {
  const inline = args.find(a => a.startsWith('--subject='));
  const file = args.find(a => a.startsWith('--subject-file='))?.split('=')[1];
  let raw = null;
  if (inline) raw = inline.slice('--subject='.length);
  else if (file) raw = fs.readFileSync(file, 'utf8');
  else if (process.env.SUBJECT_CONFIG_JSON) raw = process.env.SUBJECT_CONFIG_JSON;

  if (!raw) {
    if (required) {
      throw new Error(
        "Falta configuración de sujeto. Pasa --subject='{\"subjectName\":\"...\",\"keywords\":[...]}', " +
        '--subject-file=ruta.json o la variable de entorno SUBJECT_CONFIG_JSON.'
      );
    }
    return null;
  }
  return normalizeSubjectConfig(JSON.parse(raw));
}

// Resuelve subjectConfig para los endpoints HTTP: usa el parámetro recibido, o si falta,
// reutiliza el último guardado en Supabase (reports.subject_config) para esa fecha o en general.
// Así un análisis puede repetirse (/reanalizar, /reporte-evento) sin volver a escribir la config.
export async function resolveSubjectConfig({ supabase, raw, dateKey }) {
  if (raw) return normalizeSubjectConfig(JSON.parse(raw));

  if (supabase && dateKey) {
    const { data } = await supabase
      .from('reports').select('subject_config')
      .eq('date_key', dateKey).not('subject_config', 'is', null)
      .order('created_at', { ascending: false }).limit(1);
    if (data?.length && data[0].subject_config) return normalizeSubjectConfig(data[0].subject_config);
  }

  if (supabase) {
    const { data } = await supabase
      .from('reports').select('subject_config')
      .not('subject_config', 'is', null)
      .order('created_at', { ascending: false }).limit(1);
    if (data?.length && data[0].subject_config) return normalizeSubjectConfig(data[0].subject_config);
  }

  throw new Error('Falta la configuración de sujeto (?subject=<json>) y no hay una configuración previa guardada para reutilizar.');
}

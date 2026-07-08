/**
 * report-docx.js — Genera el .docx de "Reporte de evento" (diseño Blackwell) a partir
 * de un objeto de datos (lo produce la IA). Incrusta las fuentes de marca con JSZip
 * para que se vea idéntico en cualquier equipo. Corre en Node (Railway/Linux).
 *
 *   const buf = await buildReportDocx(data);   // Buffer del .docx
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import JSZip from 'jszip';
import {
  Document, Packer, Paragraph, TextRun, ImageRun, Table, TableRow, TableCell,
  Header, Footer, AlignmentType, WidthType, BorderStyle, ShadingType, VerticalAlign,
  TabStopType, LevelFormat, HorizontalPositionRelativeFrom, VerticalPositionRelativeFrom,
  ExternalHyperlink,
} from 'docx';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.join(__dirname, 'report-assets');
const IMG = f => fs.readFileSync(path.join(ASSETS, 'img', f));
const bg = IMG('bg.png'), fb = IMG('fb.png'), ig = IMG('ig.png'), tt = IMG('tt.png'), news = IMG('news.png');
const ICON = { facebook: fb, fb, instagram: ig, ig, tiktok: tt, tt, prensa: news, news };

// ── Paleta / fuentes ──
const INK='0E1B45', INK2='1C326E', BODY='1A1C20', GRAY='4A4E57', GRAY2='7A7E88',
      BLUE='2E5BE0', GOLD='B8841C', RED='B43A3A', CARD='FBF8EE', CARD2='F7F3E6',
      BD='E4DDC6', BD2='D8CFB6', LINK='0563C1';
const SERIF='Fraunces', SANS='Geist', MONO='Geist Mono';
const W = 10080;
const COLOR = { ink:INK, ink2:INK2, body:BODY, gray:GRAY, gray2:GRAY2, blue:BLUE, gold:GOLD, red:RED, link:LINK };
const FONT = { serif:SERIF, sans:SANS, mono:MONO };
const col = c => COLOR[c] || c || BODY;         // acepta nombre o hex
const fnt = f => FONT[f] || SANS;

// ── Runs / párrafos ──
const rn = (s) => new TextRun({
  text: s.t ?? '', font: fnt(s.f), size: s.s || 21, bold: !!s.b, italics: !!s.i,
  color: col(s.c), underline: s.u ? {} : undefined, superScript: !!s.sup,
});
const runs = (arr, def={}) => (arr || []).map(x => rn({ ...def, ...x }));
const para = (arr, o={}) => new Paragraph({ children: runs(arr, o.def), spacing:{ after:o.after??120, before:o.before??0, line:o.line }, alignment:o.align, tabStops:o.tabs, border:o.border });
const icon = (buf, px=11) => new ImageRun({ type:'png', data:buf, transformation:{ width:px, height:px } });
const spacer = (h=120) => new Paragraph({ spacing:{ after:h }, children:[] });

function section(num, label, subRuns){
  return [
    new Paragraph({ spacing:{ before:300, after:60 }, border:{ bottom:{ style:BorderStyle.SINGLE, size:4, color:BD, space:4 } },
      children:[ new TextRun({ text:`${num} · ${label}`, font:MONO, size:16, bold:true, color:INK2 }) ] }),
    new Paragraph({ spacing:{ after:120 }, children: runs(subRuns, { f:'serif', s:34, c:'ink' }) }),
  ];
}
function statCell(s){
  const c = Math.floor(W/3);
  return new TableCell({ width:{size:c,type:WidthType.DXA}, shading:{fill:CARD,type:ShadingType.CLEAR,color:'auto'},
    borders:{ top:{style:BorderStyle.SINGLE,size:6,color:BD}, bottom:{style:BorderStyle.SINGLE,size:6,color:BD}, left:{style:BorderStyle.SINGLE,size:6,color:BD}, right:{style:BorderStyle.SINGLE,size:6,color:BD} },
    margins:{top:130,bottom:130,left:160,right:160}, children:[
      new Paragraph({ spacing:{after:40}, tabStops:[{type:TabStopType.RIGHT,position:c-360}], children:[ new TextRun({text:s.label,font:MONO,size:14,color:GRAY}), new TextRun({text:'\t'+(s.idx||''),font:MONO,size:13,color:GRAY2}) ] }),
      new Paragraph({ spacing:{after:20}, children:[ new TextRun({text:String(s.big),font:SERIF,size:60,bold:true,color:INK}) ] }),
      new Paragraph({ spacing:{after:0}, children:[ new TextRun({text:s.cap||'',font:MONO,size:15,color:GRAY}) ] }),
    ] });
}
const th = t => new TableCell({ margins:{top:70,bottom:70,left:120,right:120}, borders:{bottom:{style:BorderStyle.SINGLE,size:16,color:INK}}, children:[ new Paragraph({spacing:{after:0},children:[ new TextRun({text:t,font:MONO,size:15,bold:true,color:INK2}) ]}) ] });
const td = (children,last) => new TableCell({ verticalAlign:VerticalAlign.CENTER, margins:{top:90,bottom:90,left:120,right:120}, borders:{bottom:{style:BorderStyle.SINGLE,size:4,color:last?'FFFFFF':BD2}}, children:Array.isArray(children)?children:[children] });
const tMono = (t,c=GRAY) => new Paragraph({spacing:{after:0},children:[new TextRun({text:t,font:MONO,size:16,color:c})]});
const tTxt = (t,o={}) => new Paragraph({spacing:{after:0},children:[new TextRun({text:t,font:SANS,size:18,bold:!!o.b,color:o.c||BODY})]});
const tLink = (t,url) => new Paragraph({spacing:{after:0},children:[ new ExternalHyperlink({ link:url, children:[ new TextRun({text:t,font:SANS,size:18,bold:true,color:LINK,underline:{}}) ] }) ]});
const chan = (key,label) => new Paragraph({spacing:{after:0},children:[ icon(ICON[key]||news,12), new TextRun({text:' '+label,font:SANS,size:18,color:BODY}) ]});

function narrCard(cardo){
  const accent = col(cardo.accent || 'blue');
  return new Table({ width:{size:W,type:WidthType.DXA}, columnWidths:[W], rows:[ new TableRow({ cantSplit:true, children:[ new TableCell({
    width:{size:W,type:WidthType.DXA}, shading:{fill:CARD,type:ShadingType.CLEAR,color:'auto'},
    borders:{ left:{style:BorderStyle.SINGLE,size:24,color:accent}, top:{style:BorderStyle.SINGLE,size:4,color:BD}, bottom:{style:BorderStyle.SINGLE,size:4,color:BD}, right:{style:BorderStyle.SINGLE,size:4,color:BD} },
    margins:{top:130,bottom:130,left:200,right:200}, children:[
      new Paragraph({ spacing:{after:60}, children:[ new TextRun({text:cardo.label||'',font:MONO,size:15,bold:true,color:col(cardo.labelColor||cardo.accent||'blue')}) ] }),
      new Paragraph({ spacing:{after:70}, children:[ new TextRun({text:cardo.quote||'',font:SANS,size:22,italics:true,color:BODY}) ] }),
      new Paragraph({ spacing:{after:0}, children:[ ...(cardo.metaIcon?[icon(ICON[cardo.metaIcon]||news,11), new TextRun({text:'  ',font:MONO,size:15})]:[]), new TextRun({text:cardo.meta||'',font:MONO,size:15,color:GRAY}) ] }),
    ] }) ]}) ] });
}

export async function buildReportDocx(data){
  const m = data.meta || {};
  const body = [];

  // Marca + tipo
  body.push(new Paragraph({ spacing:{after:40}, tabStops:[{type:TabStopType.RIGHT,position:W}], border:{ bottom:{ style:BorderStyle.SINGLE, size:12, color:INK, space:6 } }, children:[
    new TextRun({text:'Blackwell',font:SERIF,size:40,bold:true,color:INK}),
    new TextRun({text:' ®',font:SANS,size:16,color:GRAY,superScript:true}),
    new TextRun({text:'\t'+(m.tipo||'REPORTE DE MONITOREO · ESCUCHA SOCIAL'),font:MONO,size:15,color:GRAY}),
  ]}));
  body.push(new Paragraph({ spacing:{before:120,after:40}, tabStops:[{type:TabStopType.RIGHT,position:W}], children:[
    new TextRun({text:m.kicker||'',font:MONO,size:16,bold:true,color:INK}),
    new TextRun({text:'\t'+(m.fechaLabel||'')+'      FOLIO · '+(m.folio||''),font:MONO,size:16,color:GRAY}),
  ]}));
  body.push(new Paragraph({ spacing:{before:60,after:60}, children: runs(m.tituloRuns||[{t:'Reporte'}], { f:'serif', s:52, c:'ink' }) }));
  if (m.fuentes?.length) {
    const kids = [ new TextRun({text:'FUENTES · ',font:MONO,size:15,color:GRAY2}) ];
    m.fuentes.forEach(f => { if (f.icon) kids.push(icon(ICON[f.icon]||news,11)); kids.push(new TextRun({text:(f.icon?' ':'')+f.label+'   ',font:MONO,size:15,color:GRAY})); });
    body.push(new Paragraph({ spacing:{after:60}, children:kids }));
  }

  // 01 Método
  if (data.metodo) { body.push(...section('01', data.metodo.tag||'ALCANCE Y MÉTODO', data.metodo.sub));
    (data.metodo.paras||[]).forEach(p => body.push(para(p,{line:276}))); }
  // 02 Resumen + stats
  if (data.resumen) { body.push(...section('02', data.resumen.tag||'RESUMEN EJECUTIVO', data.resumen.sub));
    (data.resumen.paras||[]).forEach(p => body.push(para(p,{line:276})));
    if (data.resumen.stats?.length) { body.push(spacer(20));
      body.push(new Table({ width:{size:W,type:WidthType.DXA}, columnWidths:[Math.floor(W/3),Math.floor(W/3),W-2*Math.floor(W/3)], rows:[ new TableRow({cantSplit:true,children:data.resumen.stats.slice(0,3).map(statCell)}) ] }));
    } body.push(spacer(140)); }
  // 03 Volumen (tabla piezas)
  if (data.volumen) { body.push(...section('03', data.volumen.tag||'VOLUMEN Y ALCANCE', data.volumen.sub));
    if (data.volumen.intro) body.push(para(data.volumen.intro,{after:120}));
    const grid=[3200,1320,900,1500,1200,1960];
    const rows=[ new TableRow({tableHeader:true,cantSplit:true,children:[th('PIEZA'),th('CANAL'),th('FECHA'),th('ALCANCE'),th('REACC.'),th('TONO')]}) ];
    (data.volumen.piezas||[]).forEach((p,i,arr)=>{ const last=i===arr.length-1;
      rows.push(new TableRow({cantSplit:true,children:[
        td(p.url?tLink(p.titulo,p.url):tTxt(p.titulo,{b:true,c:INK}),last),
        td(chan(p.canal, p.canalLabel||({instagram:'Instagram',tiktok:'TikTok',facebook:'Facebook'}[p.canal]||p.canal)),last),
        td(tMono(p.fecha||''),last), td(tMono(p.alcance||'—',BLUE),last), td(tMono(String(p.reacc??''),BLUE),last), td(tTxt(p.tono||''),last),
      ]})); });
    body.push(new Table({width:{size:W,type:WidthType.DXA},columnWidths:grid,rows}));
    body.push(spacer(150)); }
  // 04 Narrativas
  if (data.narrativas) { body.push(...section('04', data.narrativas.tag||'NARRATIVAS DOMINANTES', data.narrativas.sub));
    (data.narrativas.bloques||[]).forEach((b,bi)=>{
      if (bi>0) body.push(spacer(120));
      if (b.tituloRuns) body.push(para(b.tituloRuns,{after:40}));
      if (b.intro) body.push(para(b.intro,{after:100}));
      (b.cards||[]).forEach((c,ci)=>{ if (ci>0) body.push(spacer(80)); body.push(narrCard(c)); });
      if (b.nota) body.push(para(b.nota,{before:80,after:40}));
    });
    body.push(spacer(150)); }
  // 05 Sentimiento
  if (data.sentimiento) { body.push(...section('05', data.sentimiento.tag||'LECTURA DE SENTIMIENTO', data.sentimiento.sub));
    (data.sentimiento.paras||[]).forEach(p => body.push(para(p,{line:276}))); }
  // 06 Riesgos (bullets)
  if (data.riesgos) { body.push(...section('06', data.riesgos.tag||'RIESGOS Y RECOMENDACIONES', data.riesgos.sub));
    (data.riesgos.bullets||[]).forEach(bl => body.push(new Paragraph({ numbering:{reference:'riesgos',level:0}, spacing:{after:100,line:276}, children:[ new TextRun({text:bl.lead||'',font:SANS,size:21,bold:true,color:INK}), new TextRun({text:bl.rest||'',font:SANS,size:21,color:BODY}) ] })));
    body.push(spacer(60)); }
  // 07 Q&A
  if (data.qa) { body.push(...section('07', data.qa.tag||'PREGUNTAS Y RESPUESTAS SUGERIDAS', data.qa.sub));
    const qaHead=t=>new TableCell({margins:{top:70,bottom:70,left:140,right:140},borders:{bottom:{style:BorderStyle.SINGLE,size:16,color:INK}},children:[new Paragraph({spacing:{after:0},children:[new TextRun({text:t,font:MONO,size:15,bold:true,color:INK2})]})]});
    const rows=[ new TableRow({tableHeader:true,cantSplit:true,children:[qaHead('TEMA'),qaHead('RESPUESTA SUGERIDA')]}) ];
    (data.qa.filas||[]).forEach((f,i,arr)=>{ const last=i===arr.length-1;
      rows.push(new TableRow({cantSplit:true,children:[
        new TableCell({width:{size:2760,type:WidthType.DXA},shading:{fill:CARD2,type:ShadingType.CLEAR,color:'auto'},borders:{right:{style:BorderStyle.SINGLE,size:4,color:BD},bottom:{style:BorderStyle.SINGLE,size:4,color:last?'FFFFFF':BD2}},margins:{top:110,bottom:110,left:140,right:140},children:[new Paragraph({spacing:{after:0},children:[new TextRun({text:f.tema||'',font:SANS,size:19,bold:true,color:INK})]})]}),
        new TableCell({width:{size:7320,type:WidthType.DXA},borders:{bottom:{style:BorderStyle.SINGLE,size:4,color:last?'FFFFFF':BD2}},margins:{top:110,bottom:110,left:140,right:140},children:(f.respuesta||[]).map(p=>new Paragraph({spacing:{after:p.after??0},children:runs(p.runs,{s:19})}))}),
      ]})); });
    body.push(new Table({width:{size:W,type:WidthType.DXA},columnWidths:[2760,7320],rows})); }

  const doc = new Document({
    styles:{ default:{ document:{ run:{ font:SANS, size:21, color:BODY } } } },
    numbering:{ config:[{ reference:'riesgos', levels:[{ level:0, format:LevelFormat.BULLET, text:'—', alignment:AlignmentType.LEFT, style:{ run:{color:GOLD,bold:true}, paragraph:{ indent:{left:420,hanging:280} } } }] }] },
    sections:[{
      properties:{ page:{ size:{width:12240,height:15840}, margin:{top:1080,bottom:1080,left:1080,right:1080,header:0,footer:520} } },
      headers:{ default:new Header({ children:[ new Paragraph({ spacing:{after:0}, children:[ new ImageRun({ type:'png', data:bg, transformation:{width:816,height:1056}, floating:{ horizontalPosition:{relative:HorizontalPositionRelativeFrom.PAGE,offset:0}, verticalPosition:{relative:VerticalPositionRelativeFrom.PAGE,offset:0}, behindDocument:true, allowOverlap:true } }) ] }) ] }) },
      footers:{ default:new Footer({ children:[ new Paragraph({ border:{ top:{style:BorderStyle.SINGLE,size:4,color:BD2,space:6} }, tabStops:[{type:TabStopType.CENTER,position:Math.floor(W/2)},{type:TabStopType.RIGHT,position:W}], children:[
        new TextRun({text:(m.folio||''),font:MONO,size:13,color:INK2}),
        new TextRun({text:'\tBLACKWELL STRATEGY',font:MONO,size:13,color:INK2}),
        new TextRun({text:'\tCONFIDENCIAL · USO INTERNO',font:MONO,size:13,bold:true,color:RED}),
      ]}) ] }) },
      children: body,
    }],
  });

  const raw = await Packer.toBuffer(doc);
  return embedFonts(raw);
}

// ── Incrustación de fuentes de marca vía JSZip (entradas con '/' válidas OPC) ──
const FONT_FILES = {
  rId1:'Fraunces-regular.ttf', rId2:'Fraunces-bold.ttf', rId3:'Fraunces-italic.ttf', rId4:'Fraunces-boldItalic.ttf',
  rId5:'Geist-regular.ttf', rId6:'Geist-bold.ttf', rId7:'Geist-italic.ttf', rId8:'Geist-boldItalic.ttf',
  rId9:'GeistMono-regular.ttf', rId10:'GeistMono-bold.ttf', rId11:'GeistMono-italic.ttf', rId12:'GeistMono-boldItalic.ttf',
};
const NS = 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const FONT_TABLE_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:fonts ${NS}><w:font w:name="Georgia"/>`+
  `<w:font w:name="Fraunces"><w:embedRegular w:fontKey="{00000000-0000-0000-0000-000000000000}" r:id="rId1" w:subsetted="0"/><w:embedBold w:fontKey="{00000000-0000-0000-0000-000000000000}" r:id="rId2" w:subsetted="0"/><w:embedItalic w:fontKey="{00000000-0000-0000-0000-000000000000}" r:id="rId3" w:subsetted="0"/><w:embedBoldItalic w:fontKey="{00000000-0000-0000-0000-000000000000}" r:id="rId4" w:subsetted="0"/></w:font>`+
  `<w:font w:name="Geist"><w:embedRegular w:fontKey="{00000000-0000-0000-0000-000000000000}" r:id="rId5" w:subsetted="0"/><w:embedBold w:fontKey="{00000000-0000-0000-0000-000000000000}" r:id="rId6" w:subsetted="0"/><w:embedItalic w:fontKey="{00000000-0000-0000-0000-000000000000}" r:id="rId7" w:subsetted="0"/><w:embedBoldItalic w:fontKey="{00000000-0000-0000-0000-000000000000}" r:id="rId8" w:subsetted="0"/></w:font>`+
  `<w:font w:name="Geist Mono"><w:embedRegular w:fontKey="{00000000-0000-0000-0000-000000000000}" r:id="rId9" w:subsetted="0"/><w:embedBold w:fontKey="{00000000-0000-0000-0000-000000000000}" r:id="rId10" w:subsetted="0"/><w:embedItalic w:fontKey="{00000000-0000-0000-0000-000000000000}" r:id="rId11" w:subsetted="0"/><w:embedBoldItalic w:fontKey="{00000000-0000-0000-0000-000000000000}" r:id="rId12" w:subsetted="0"/></w:font></w:fonts>`;
const FONT_RELS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">`+
  Object.entries(FONT_FILES).map(([id,f]) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/font" Target="fonts/${f}"/>`).join('')+
  `</Relationships>`;

async function embedFonts(docxBuffer){
  const zip = await JSZip.loadAsync(docxBuffer);
  for (const f of Object.values(FONT_FILES)) zip.file(`word/fonts/${f}`, fs.readFileSync(path.join(ASSETS,'fonts',f)));
  zip.file('word/fontTable.xml', FONT_TABLE_XML);
  zip.file('word/_rels/fontTable.xml.rels', FONT_RELS_XML);
  // settings: activar incrustación
  let settings = await zip.file('word/settings.xml').async('string');
  if (!/embedTrueTypeFonts/.test(settings)) settings = settings.replace('<w:displayBackgroundShape/>', '<w:displayBackgroundShape/><w:embedTrueTypeFonts w:val="1"/>');
  zip.file('word/settings.xml', settings);
  // content-types: ttf
  let ct = await zip.file('[Content_Types].xml').async('string');
  if (!/Extension="ttf"/.test(ct)) ct = ct.replace('Extension="odttf"/>', 'Extension="odttf"/><Default ContentType="application/x-font-ttf" Extension="ttf"/>');
  zip.file('[Content_Types].xml', ct);
  return zip.generateAsync({ type:'nodebuffer', compression:'DEFLATE' });
}

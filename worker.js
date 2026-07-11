// Cloudflare Worker —— 为 ai-industry-chain.html 提供公告/要闻代理
// 解决：GitHub Pages 是纯静态托管，跑不了 server.py，东方财富接口跨域且按来源拦截；
//       此 Worker 在服务端带 Referer 抓取东方财富数据并开放 CORS，让 GitHub Pages 上的
//       公告与要闻稳定显示。
//
// 部署步骤：
//   1) 安装 wrangler：npm i -g wrangler
//   2) 登录：wrangler login
//   3) 部署：wrangler deploy   （会用同目录的 wrangler.toml）
//   4) 部署后会得到一个地址，如 https://ai-industry-proxy.<你的子域>.workers.dev
//   5) 把该地址填进 ai-industry-chain.html 里的 ANN_PROXY 常量，重新推送即可。
//
// 需提供以下路由：
//   GET /api/ann?code=SH600519        —— 公告（东方财富）
//   GET /api/news?code=SH600519       —— 要闻（东方财富）
//   GET /api/kline?code=usNVDA         —— 美股 K 线（Yahoo 全美股覆盖 + push2his 纳斯达克兜底），供页面 KLINE_PROXY 使用

const EM_REFERER = 'https://quote.eastmoney.com/';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store'
    }
  });
}

// SH600519 / SZ000001 / BJ920xxx -> SH600519（与页面 _em_ann_code 同逻辑）
function emAnnCode(code) {
  const m = /^([a-zA-Z]{2})([0-9A-Za-z]+)$/.exec((code || '').trim());
  if (!m) return null;
  const pfx = m[1].toUpperCase();
  const num = m[2].toUpperCase();
  const map = { SH: 'SH', SZ: 'SZ', BJ: 'BJ' };
  return map[pfx] ? map[pfx] + num : null;
}

// 美股 K 线：主源 Yahoo（全美股覆盖，含纽交所），兜底 push2his（纳斯达克）。
// 返回与页面 parseEMKline 兼容的结构：{ data: { klines: ["date,o,c,h,l,v", ...] } }
async function fetchKlineUS(code) {
  const tk = String(code || '').replace(/^us/i, '').toUpperCase();
  if (!tk) return null;
  // 1) Yahoo（覆盖最全，含纽交所）
  try {
    const yUrl = 'https://query1.finance.yahoo.com/v8/finance/chart/' + tk + '?range=2y&interval=1d';
    const yr = await fetch(yUrl, { headers: { 'User-Agent': UA, 'Accept': '*/*' } });
    if (yr.ok) {
      const yj = await yr.json();
      const r = yj && yj.chart && yj.chart.result && yj.chart.result[0];
      if (r && r.timestamp && r.indicators && r.indicators.quote && r.indicators.quote[0]) {
        const q = r.indicators.quote[0], ts = r.timestamp, out = [];
        for (let i = 0; i < ts.length; i++) {
          const o = q.open[i], c = q.close[i], h = q.high[i], l = q.low[i], v = q.volume[i];
          if (o == null || c == null || h == null || l == null) continue;
          const dt = new Date(ts[i] * 1000);
          const ds = dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0') + '-' + String(dt.getUTCDate()).padStart(2, '0');
          out.push([ds, +o, +c, +h, +l, +(v || 0)].join(','));
        }
        if (out.length >= 2) return { data: { klines: out } };
      }
    }
  } catch (e) {}
  // 2) 兜底 push2his（纳斯达克 105）
  try {
    const cb = '_emkl' + Math.random().toString(36).slice(2);
    const emUrl = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=105.' + tk
      + '&fields1=f1,f2,f3,f4,f5,f6&fields2=f51,f52,f53,f54,f55,f56&klt=101&fqt=0&beg=20230101&end=20990101&cb=' + cb;
    const er = await fetch(emUrl, { headers: { 'User-Agent': UA, 'Referer': EM_REFERER, 'Accept': '*/*' } });
    if (er.ok) {
      const txt = await er.text();
      const m = /^([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)\s*;?\s*$/.exec(txt.trim());
      const j = JSON.parse(m ? m[2] : txt);
      const d = j && j.data;
      if (d) {
        let klines = null;
        if (Array.isArray(d.klines)) klines = d.klines;
        else for (const k in d) { if (d[k] && Array.isArray(d[k].klines)) { klines = d[k].klines; break; } }
        if (klines && klines.length >= 2) return { data: { klines } };
      }
    }
  } catch (e) {}
  return null;
}

function stripJsonp(txt) {
  const m = /^([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)\s*;?\s*$/.exec((txt || '').trim());
  return m ? m[2] : txt;
}

async function fetchAnn(code) {
  const list = emAnnCode(code);
  if (!list) return [];
  const url = 'https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=5'
    + '&page_index=1&client_source=web&stock_list=' + list;
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': EM_REFERER, 'Accept': '*/*' } });
  const data = JSON.parse(stripJsonp(await r.text()));
  const arr = (data.data && data.data.list) || [];
  return arr.slice(0, 5).map(it => ({
    date: (it.notice_date || it.eitime || '').slice(0, 10),
    title: it.title || it.notice_title || ''
  }));
}

async function fetchNews(code) {
  const list = emAnnCode(code);
  if (!list) return [];
  const inner = {uid:'',keyword:list,type:['cmsArticleWebOld'],client:'web',clientType:'web',clientVersion:'curr',param:{cmsArticleWebOld:{searchScope:'default',sort:'default',pageIndex:1,pageSize:6,preTag:'',postTag:''}}};
  const url = 'https://search-api-web.eastmoney.com/search/jsonp?cb=_emnews&param=' + encodeURIComponent(JSON.stringify(inner));
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': EM_REFERER, 'Accept': '*/*' } });
  const data = JSON.parse(stripJsonp(await r.text()));
  const arr = (data.result && data.result.cmsArticleWebOld) || [];
  const out = [];
  for (const it of arr.slice(0, 6)) {
    if (!it || typeof it !== 'object') continue;
    const title = (it.title || '').replace(/<[^>]+>/g, '');
    if (!title) continue;
    out.push({
      date: (it.date || '').slice(0, 10),
      title,
      pop: it.popularity != null ? it.popularity : (it.count || ''),
      col: it.mediaName || ''
    });
  }
  return out;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      if (url.pathname === '/api/ann') {
        return json({ list: await fetchAnn(url.searchParams.get('code') || '') });
      }
      if (url.pathname === '/api/news') {
        return json({ list: await fetchNews(url.searchParams.get('code') || '') });
      }
      if (url.pathname === '/api/kline') {
        const kl = await fetchKlineUS(url.searchParams.get('code') || '');
        return json(kl || { error: 'no kline' }, kl ? 200 : 404);
      }
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }
};

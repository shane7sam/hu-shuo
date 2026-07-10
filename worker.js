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
// 需同时提供两个路由（与 server.py 一致）：
//   GET /api/ann?code=SH600519
//   GET /api/news?code=SH600519

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

function stripJsonp(txt) {
  const m = /^([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)\s*;?\s*$/.exec((txt || '').trim());
  return m ? m[2] : txt;
}

async function fetchAnn(code) {
  const list = emAnnCode(code);
  if (!list) return [];
  const url = 'https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=5'
    + '&page_index=1&ann_type=0&client_source=web&stock_list=' + list;
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
  const url = 'https://np-listapi.eastmoney.com/comm/web/getNewsByCode?client=PC&code=' + list + '&num=6&page=1';
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': EM_REFERER, 'Accept': '*/*' } });
  const data = JSON.parse(stripJsonp(await r.text()));
  const arr = (data.data && (data.data.list || data.data.newsList)) || [];
  const out = [];
  for (const it of arr.slice(0, 6)) {
    if (!it || typeof it !== 'object') continue;
    const title = it.title || '';
    if (!title) continue;
    out.push({
      date: (it.date || it.datetime || it.showtime || '').slice(0, 10),
      title,
      pop: it.popularity != null ? it.popularity : (it.count || ''),
      col: it.column || it.mediaName || ''
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
      return json({ error: 'not found' }, 404);
    } catch (e) {
      return json({ error: String(e && e.message || e) }, 500);
    }
  }
};

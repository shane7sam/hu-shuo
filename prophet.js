/* 预言家栏目 · 前端客户端与渲染（财联社 + 东方财富 双源）
 * - fetchCLS(): 网页端走 Cloudflare Worker 代理(PROPHET_PROXY)，本地端走同源 /api/prophet/cls
 * - fetchEM():  网页端 JSONP 直连 datacenter-web.eastmoney.com（东财无 CORS 头，必须 JSONP）；
 *               本地端走同源 /api/prophet/em (server.py)
 * - render():   把合并后的归一化事件按日期分组渲染进 #prophetView，并标注来源(财联社/东财)
 * - 事件详情：每条事件可点击，弹出复用「个股窗口」CSS 模板的详情弹层（#prophetDetail），内容先做占位
 * - 视图切换：与顶部「产业链」导航并列，点击「事件日历」切换主视图
 * 归一化事件结构: {src:'cls'|'em',date,time,title,country,importance,cat}
 */
(function () {
  'use strict';

  // 本地检测：localhost / 127.0.0.1 / file:// 双击打开 均视为本地模式
  var isLocal = /^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/.test(location.hostname)
    || location.protocol === 'file:';

  var LOCAL_PORT = 8787;

  // 事件 → uid 映射（render 时填充，点击时查表）
  var evMap = {};
  var evSeq = 0;

  // 预言家子视图：'cal'=事件日历（财联社+东财）  'news'=新闻库（聚合所有抓取新闻源）
  var subView = 'cal';

  // 延迟解析代理基址：PROPHET_PROXY/KLINE_PROXY 在页面底部 const 定义，
  // prophet.js 先加载，需在点击时（页面已就绪）再读取 window.*。
  function pickURL(path) {
    if (isLocal) {
      // file:// 协议下相对路径无效，必须用绝对地址回指 server.py
      if (location.protocol === 'file:') {
        return 'http://localhost:' + LOCAL_PORT + path;
      }
      return path;
    }
    var base = window.PROPHET_PROXY || window.KLINE_PROXY || '';
    return base ? (base + path) : '';
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function stars(n) {
    n = Math.max(0, Math.min(5, n | 0));
    return n ? '★'.repeat(n) : '';
  }

  // 东财 STD_TYPE_CODE(1-3) → 重要度星级(1-5)
  function emImportance(std) {
    return std === '3' ? 5 : std === '2' ? 3 : std === '1' ? 1 : 2;
  }

  // ---------- 财联社 ----------
  async function fetchCLS() {
    var url = pickURL('/api/prophet/cls');
    if (!url) { console.warn('[Prophet] 网页端未配置 PROPHET_PROXY，无法拉取财联社'); return []; }
    try {
      var r = await fetch(url, { cache: 'no-store' });
      var j = await r.json();
      if (j && Array.isArray(j.events)) return j.events;
      if (j && j.error) console.warn('[Prophet] cls:', j.error);
      return [];
    } catch (e) {
      console.warn('[Prophet] cls fetch failed:', e);
      return [];
    }
  }

  // ---------- 东方财富（JSONP 直连 / 本地同源） ----------
  function emFilterWindow() {
    // 严格过滤：只取「今天起 ~ 今天+30天」开始的事件（与 Worker fetchEM 的 sd<today 过滤一致）
    var d = new Date();
    var s = d; // 从今天开始（不再用 today-3天）
    var e = new Date(d.getTime() + 30 * 86400000);
    var fmt = function (x) { return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0'); };
    return "(START_DATE>='" + fmt(s) + "')(START_DATE<'" + fmt(e) + "')";
  }

  function normalizeEM(row) {
    if (!row || typeof row !== 'object') return null;
    var sd = (row.START_DATE || '').slice(0, 10);
    if (!sd) return null;
    // 过滤掉「经济数据」类型（宏观指标发布等，非事件型日历条目）
    if (row.FE_TYPE === '经济数据') return null;
    var sp = (row.SPONSOR_NAME || '').split(',')[0].trim().slice(0, 20);
    return {
      src: 'em',
      date: sd,
      time: (row.START_DATE || '').slice(11, 16) || '',
      title: row.FE_NAME || '',
      country: sp,
      importance: emImportance(row.STD_TYPE_CODE),
      cat: 'event'
    };
  }

  // 网页端：JSONP 直连东财（绕 CORS）。返回 Promise<events[]>
  function fetchEMJsonp() {
    return new Promise(function (resolve) {
      var cbName = '__em_cb_' + Date.now();
      var flt = emFilterWindow();
      var api = 'https://datacenter-web.eastmoney.com/api/data/v1/get'
        + '?reportName=RPT_CPH_FECALENDAR'
        + '&columns=START_DATE,END_DATE,FE_CODE,FE_NAME,FE_TYPE,CONTENT,STD_TYPE_CODE,SPONSOR_NAME,CITY'
        + '&filter=' + encodeURIComponent(flt)
        + '&pageSize=100&sortColumns=START_DATE&sortTypes=1&source=WEB&client=WEB'
        + '&callback=' + cbName;
      var sc = document.createElement('script');
      var done = false;
      function finish(arr) {
        if (done) return; done = true;
        try { sc.remove(); } catch (e) {}
        try { delete window[cbName]; } catch (e) {}
        resolve(Array.isArray(arr) ? arr : []);
      }
      window[cbName] = function (j) {
        var rows = (j && j.result && j.result.data) || [];
        finish(rows.map(normalizeEM).filter(Boolean));
      };
      sc.onerror = function () { finish([]); };
      sc.src = api;
      (document.head || document.body).appendChild(sc);
      setTimeout(function () { finish([]); }, 12000);
    });
  }

  async function fetchEM() {
    if (isLocal) {
      var url = pickURL('/api/prophet/em');
      try {
        var r = await fetch(url, { cache: 'no-store' });
        var j = await r.json();
        if (j && Array.isArray(j.events)) return j.events;
        return [];
      } catch (e) {
        console.warn('[Prophet] em fetch failed:', e);
        return [];
      }
    }
    // 网页端：JSONP 直连（不依赖 Worker）
    return fetchEMJsonp();
  }

  // ---------- 合并渲染 ----------
  function groupByDate(events) {
    var m = {};
    events.forEach(function (e) { (m[e.date] = m[e.date] || []).push(e); });
    return Object.keys(m).sort().map(function (d) { return { date: d, items: m[d] }; });
  }

  var SRC_LABEL = { cls: '财联社', em: '东财' };

  function renderCalendar(events, mount) {
    var el = mount || document.getElementById('prophetContent');
    if (!el) return;
    evMap = {};
    evSeq = 0;
    // 按来源统计（便于诊断）
    var clsCount = 0, emCount = 0;
    (events || []).forEach(function (e) { if (e.src === 'cls') clsCount++; else emCount++; });
    if (!events || !events.length) {
      el.innerHTML = '<div class="prophet-empty">事件日历暂不可用（代理未部署或网络异常）。'
        + '网页端财联社需部署 Cloudflare Worker 的 /api/prophet/cls、东财走 JSONP 直连；本地端由 server.py 提供。</div>';
      return;
    }
    var groups = groupByDate(events);
    var srcHint = '（财联社 ' + clsCount + ' 条 · 东财 ' + emCount + ' 条）';
    var html = '<div class="prophet-head">事件日历 · 财联社 + 东方财富（未来 30 天）'
      + '<span class="plegend"><i class="lg cls">财联社</i><i class="lg em">东财</i>'
      + '<span class="psrc-count">' + srcHint + '</span></span></div>';
    groups.forEach(function (g) {
      html += '<div class="pday"><div class="pdate">' + escapeHtml(g.date) + '</div><div class="pitems">';
      g.items.slice().sort(function (a, b) {
        if ((b.importance | 0) !== (a.importance | 0)) return (b.importance | 0) - (a.importance | 0);
        return (a.src || '').localeCompare(b.src || '');
      }).forEach(function (it) {
        var uid = 'e' + (evSeq++);
        evMap[uid] = it;
        var imp = it.importance >= 4 ? 'hot' : (it.importance >= 3 ? 'mid' : 'low');
        var srcCls = it.src === 'em' ? 'em' : 'cls';
        html += '<div class="pitem ' + imp + '" data-uid="' + uid + '" title="点击查看事件详情">'
          + (it.importance ? '<span class="pstar">' + stars(it.importance) + '</span>' : '')
          + '<span class="ptitle">' + escapeHtml(it.title) + '</span>'
          + '<span class="psrc ' + srcCls + '">' + (SRC_LABEL[it.src] || it.src) + '</span>'
          + (it.country ? '<span class="pcountry">' + escapeHtml(it.country) + '</span>' : '')
          + (it.time && it.time !== '00:00' ? '<span class="ptime">' + escapeHtml(it.time) + '</span>' : '')
          + '</div>';
      });
      html += '</div></div>';
    });
    el.innerHTML = html;
  }

  // ---------- 事件详情弹层（复用个股窗口 CSS 模板：.modal/.d-head/.d-body/.d-section） ----------
  function ensureDetailModal() {
    if (document.getElementById('prophetDetail')) return;
    var modal = document.createElement('div');
    modal.id = 'prophetDetail';
    modal.className = 'modal hidden';
    modal.innerHTML = '<div class="modal-mask"></div>'
      + '<div class="modal-panel">'
      +   '<div class="d-head" id="pDetHead">'
      +     '<button class="d-back" id="pDetBack" title="返回">← 返回</button>'
      +     '<div><div class="nm"></div><div class="meta"></div><div class="purity" id="pDetTags"></div></div>'
      +     '<div class="px" id="pDetPx"></div>'
      +     '<button class="d-close" title="关闭 (Esc)">✕</button>'
      +   '</div>'
      +   '<div class="d-body" id="pDetBody"></div>'
      + '</div>';
    document.body.appendChild(modal);
    modal.querySelector('.d-close').addEventListener('click', closeProphetDetail);
    modal.querySelector('#pDetBack').addEventListener('click', closeProphetDetail);
    modal.querySelector('.modal-mask').addEventListener('click', closeProphetDetail);
  }

  function placeholderSection(title, tip) {
    return '<div class="d-section"><h3>' + escapeHtml(title) + '</h3>'
      + '<div class="d-note">' + escapeHtml(tip) + '</div></div>';
  }

  function openProphetDetail(ev) {
    if (!ev) return;
    ensureDetailModal();
    var modal = document.getElementById('prophetDetail');
    var head = document.getElementById('pDetHead');
    head.querySelector('.nm').textContent = ev.title || '（无标题）';
    var metaParts = [SRC_LABEL[ev.src] || ev.src];
    if (ev.country) metaParts.push(ev.country);
    if (ev.cat === 'macro') metaParts.push('宏观事件');
    head.querySelector('.meta').textContent = metaParts.join(' · ');
    // 重要度（仿个股「题材纯度」区域）
    var tags = document.getElementById('pDetTags');
    tags.innerHTML = (ev.importance ? '<span class="pl">重要性</span> <span class="ps">' + stars(ev.importance) + '</span>' : '')
      + (ev.src === 'cls' ? ' <span class="pl">来源</span> <span class="ps2" style="color:#e0a93b">财联社</span>' : ' <span class="pl">来源</span> <span class="ps2" style="color:#5b9bd5">东方财富</span>');
    // 日期时间（仿个股「价格」区域）
    var px = document.getElementById('pDetPx');
    var dt = ev.date + (ev.time && ev.time !== '00:00' ? ' ' + ev.time : '');
    px.innerHTML = '<div class="p">' + escapeHtml(dt) + '</div><div class="pe">事件时间</div>';

    // 正文：事件详情/关联产业链/历史相似 仍占位；「相关新闻与公告」接东财 search-api-web 实时拉取
    var body = document.getElementById('pDetBody');
    body.innerHTML =
        placeholderSection('事件详情', '内容建设中…后续将接入该事件的完整新闻正文、要点摘要与官方原文链接。')
      + placeholderSection('关联产业链与个股', '内容建设中…后续将根据事件关键词自动匹配看板内的 AI / 商业航天 / 机器人 / 医药 产业链与相关个股。')
      + '<div class="d-section"><div class="d-sec-h">相关新闻与公告 <span class="news-src" id="pdNewsSrc">东方财富 · 实时</span></div>'
      +   '<div id="pdNews" class="pd-news-list"><div class="news-loading">正在获取…</div></div></div>'
      + placeholderSection('历史相似事件与影响回顾', '内容建设中…后续将回溯同类事件的历史市场反应，辅助判断潜在影响方向。');

    // 打开弹层后异步拉取该事件的相关新闻与公告（东财 search-api-web JSONP 直连）
    loadProphetNews(ev);

    modal.classList.remove('hidden');
  }

  function closeProphetDetail() {
    var modal = document.getElementById('prophetDetail');
    if (modal) modal.classList.add('hidden');
  }

  // ---------- 事件详情「相关新闻与公告」：东财 search-api-web JSONP 直连 ----------
  // 网页端 / 本地端 / file:// 均可用（JSONP 不受 CORS 限制）
  function searchEMNews(keyword, type, pages) {
    return new Promise(function (resolve) {
      var all = [], pending = pages, finished = false;
      function done() { if (finished) return; finished = true; resolve(all); }
      for (var pi = 1; pi <= pages; pi++) {
        (function (pi) {
          var cb = '_pdSrch' + Math.random().toString(36).slice(2) + '_' + pi + '_' + Math.floor(Math.random() * 1e6);
          var inner = {
            uid: '', keyword: keyword, type: [type], client: 'web', clientType: 'web',
            clientVersion: 'curr', param: {}
          };
          inner.param[type] = { searchScope: 'default', sort: 'time', pageIndex: pi, pageSize: 12, preTag: '<em>', postTag: '</em>' };
          var url = 'https://search-api-web.eastmoney.com/search/jsonp?cb=' + cb
            + '&param=' + encodeURIComponent(JSON.stringify(inner));
          var timer = setTimeout(function () { pending--; if (pending <= 0) done(); }, 9000);
          window[cb] = function (json) {
            clearTimeout(timer);
            try {
              var key = type === 'notice' ? 'notice' : 'cmsArticleWebOld';
              var arr = ((json && json.result) || {})[key] || [];
              arr.forEach(function (it) {
                var nnUrl = it.url || '';
                if (!nnUrl && it.securityShortName) {
                  // 公告无原文链接时，回退到东方财富公告检索页
                  nnUrl = 'https://so.eastmoney.com/ann/s/' + encodeURIComponent(it.securityShortName) + '.html';
                }
                all.push({
                  title: (it.title || '').replace(/<[^>]+>/g, ''),
                  date: (it.date || '').slice(0, 10),
                  summary: (it.content || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(),
                  url: nnUrl,
                  src: it.mediaName || (type === 'notice' ? '上市公司公告' : ''),
                  sec: it.securityShortName || '',
                  kind: type === 'notice' ? 'ann' : 'news'
                });
              });
            } catch (e) {}
            pending--; if (pending <= 0) done();
          };
          var s = document.createElement('script');
          s.id = 'pdjs_' + cb; s.src = url;
          s.onerror = function () { clearTimeout(timer); pending--; if (pending <= 0) done(); };
          (document.head || document.body).appendChild(s);
        })(pi);
      }
    });
  }

  // 合并 公告 + 新闻，按时间倒序、去重、限制条数
  function mergeProphetNews(ann, news, limit) {
    var seen = {}, out = [];
    function pick(list) {
      (list || []).forEach(function (it) {
        if (!it || !it.title) return;
        var k = (it.url || '') + '|' + it.title;
        if (seen[k]) return;
        seen[k] = 1; out.push(it);
      });
    }
    pick(news); pick(ann); // 新闻优先置顶
    out.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    return out.slice(0, limit || 14);
  }

  function newsItemHTML(it) {
    var tag = it.kind === 'ann'
      ? '<span class="pd-nk ann">公告</span>'
      : '<span class="pd-nk news">新闻</span>';
    var meta = [];
    if (it.sec) meta.push(escapeHtml(it.sec));
    if (it.src) meta.push(escapeHtml(it.src));
    if (it.date) meta.push(escapeHtml(it.date));
    var inner = tag
      + '<div class="pd-nt">' + escapeHtml(it.title) + '</div>'
      + (meta.length ? '<div class="pd-nm">' + meta.join(' · ') + '</div>' : '')
      + (it.summary ? '<div class="pd-ns">' + escapeHtml(it.summary.slice(0, 110)) + (it.summary.length > 110 ? '…' : '') + '</div>' : '');
    if (it.url) {
      return '<a class="pd-ni" href="' + escapeHtml(it.url) + '" target="_blank" rel="noopener">' + inner + '</a>';
    }
    return '<div class="pd-ni">' + inner + '</div>';
  }

  function loadProphetNews(ev) {
    var box = document.getElementById('pdNews');
    if (!box) return;
    var kw = (ev && ev.title ? ev.title : '').trim();
    if (!kw) { box.innerHTML = '<div class="news-loading">该事件缺少可检索关键词。</div>'; return; }
    // 多翻几页以捞到被淹没的相关报道；公告/新闻各 3 页
    Promise.all([
      searchEMNews(kw, 'cmsArticleWebOld', 3),
      searchEMNews(kw, 'notice', 3)
    ]).then(function (res) {
      var merged = mergeProphetNews(res[1], res[0], 16);
      if (!merged.length) {
        box.innerHTML = '<div class="news-loading">暂无相关新闻与公告（东方财富未检索到匹配结果）。</div>';
        return;
      }
      box.innerHTML = merged.map(newsItemHTML).join('');
    }).catch(function (e) {
      box.innerHTML = '<div class="news-loading">获取失败：' + escapeHtml((e && e.message) || e) + '</div>';
    });
  }

  async function load(pv) {
    var clsP = fetchCLS();
    var emP = fetchEM();
    var both = await Promise.all([clsP, emP]);
    var merged = both[0].concat(both[1]);
    // 客户端安全过滤：丢弃今天之前开始的事件（防止上游过滤宽松导致过去事件泄露）
    // 同时过滤东财经济数据类型（网页端 JSONP 直连路径不经过 Worker 过滤）
    var todayStr = new Date().toISOString().slice(0, 10);
    merged = merged.filter(function (ev) { return ev.date >= todayStr && ev.cat !== 'macro'; });
    var c = pv ? pv.querySelector('#prophetContent') : document.getElementById('prophetContent');
    renderCalendar(merged, c);
  }

  function injectStyle() {
    if (document.getElementById('prophet-style')) return;
    var css = [
      '#prophetView{padding:18px 20px 40px;max-width:1100px;margin:0 auto;}',
      '.prophet-head{font-size:18px;font-weight:800;color:var(--text);margin:6px 0 16px;display:flex;align-items:center;gap:14px;}',
      '.plegend{display:inline-flex;gap:8px;font-size:12px;font-weight:600;}',
      '.plegend .lg{padding:1px 8px;border-radius:10px;}',
      '.plegend .lg.cls{color:#e0a93b;background:rgba(224,169,59,.12);}',
      '.plegend .lg.em{color:#5b9bd5;background:rgba(91,155,213,.12);}',
      '.psrc-count{font-size:11px;color:var(--sub);font-weight:400;margin-left:6px;}',
      '.prophet-empty{color:var(--sub);padding:40px;text-align:center;}',
      '.pday{display:flex;gap:14px;padding:14px 0;border-bottom:1px solid var(--line);}',
      '.pdate{flex:0 0 92px;font-size:13px;font-weight:700;color:var(--sub);padding-top:2px;}',
      '.pitems{flex:1;display:flex;flex-direction:column;gap:8px;}',
      '.pitem{display:flex;align-items:center;gap:10px;font-size:14px;color:var(--text);'
      + 'background:var(--panel-2);border:1px solid var(--line);border-left:3px solid var(--sub);'
      + 'border-radius:8px;padding:8px 12px;flex-wrap:wrap;cursor:pointer;transition:background .15s,border-color .15s;}',
      '.pitem:hover{background:var(--panel);border-color:var(--midstream);}',
      '.pitem.hot{border-left-color:#e2554f;}',
      '.pitem.mid{border-left-color:#e0a93b;}',
      '.pitem.low{border-left-color:#5b9bd5;}',
      '.pstar{color:#e0a93b;font-size:13px;letter-spacing:1px;flex:0 0 auto;}',
      '.ptitle{flex:1;min-width:160px;}',
      '.psrc{font-size:11px;font-weight:700;padding:1px 7px;border-radius:9px;flex:0 0 auto;}',
      '.psrc.cls{color:#e0a93b;background:rgba(224,169,59,.14);}',
      '.psrc.em{color:#5b9bd5;background:rgba(91,155,213,.14);}',
      '.pcountry{font-size:12px;color:var(--sub);background:var(--panel);border:1px solid var(--line);'
      + 'border-radius:10px;padding:1px 8px;flex:0 0 auto;}',
      '.ptime{font-size:12px;color:var(--midstream,var(--text));font-weight:700;flex:0 0 auto;}',
      // 事件详情「相关新闻与公告」
      '.pd-news-list{display:flex;flex-direction:column;gap:10px;margin-top:8px;}',
      '.pd-ni{display:block;text-decoration:none;background:var(--panel-2);border:1px solid var(--line);'
      + 'border-radius:8px;padding:10px 12px;transition:background .15s,border-color .15s;}',
      '.pd-ni:hover{background:var(--panel);border-color:var(--midstream);}',
      '.pd-nk{display:inline-block;font-size:11px;font-weight:700;padding:1px 7px;border-radius:9px;margin-right:8px;vertical-align:middle;}',
      '.pd-nk.news{color:#5b9bd5;background:rgba(91,155,213,.14);}',
      '.pd-nk.ann{color:#e0a93b;background:rgba(224,169,59,.14);}',
      '.pd-nt{display:inline;font-size:14px;font-weight:700;color:var(--text);line-height:1.5;}',
      '.pd-nm{font-size:12px;color:var(--sub);margin-top:5px;}',
      '.pd-ns{font-size:12.5px;color:var(--sub);margin-top:4px;line-height:1.55;}',
      '.news-loading{font-size:13px;color:var(--sub);padding:8px 2px;}',
      '.news-src{font-size:12px;font-weight:600;color:var(--sub);}',
      // 子视图切换（事件日历 / 实时快讯）
      '.prophet-sub{display:flex;gap:8px;margin:6px 0 14px;}',
      '.prophet-sub .psub{font-size:13px;font-weight:700;padding:6px 16px;border-radius:10px;cursor:pointer;'
      + 'color:var(--sub);background:var(--panel-2);border:1px solid var(--line);transition:all .15s;}',
      '.prophet-sub .psub:hover{color:var(--text);border-color:var(--midstream);}',
      '.prophet-sub .psub.active{color:#fff;background:linear-gradient(135deg,#e0a93b,#d98b2b);border-color:transparent;}',
      '.prophet-content{min-height:300px;}',
      // 实时快讯
      '.flash-bar{display:flex;gap:8px;margin-bottom:14px;flex-wrap:wrap;}',
      '.flash-bar .fbtn{font-size:12.5px;font-weight:700;padding:5px 14px;border-radius:10px;cursor:pointer;'
      + 'color:var(--sub);background:var(--panel-2);border:1px solid var(--line);transition:all .15s;}',
      '.flash-bar .fbtn:hover{color:var(--text);border-color:var(--midstream);}',
      '.flash-bar .fbtn.active{color:#fff;background:linear-gradient(135deg,#3a7bd5,#2b5fb0);border-color:transparent;}',
      '.flash-list{display:flex;flex-direction:column;gap:10px;}',
      '.flash-item{background:var(--panel-2);border:1px solid var(--line);border-radius:10px;padding:11px 14px;'
      + 'border-left:3px solid var(--midstream);}',
      '.flash-item .f-meta{display:flex;align-items:center;gap:10px;margin-bottom:5px;flex-wrap:wrap;}',
      '.flash-item .f-src{font-size:11px;font-weight:700;padding:1px 8px;border-radius:9px;}',
      '.flash-item .f-src.wscn{color:#e0a93b;background:rgba(224,169,59,.14);}',
      '.flash-item .f-src.em{color:#5b9bd5;background:rgba(91,155,213,.14);}',
      '.flash-item .f-src.jin10{color:#c0504d;background:rgba(192,80,77,.14);}',
      '.flash-item .f-src.policy{color:#8e6fd8;background:rgba(142,111,216,.14);}',
      '.flash-item .f-src.commodity{color:#3f9d6d;background:rgba(63,157,109,.14);}',
      '.flash-item .f-time{font-size:12px;color:var(--sub);font-weight:600;}',
      '.flash-item .f-link{font-size:12px;color:#5b9bd5;text-decoration:none;font-weight:600;}',
      '.flash-item .f-link:hover{text-decoration:underline;}',
      '.flash-item .f-title{font-size:14.5px;font-weight:700;color:var(--text);line-height:1.5;}',
      '.flash-item .f-content{font-size:13px;color:var(--text);opacity:.86;line-height:1.6;margin-top:4px;}',
      '.flash-item .f-foot{margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;}',
      '.flash-item .f-tag,.flash-item .f-sym{font-size:11px;color:var(--sub);background:var(--panel);'
      + 'border:1px solid var(--line);border-radius:9px;padding:1px 8px;}',
    ].join('\n');
    var s = document.createElement('style');
    s.id = 'prophet-style';
    s.textContent = css;
    document.head.appendChild(s);
  }

  function ensureProphetShell(pv) {
    if (pv.querySelector('#prophetSub')) return;
    pv.innerHTML = ''
      + '<div id="prophetSub" class="prophet-sub">'
      +   '<button class="psub active" data-sub="cal">事件日历</button>'
      +   '<button class="psub" data-sub="news">新闻库</button>'
      + '</div>'
      + '<div id="prophetContent" class="prophet-content"></div>';
    Array.prototype.forEach.call(pv.querySelectorAll('#prophetSub .psub'), function (b) {
      b.addEventListener('click', function () {
        subView = b.dataset.sub;
        pv.querySelectorAll('#prophetSub .psub').forEach(function (x) { x.classList.toggle('active', x === b); });
        renderSub(pv);
      });
    });
  }

  function renderSub(pv) {
    var c = pv.querySelector('#prophetContent');
    if (!c) return;
    if (subView === 'news') {
      renderNews(pv, c);
    } else {
      c.innerHTML = '<div class="news-loading">加载事件日历…</div>';
      load(pv);
    }
  }

  function showProphet() {
    var app = document.getElementById('app');
    var pv = document.getElementById('prophetView');
    var fn = document.getElementById('floatNav');
    if (app) app.classList.add('hidden');
    if (fn) fn.classList.add('hidden');
    if (pv) { pv.classList.remove('hidden'); ensureProphetShell(pv); renderSub(pv); }
    var tab = document.getElementById('prophetTab');
    if (tab) tab.classList.add('active');
  }

  // ---------------- 新闻库（聚合所有抓取的新闻源） ----------------
  // 实时快讯类：华尔街见闻 / 东财 7×24 / 金十（items 带 ts 时间戳）
  // 列表类：政策公告（央行/证监会/国务院）/ 大宗商品（EIA/OPEC）（items 带 date/source）
  var NEWS_SRC = {
    wscn:      { label: '华尔街见闻', path: '/api/prophet/wscn',      cls: 'wscn' },
    emflash:   { label: '东财7×24',   path: '/api/prophet/emflash',   cls: 'em' },
    jin10:     { label: '金十',       path: '/api/prophet/jin10',     cls: 'jin10' },
    policy:    { label: '政策公告',   path: '/api/prophet/policy',    cls: 'policy' },
    commodity: { label: '大宗商品',   path: '/api/prophet/commodity', cls: 'commodity' }
  };
  var NEWS_ORDER = ['wscn', 'emflash', 'jin10', 'policy', 'commodity'];
  var newsCache = {};

  // ---------- 东财7×24 JSONP 直连（网页端兜底：不依赖 Worker） ----------
  // 利用东财 search-api-web JSONP 搜索最新财经要闻，模拟 7×24 快讯流
  function fetchEmFlashJsonp() {
    return new Promise(function (resolve) {
      var cb = '__emflash_' + Date.now();
      // 用多个宽泛关键词搜索财经新闻，取并集去重
      var keywords = ['A股', '美联储', '市场', '政策'];
      var all = [], done = 0, finished = false;
      function finish() { if (finished) return; finished = true; resolve(all); }
      keywords.forEach(function (kw, ki) {
        var inner = {
          uid: '', keyword: kw, type: ['cmsArticleWebOld'], client: 'web', clientType: 'web',
          clientVersion: 'curr', param: {}
        };
        inner.param.cmsArticleWebOld = {
          searchScope: 'default', sort: 'time', pageIndex: 1, pageSize: 15,
          preTag: '<em>', postTag: '</em>'
        };
        var url = 'https://search-api-web.eastmoney.com/search/jsonp?cb=' + cb + '_k' + ki
          + '&param=' + encodeURIComponent(JSON.stringify(inner));
        window[cb + '_k' + ki] = function (json) {
          try {
            var arr = ((json && json.result) || {}).cmsArticleWebOld || [];
            arr.forEach(function (it) {
              var title = (it.title || '').replace(/<[^>]+>/g, '');
              if (!title) return;
              var dateStr = (it.date || '').slice(0, 10);
              var ts = dateStr ? parseDateTs(dateStr + ' 12:00') : 0;
              // 去重（同一标题只保留一条）
              if (all.some(function (a) { return a.title === title; })) return;
              all.push({
                ts: ts,
                title: title,
                content: ((it.content || '').replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim().slice(0, 300),
                date: dateStr,
                url: it.url || '',
                tags: [kw],
                symbols: []
              });
            });
          } catch (e) {}
          done++;
          if (done >= keywords.length) finish();
        };
        var s = document.createElement('script');
        s.src = url;
        s.onerror = function () { done++; if (done >= keywords.length) finish(); };
        (document.head || document.body).appendChild(s);
      });
      setTimeout(function () { finish(); }, 12000);
    });
  }

  function parseDateTs(s) {
    if (!s) return 0;
    var t = Date.parse(String(s).replace(/-/g, '/'));
    return isNaN(t) ? 0 : t;
  }

  // 拉取单个新闻源并归一化为统一结构
  // 网页端优先尝试 JSONP 直连（绕过 Worker），失败再走 Worker 代理
  async function fetchNews(key) {
    var meta = NEWS_SRC[key];
    if (!meta) return [];

    // 网页端：emflash 优先走 JSONP 直连（东财 search-api-web 支持回调）
    if (!isLocal && key === 'emflash') {
      try {
        var items = await fetchEmFlashJsonp();
        if (items && items.length) {
          console.log('[Prophet] emflash via JSONP:', items.length, 'items');
          return items.map(function (it) {
            return { srcLabel: meta.label, srcCls: meta.cls, ts: it.ts || 0,
              timeText: it.ts ? fmtTs(it.ts) : (it.date || ''),
              title: it.title || '', content: (it.content && it.content !== it.title) ? it.content : '',
              url: it.url || '', tags: it.tags || [], symbols: it.symbols || [], extra: '' };
          });
        }
      } catch (e) {
        console.warn('[Prophet] emflash JSONP failed, fallback to Worker:', e);
      }
    }

    var url = pickURL(meta.path);
    if (!url) { console.warn('[Prophet] 未配置代理，无法拉取', key); return []; }
    try {
      var r = await fetch(url, { cache: 'no-store' });
      console.log('[Prophet] worker', key, 'status:', r.status);
      var j = await r.json();
      console.log('[Prophet] worker', key, 'keys:', j ? Object.keys(j).join(',') : 'null');
      var items = (j && Array.isArray(j.items)) ? j.items : [];
      return items.map(function (it) {
        var nativeTs = it.ts || 0;
        var ts = nativeTs || parseDateTs(it.date) || 0;
        return {
          srcLabel: meta.label,
          srcCls: meta.cls,
          ts: ts,
          timeText: nativeTs ? fmtTs(nativeTs) : (it.date || ''),
          title: it.title || '',
          content: (it.content && it.content !== it.title) ? it.content : '',
          url: it.url || '',
          tags: it.tags || [],
          symbols: it.symbols || [],
          extra: it.source || ''  // 政策/大宗的来源机构名
        };
      });
    } catch (e) {
      console.warn('[Prophet] news fetch failed', key, e);
      return [];
    }
  }

  function fmtTs(ts) {
    if (!ts) return '';
    try {
      var d = new Date(ts);
      var p = function (x) { return String(x).padStart(2, '0'); };
      return d.getFullYear() + '/' + p(d.getMonth() + 1) + '/' + p(d.getDate())
        + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    } catch (e) { return ''; }
  }

  function newsCardHTML(it) {
    var tags = (it.tags || []).map(function (t) { return '<span class="f-tag">' + escapeHtml(t) + '</span>'; }).join('');
    var syms = (it.symbols || []).map(function (s) { return '<span class="f-sym">' + escapeHtml(String(s)) + '</span>'; }).join('');
    var extra = it.extra ? '<span class="f-tag">' + escapeHtml(it.extra) + '</span>' : '';
    var link = it.url ? ' <a class="f-link" href="' + escapeHtml(it.url) + '" target="_blank" rel="noopener">原文↗</a>' : '';
    return '<div class="flash-item">'
      + '<div class="f-meta"><span class="f-src ' + it.srcCls + '">' + escapeHtml(it.srcLabel) + '</span>'
      + '<span class="f-time">' + escapeHtml(it.timeText || '') + '</span>' + link + '</div>'
      + '<div class="f-title">' + escapeHtml(it.title || '') + '</div>'
      + (it.content ? '<div class="f-content">' + escapeHtml(it.content) + '</div>' : '')
      + (tags || syms || extra ? '<div class="f-foot">' + extra + tags + syms + '</div>' : '')
      + '</div>';
  }

  function renderNews(pv, c) {
    var bar = '<div class="flash-bar"><button class="fbtn active" data-nsrc="all">全部</button>';
    NEWS_ORDER.forEach(function (k) {
      bar += '<button class="fbtn" data-nsrc="' + k + '">' + escapeHtml(NEWS_SRC[k].label) + '</button>';
    });
    bar += '</div>';
    c.innerHTML = '<div class="prophet-head">新闻库 · 全部抓取新闻聚合'
      + '<span class="plegend"><i class="lg em">华尔街见闻 / 东财 / 金十 / 政策 / 大宗</i></span></div>'
      + bar + '<div id="newsList" class="flash-list"><div class="news-loading">加载中…</div></div>';
    var list = c.querySelector('#newsList');
    Array.prototype.forEach.call(c.querySelectorAll('.flash-bar .fbtn'), function (b) {
      b.addEventListener('click', function () {
        c.querySelectorAll('.flash-bar .fbtn').forEach(function (x) { x.classList.toggle('active', x === b); });
        loadNews(b.dataset.nsrc, list);
      });
    });
    loadNews('all', list);
  }

  async function loadNews(filter, list) {
    if (!list) return;
    list.innerHTML = '<div class="news-loading">加载中…</div>';
    var keys = filter === 'all' ? NEWS_ORDER.slice() : [filter];
    var results;
    try {
      results = await Promise.all(keys.map(function (k) {
        if (newsCache[k]) return newsCache[k];
        return fetchNews(k).then(function (items) { newsCache[k] = items; return items; });
      }));
    } catch (e) {
      list.innerHTML = '<div class="news-loading">获取失败：' + escapeHtml((e && e.message) || e) + '</div>';
      return;
    }
    // 按源诊断（便于排查全空问题）
    var diag = [];
    keys.forEach(function (k, i) {
      var n = (results[i] || []).length;
      diag.push(NEWS_SRC[k].label + '(' + n + ')');
    });
    console.log('[Prophet] news source stats: ' + diag.join(', '));
    var all = [];
    results.forEach(function (items) { (items || []).forEach(function (it) { all.push(it); }); });
    all.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
    if (!all.length) {
      // 更详细的空结果提示：列出各源状态
      var detail = keys.map(function (k) { return NEWS_SRC[k].label; }).join(' / ');
      var tip = filter === 'jin10' ? '金十需配置 secret-key（见部署说明）' : ('以下源均无数据返回：' + detail + '。若持续为空，请检查 Worker 是否正常运行（' + (window.PROPHET_PROXY || '未配置') + '）');
      list.innerHTML = '<div class="news-loading">暂无可显示的新闻（' + tip + '）。</div>';
      return;
    }
    list.innerHTML = all.map(newsCardHTML).join('');
  }

  function showChain() {
    closeProphetDetail();
    var app = document.getElementById('app');
    var pv = document.getElementById('prophetView');
    var fn = document.getElementById('floatNav');
    if (app) app.classList.remove('hidden');
    if (fn) fn.classList.remove('hidden');
    if (pv) pv.classList.add('hidden');
    var tab = document.getElementById('prophetTab');
    if (tab) tab.classList.remove('active');
  }

  function wire() {
    injectStyle();
    ensureDetailModal();
    var tab = document.getElementById('prophetTab');
    if (tab) tab.addEventListener('click', function () {
      if (document.getElementById('prophetView') && !document.getElementById('prophetView').classList.contains('hidden')) {
        showChain();
      } else {
        showProphet();
      }
    });
    // 点击产业链任一细分按钮即切回产业链视图
    var subs = document.querySelectorAll('#indSubFilter button[data-ind]');
    Array.prototype.forEach.call(subs, function (b) {
      b.addEventListener('click', showChain);
    });
    // 事件条目点击 → 打开详情弹层
    var pv = document.getElementById('prophetView');
    if (pv) pv.addEventListener('click', function (e) {
      var it = e.target.closest('.pitem');
      if (it && it.dataset.uid) openProphetDetail(evMap[it.dataset.uid]);
    });
    // Esc 关闭事件详情
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var m = document.getElementById('prophetDetail');
        if (m && !m.classList.contains('hidden')) closeProphetDetail();
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', wire);
  } else {
    wire();
  }

  window.Prophet = { fetchCLS: fetchCLS, fetchEM: fetchEM, render: renderCalendar, load: load, renderNews: renderNews, loadNews: loadNews, showProphet: showProphet, showChain: showChain, openProphetDetail: openProphetDetail, closeProphetDetail: closeProphetDetail };
})();

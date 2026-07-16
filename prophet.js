/* 预言家栏目 · 前端客户端与渲染（事件日历 / 新闻库·7×24）
 * - fetchCLS(): 网页端 CORS 直连 cls.cn（access-control-allow-origin: *），本地端走同源 /api/prophet/cls
 * - renderCalendar(): 事件日历（未来30天）
 * - fetchNews(): 多源新闻聚合（华尔街见闻CORS / 东财7×24 JSONP）—— 对用户透明，不展示来源名
 * - 新闻库按话题筛选：全部实况 / 美伊冲突 / 俄乌战线 / 贸易壁垒（关键词过滤 title+content）
 * - 事件详情：每条事件可点击，弹出复用「个股窗口」CSS 模板的详情弹层（#prophetDetail），内容先做占位
 * - 视图切换：与顶部「产业链」导航并列，点击切换主视图
 * 归一化事件结构: {src:'cls',date,time,title,country,importance,cat}
 * 归一化新闻结构: {srcLabel,srcCls,ts,timeText,title,content,url,tags,symbols,extra}
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

  // 预言家子视图：'cal'=事件日历（财联社）  'news'=新闻库（聚合抓取新闻源）
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
  // 网页端：cls.cn 开放 CORS(access-control-allow-origin: *)，直接 fetch 无需 Worker
  // 本地端：走同源 /api/prophet/cls (server.py)
  async function fetchCLS() {
    // 本地模式：先尝试 server.py 代理（更快、有缓存），失败则 fallback 直连 CLS（CORS *）
    // file:// 协议下 server.py 未启动时也能工作
    if (isLocal) {
      var url = pickURL('/api/prophet/cls');
      try {
        var r = await fetchTimeout(url, { cache: 'no-store' }, 8000);
        var j = await r.json();
        if (j && Array.isArray(j.events) && j.events.length > 0) return j.events;
      } catch (e) {
        console.warn('[Prophet] cls local proxy failed, fallback to direct:', e);
      }
      // fallback: 直接连 CLS（CORS *，file:// / localhost 均可）
      try {
        return await fetchCLSDirect();
      } catch (e2) {
        console.warn('[Prophet] cls direct fallback also failed:', e2);
        return [];
      }
    }
    try {
      return await fetchCLSDirect();
    } catch (e) {
      console.warn('[Prophet] cls direct failed:', e);
      return [];
    }
  }

  // CLS 日历直连解析（网页端主路径 + 本地端 fallback 共用）
  async function fetchCLSDirect() {
    try {
      var r2 = await fetchTimeout('https://www.cls.cn/api/calendar/web/list', {
        cache: 'no-store', headers: { 'Accept': 'application/json' }
      }, 10000);
      if (!r2.ok) { console.warn('[Prophet] cls http', r2.status); return []; }
      var j2 = await r2.json();
      var days = Array.isArray(j2 && j2.data) ? j2.data : null;
      if (!days) return [];
      var out = [];
      days.forEach(function (day) {
        var d = (day.calendar_day || '').slice(0, 10);
        (day.items || []).forEach(function (it) {
          var ev = it.event || {};
          out.push({
            src: 'cls',
            date: d,
            time: (it.calendar_time || '').slice(11, 16) || '',
            title: it.title || ev.title || '',
            country: ev.country || '',
            importance: ev.star || 0,
            cat: it.type === 1 ? 'macro' : 'event'
          });
        });
      });
      return out;
    } catch (e) {
      console.warn('[Prophet] cls direct failed:', e);
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
        var r = await fetchTimeout(url, { cache: 'no-store' }, 8000);
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

  var SRC_LABEL = { cls: '财联社' };

  function renderCalendar(events, mount) {
    var el = mount || document.getElementById('prophetContent');
    if (!el) return;
    evMap = {};
    evSeq = 0;
    // 按来源统计
    var clsCount = (events || []).length;
    if (!events || !events.length) {
      el.innerHTML = '<div class="prophet-empty">事件日历暂不可用（网络异常或接口变更）。</div>';
      return;
    }
    var groups = groupByDate(events);
    var html = '<div class="prophet-head">事件日历（未来 30 天）'
      + '<span class="psrc-count">' + clsCount + ' 条</span></div>';
    groups.forEach(function (g) {
      html += '<div class="pday"><div class="pdate">' + escapeHtml(g.date) + '</div><div class="pitems">';
      g.items.slice().sort(function (a, b) {
        if ((b.importance | 0) !== (a.importance | 0)) return (b.importance | 0) - (a.importance | 0);
        return (a.src || '').localeCompare(b.src || '');
      }).forEach(function (it) {
        var uid = 'e' + (evSeq++);
        evMap[uid] = it;
        var imp = it.importance >= 4 ? 'hot' : (it.importance >= 3 ? 'mid' : 'low');
        html += '<div class="pitem ' + imp + '" data-uid="' + uid + '" title="点击查看事件详情"'
          + (it.importance ? '<span class="pstar">' + stars(it.importance) + '</span>' : '')
          + '<span class="ptitle">' + escapeHtml(it.title) + '</span>'
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

  // ==================== 事件智能分析引擎 ====================
  //
  // 核心思路：点击事件 → 多源拉取相关新闻 → 纯客户端文本分析
  //   1) 聚合所有新闻标题+摘要，生成结构化摘要（关键要点/多源佐证）
  //   2) 关键词匹配产业链赛道（AI半导体/商业航天/机器人/创新药）
  //   3) 从 PROFILES 提取个股名，文本匹配生成可点击个股标签
  //   4) 新闻列表紧凑滚动展示

  // ---- 产业链关键词映射 ----
  var CHAIN_KEYWORDS = {
    ai: {
      label: 'AI/半导体', key: 'ai', color: '#6366f1',
      words: ['AI','人工智能','大模型','GPT','LLM','算力','GPU','芯片','半导体','英伟达','NVIDIA',
        '晶圆','光刻','存储','HBM','DRAM','NAND','CPU','推理','训练','数据中心','智算中心',
        '服务器','台积电','中芯国际','寒武纪','海光信息','摩尔线程','壁仞科技','燧原科技',
        '华为昇腾','百度昆仑','阿里平头哥','腾讯芯片','CoWoS','先进封装','硅光','光模块',
        '液冷','CPO','PCB','铜缆','连接器','电源','变压器','HVDC','UPS','交换机','路由器',
        '云计算','云服务','微软','谷歌','亚马逊AWS','Meta','字节跳动','OpenAI','Anthropic',
        '机器学习','深度学习','神经网络','AIGC','生成式AI','具身智能','自动驾驶','智能驾驶',
        'EDA','IP核','FPGA','SoC','MCU','模拟芯片','功率器件','IGBT','碳化硅','氮化镓',
        '国产替代','自主可控','信创','数字经济','新质生产力','APEC','亚太','数字']
    },
    space: {
      label: '商业航天', key: 'space', color: '#f97316',
      words: ['航天','卫星','火箭','发射','低轨','轨道','星座','GPS','北斗','遥感','导航',
        'SpaceX','星链','星舰','马斯克',' reusable','可回收','运载火箭','长征','快舟',
        '商业航天','民营航天','蓝箭航天','星际荣耀','银河航天','国科工',
        '卫星互联网','高通量卫星','通信卫星','遥感卫星','对地观测',
        '太空站','空间站','载人航天','登月','探月','火星探测','深空探测',
        '固体燃料','液体燃料','发动机','推进器','姿控','测控','地面站',
        '卫星制造','整星','平台载荷','太阳能帆板','天线','相控阵',
        '在轨服务','碎片清理','太空垃圾','轨道资源','频谱资源','Ku/Ka/Q/V波段']
    },
    robot: {
      label: '机器人', key: 'robot', color: '#06b6d4',
      words: ['机器人','人形','协作','工业机器人','服务机器人','特种机器人',
        '伺服电机','减速器','谐波','RV','行星减速','直线电机','力矩传感器',
        '灵巧手','末端执行器','视觉系统','SLAM','路径规划','运动控制',
        '特斯拉','Optimus','figure','波士顿动力','宇树','小米','傅利叶','智元',
        '具身智能','强化学习','Sim2Real','世界模型','操作控制','双足','四足',
        'AGV','AMR','无人车','物流机器人','清洁机器人','手术机器人','康复机器人',
        '人机协作','安全围栏','示教','编程','数字孪生','仿真']
    },
    bio: {
      label: '创新药', key: 'bio', color: '#a855f7',
      words: ['创新药','ADC','GLP-1','靶点','临床','IND','NDA','FDA','NMPA','CDE',
        '生物药','单抗','双抗','CAR-T','细胞治疗','基因治疗','mRNA','疫苗','核酸药物',
        'PD-1','PD-L1','HER2','EGFR','ALK','BTK','CD20','CLL18','KRAS','TIGIT',
        '百济神州','恒瑞医药','信达生物','君实生物','荣昌生物','康方生物','和黄医药',
        '科伦博泰','翰森制药','中国生物制药','石药集团','先声药业','再鼎医药',
        'License-out','授权','里程碑付款',' royalties','出海','全球权益','联合疗法',
        '适应症','ORR','PFS','OS','DOR','客观缓解率','无进展生存期','总生存期',
        '一线','二线','三线','头对头','优效性','非劣效性',
        'CXO','CDMO','CRO','药明康德','药明生物','凯莱英','博腾股份','泰格医药',
        '医疗器械','高值耗材','IVD','诊断试剂','影像设备','内窥镜','手术机器人']
    },
    food: {
      label: '食品饮料', key: 'food', color: '#e11d48',
      words: ['食品饮料','白酒','啤酒','乳制品','调味品','酱油','醋','酵母','休闲食品','方便食品',
        '预制菜','速冻食品','烘焙','糖果','巧克力','软饮料','能量饮料','瓶装水','咖啡','茶',
        '贵州茅台','五粮液','泸州老窖','山西汾酒','洋河股份','古井贡酒','今世缘','青岛啤酒',
        '伊利股份','蒙牛','海天味业','中炬高新','千禾味业','涪陵榨菜','双汇发展','绝味食品',
        '消费','餐饮','零售','商超','便利店','外卖','社零','CPI','消费升级','下沉市场']
    },
    fin: {
      label: '非银券商', key: 'fin', color: '#2563eb',
      words: ['券商','证券','非银金融','保险','投行','IPO','再融资','并购','重组','资管',
        '财富管理','经纪业务','自营','融资融券','衍生品','期货','公募基金','私募基金','信托',
        '中信证券','华泰证券','国泰君安','海通证券','招商证券','广发证券','申万宏源','东方财富',
        '中国人寿','中国平安','中国太保','新华保险','香港交易所','港交所','中概股','港股通',
        '降息','加息','LPR','MLF','降准','货币政策','资本市场','注册制','互联互通']
    },
    silver: {
      label: '银发经济', key: 'silver', color: '#f59e0b',
      words: ['银发经济','养老','老龄化','适老化','医养结合','康养','护理','康复',' healthcare',
        '养老社区','养老院',' long-term care','临终关怀','健康管理','慢病',' Medicare','医保',
        '轮椅','助听器','老年手机','智能家居','老年教育','老年旅游','康养地产','护理保险',
        '养老机构','养老服务','护理员','护工','康复器械','医疗器械','医保支付','长期护理险']
    },
    equip: {
      label: '高端装备', key: 'equip', color: '#0d9488',
      words: ['高端装备','工业母机','数控机床','五轴联动','数控系统','伺服系统','主轴','刀具',
        '工业机器人','自动化','智能制造','数字孪生','工业互联网','工控','PLC','变频器',
        '机床','数控','磨床','车床','铣床','加工中心','激光加工','3D打印','增材制造',
        '航空装备','船舶装备','轨道交通','能源装备','海工装备','军民融合','军工','国防',
        '国产替代','自主可控','专精特新','高端制造','先进制造','精密制造']
    },
    lowsky: {
      label: '低空经济', key: 'lowsky', color: '#7c3aed',
      words: ['低空经济','低空飞行','eVTOL','飞行汽车','无人机','通航','通用航空','空域管理',
        '低空物流','低空旅游','城市空中交通','UAM','空中出租车','低空航线','起降场','垂直起降',
        '大疆','亿航','峰飞','时的','沃飞','万丰奥威','中直股份','航发动力','中航沈飞',
        '适航取证','民航局','空域开放','低空管制','低空监管','低空基础设施','低空运营']
    },
    hydrogen: {
      label: '氢能和核聚变能', key: 'hydrogen', color: '#0891b2',
      words: ['氢能','氢气','绿氢','灰氢','蓝氢','电解槽','燃料电池','氢燃料电池','储氢','加氢站',
        '氢能车','氢燃料电池车','氢能重卡','氢能船舶','氢能航空','氢氨醇','绿色甲醇','绿氨',
        '核聚变','可控核聚变','托卡马克','聚变堆','等离子体','氘','氚','氦3','第一壁','偏滤器',
        'ITER','人造太阳','聚变能源','清洁氢','低碳氢','氢储运','液氢','高压氢','管道氢',
        '氢能产业','燃料电池系统','电堆','双极板','质子交换膜','催化剂','碳中和']
    },
    metal: {
      label: '战略金属', key: 'metal', color: '#a16207',
      words: ['稀土','锂','钴','镍','铜','铝','锡','钨','钼','锑','铟','镓','锗','钽','铌','锆',
        '战略金属','关键矿产','稀有金属','贵金属','有色金属','小金属','能源金属','磁材',
        '稀土永磁','钕铁硼','镨钕','氧化镝','氧化铽','稀土开采','稀土冶炼','稀土分离',
        '锂矿','锂盐','碳酸锂','氢氧化锂','钴矿','镍矿','铜矿','铝土矿','锡矿','钨矿',
        '资源安全','矿产供应','出口管制','战略储备','新能源车材料','电池材料','永磁材料']
    }
  };

  // ---- 从全局 PROFILES 构建个股名称→代码映射 ----
  function buildStockNameMap() {
    var map = {}; // name_lower → {code, name}
    try {
      var profiles = (typeof window !== 'undefined' && window.PROFILES) || {};
      Object.keys(profiles).forEach(function (code) {
        var p = profiles[code];
        if (!p || !p.one_liner) return;
        // 从 one_liner 或 biz 中提取公司简称（通常第一个逗号前的部分）
        var name = '';
        if (p.one_liner) {
          var m = p.one_liner.match(/^([^，,（(]+)/);
          if (m) name = m[1].trim();
        }
        if (name && name.length >= 2) map[name.toLowerCase()] = { code: code, name: name };
      });
    } catch (e) { console.warn('[Prophet] buildStockNameMap error:', e); }
    return map;
  }

  // ---- 文本匹配：从文本中提取命中的产业链 ----
  function matchIndustries(text, priorIndustry) {
    var t = (text || '').toLowerCase();
    var hits = [];
    Object.keys(CHAIN_KEYWORDS).forEach(function (k) {
      var ci = CHAIN_KEYWORDS[k];
      var matchedWords = ci.words.filter(function (w) { return t.indexOf(w.toLowerCase()) !== -1; });
      if (matchedWords.length >= 1) { // 至少命中1个关键词即判定关联
        hits.push({ key: ci.key, label: ci.label, color: ci.color, words: matchedWords, note: '命中 ' + matchedWords.length + ' 个词' });
      }
    });
    // 按命中词数降序
    hits.sort(function (a, b) { return b.words.length - a.words.length; });
    // 先验行业命中时置顶（即使词数不占优）
    if (priorIndustry && priorIndustry.ind && CHAIN_KEYWORDS[priorIndustry.ind]) {
      var idx = -1;
      hits.forEach(function (h, i) { if (h.key === priorIndustry.ind) idx = i; });
      if (idx > 0) {
        var pi = hits.splice(idx, 1)[0];
        hits.unshift(pi);
      } else if (idx === -1) {
        var ch = CHAIN_KEYWORDS[priorIndustry.ind];
        hits.unshift({ key: ch.key, label: ch.label, color: ch.color, words: [], note: '先验推断' });
      }
    }
    return hits;
  }

  // ---- 文本匹配：提取提到的上市公司 ----
  function matchStocks(text, stockMap) {
    var t = text || '';
    var found = [];
    // 按名称长度降序优先匹配（避免短名误匹配长名的子串）
    var names = Object.keys(stockMap).sort(function (a, b) { return b.length - a.length; });
    names.forEach(function (nameLower) {
      if (t.indexOf(nameLower) !== -1) {
        found.push(stockMap[nameLower]);
      }
    });
    // 去重（同一 code 只保留一次）
    var seen = {};
    found = found.filter(function (s) { if (seen[s.code]) return false; seen[s.code] = true; return true; });
    return found.slice(0, 12); // 最多显示12个
  }

  // ---- 事件摘要生成：聚合新闻内容生成结构化要点 ----
  function generateEventSummary(ev, newsItems) {
    var parts = [];
    // 1. 事件本身描述
    parts.push({ type: 'ev', text: ev.title || '' });

    // 2. 从新闻中提取关键要点（去重、精炼）
    var points = [];
    var seenPoints = {};
    (newsItems || []).slice(0, 10).forEach(function (it) {
      var txt = (it.summary || it.title || '').trim();
      if (!txt || seenPoints[txt]) return;
      seenPoints[txt] = true;
      // 截取前120字作为要点
      if (txt.length > 120) txt = txt.slice(0, 117) + '…';
      points.push(txt);
    });

    // 3. 发酵度统计
    var srcSet = {};
    var dateList = [];
    (newsItems || []).forEach(function (it) {
      if (it.src) srcSet[it.src] = (srcSet[it.src] || 0) + 1;
      if (it.date) dateList.push(it.date);
    });

    return {
      title: ev.title || '',
      points: points,
      srcCount: Object.keys(srcSet).length,
      newsCount: (newsItems || []).length,
      sources: srcSet,
      dates: dateList,
      hasContent: points.length > 0
    };
  }

  // ==================== 事件详情弹层渲染 ====================

  function openProphetDetail(ev) {
    if (!ev) return;
    ensureDetailModal();
    var modal = document.getElementById('prophetDetail');
    var head = document.getElementById('pDetHead');
    head.querySelector('.nm').textContent = ev.title || '（无标题）';
    var metaParts = [];
    if (ev.country) metaParts.push(ev.country);
    if (ev.cat === 'macro') metaParts.push('宏观事件');
    head.querySelector('.meta').textContent = metaParts.join(' · ') || '财经事件';
    // 重要度标签
    var tags = document.getElementById('pDetTags');
    tags.innerHTML = (ev.importance ? '<span class="pl">重要性</span> <span class="ps">' + stars(ev.importance) + '</span>' : '');
    // 日期时间
    var px = document.getElementById('pDetPx');
    var dt = ev.date + (ev.time && ev.time !== '00:00' ? ' ' + ev.time : '');
    px.innerHTML = '<div class="p">' + escapeHtml(dt) + '</div><div class="pe">事件时间</div>';

    // 弹层正文：四区块（事件详情 / 关联产业链与个股 / 相关新闻紧凑滚动）
    var body = document.getElementById('pDetBody');
    body.innerHTML =
        '<div class="d-section" id="pdSummary"><h3>事件详情</h3>'
      +   '<div class="pd-summary-loading">正在分析事件…</div></div>'
      + '<div class="d-section" id="pdChain"><h3>关联产业链与个股</h3>'
      +   '<div class="d-note">正在匹配产业链与相关标的…</div></div>'
      + '<div class="d-section"><div class="d-sec-h">相关新闻与公告 <span class="news-src" id="pdNewsSrc">加载中</span></div>'
      +   '<div id="pdNews" class="pd-news-scroll"><div class="news-loading">正在获取…</div></div></div>';

    // 异步拉取新闻 → 分析 → 渲染全部区块
    loadProphetNewsAndAnalyze(ev);

    modal.classList.remove('hidden');
  }

  // ---- 核心：拉取新闻 + 智能分析 + 渲染三区块 ----
  function loadProphetNewsAndAnalyze(ev) {
    var kw = (ev && ev.title ? ev.title : '').trim();
    var summaryEl = document.getElementById('pdSummary');
    var chainEl = document.getElementById('pdChain');
    var newsBox = document.getElementById('pdNews');
    var srcLabel = document.getElementById('pdNewsSrc');

    // 1) 并行拉取：东财新闻 + 东财公告（各3页，JSONP直连）
    Promise.all([
      searchEMNews(kw, 'cmsArticleWebOld', 3),
      searchEMNews(kw, 'notice', 3)
    ]).then(function (res) {
      var allNews = mergeProphetNews(res[1], res[0], 30); // 合并去重，上限30条

      // 2) 生成事件摘要
      var summary = generateEventSummary(ev, allNews);

      // 3) 匹配产业链 & 个股
      var stockMap = buildStockNameMap();
      // 聚合所有新闻文本用于匹配
      var fullText = [ev.title];
      allNews.forEach(function (n) {
        fullText.push(n.title || '');
        fullText.push(n.summary || '');
      });
      var aggregateText = fullText.join(' ');
      var industries = matchIndustries(aggregateText);
      var stocks = matchStocks(aggregateText, stockMap);

      // 4) 渲染「事件详情」区块
      renderSummaryBlock(summaryEl, summary);

      // 5) 渲染「关联产业链与个股」区块
      renderChainBlock(chainEl, industries, stocks);

      // 6) 渲染「相关新闻」紧凑滚动列表
      renderCompactNews(newsBox, srcLabel, allNews, summary);

    }).catch(function (e) {
      if (summaryEl) summaryEl.querySelector('.pd-summary-loading')
        && (summaryEl.querySelector('.pd-summary-loading').textContent = '分析失败：' + escapeHtml((e && e.message) || e));
      if (newsBox) newsBox.innerHTML = '<div class="news-loading">获取失败</div>';
      if (srcLabel) srcLabel.textContent = '获取失败';
    });
  }

  // ---- 渲染：事件详情摘要 ----
  function renderSummaryBlock(el, s) {
    if (!el) return;
    var html = '';
    if (s.hasContent) {
      html += '<ul class="pd-summary-list">';
      s.points.forEach(function (pt) {
        html += '<li>' + escapeHtml(pt) + '</li>';
      });
      html += '</ul>';
      // 发酵度指示器
      if (s.newsCount > 0) {
        html += '<div class="pd-ferment">'
          + '<span class="pf-label">发酵度</span>'
          + '<span class="pf-badge">' + s.newsCount + '篇报道'
          + (s.srcCount > 0 ? ' · ' + s.srcCount + '个来源' : '')
          + '</span></div>';
      }
    } else {
      html += '<div class="d-note">暂无详细报道，该事件可能为预告型或刚发布。</div>';
    }
    // 替换 loading 占位
    var loading = el.querySelector('.pd-summary-loading');
    if (loading) { loading.outerHTML = html; }
  }

  // ---- 渲染：关联产业链 + 个股标签 ----
  function renderChainBlock(el, industries, stocks) {
    if (!el) return;
    var html = '';

    // 产业链标签
    if (industries.length > 0) {
      html += '<div class="pd-chain-tags">';
      industries.forEach(function (ind) {
        html += '<span class="pd-chain-tag" data-ind="' + ind.key + '" style="border-color:' + ind.color + ';color:' + ind.color + '" title="点击进入' + ind.label + '板块">'
          + escapeHtml(ind.label)
          + '</span>';
      });
      html += '</div>';
    } else {
      html += '<div class="d-note" style="font-size:12.5px;">未检测到明确的产业链关联（或该事件属宏观政策/市场层面）</div>';
    }

    // 个股标签
    if (stocks.length > 0) {
      html += '<div class="pd-stock-tags">';
      html += '<span class="pd-stock-label">提及个股</span>';
      stocks.forEach(function (st) {
        html += '<span class="pd-stock-tag" data-code="' + st.code + '" title="' + escapeHtml(st.name) + ' · 点击查看个股">'
          + escapeHtml(st.name)
          + '</span>';
      });
      html += '</div>';
    }

    el.innerHTML = '<h3>关联产业链与个股</h3>' + html;

    // 绑定点击事件：产业链标签 → 切到产业链对应赛道
    el.querySelectorAll('.pd-chain-tag[data-ind]').forEach(function (tag) {
      tag.addEventListener('click', function () {
        var indKey = tag.dataset.ind;
        closeProphetDetail();
        if (window.showChainTrack) window.showChainTrack(indKey);
        else if (window.setIndustry) window.setIndustry(indKey);
      });
    });

    // 绑定点击事件：个股标签 → 打开个股详情
    el.querySelectorAll('.pd-stock-tag[data-code]').forEach(function (tag) {
      tag.addEventListener('click', function () {
        var code = tag.dataset.code;
        closeProphetDetail();
        if (typeof openDetail === 'function') openDetail(code);
      });
    });
  }

  // ---- 渲染：紧凑滚动新闻列表 ----
  function renderCompactNews(box, srcLabel, items, summary) {
    if (srcLabel) {
      srcLabel.textContent = (summary && summary.newsCount ? summary.newsCount + '篇' : '') + ' 东方财富';
    }
    if (!box) return;

    if (!items || !items.length) {
      box.innerHTML = '<div class="news-loading">暂无相关报道</div>';
      return;
    }

    box.innerHTML = items.map(function (it) {
      var tag = it.kind === 'ann'
        ? '<span class="pd-nk ann">公告</span>'
        : '<span class="pd-nk news">报道</span>';
      var meta = [];
      if (it.sec) meta.push(escapeHtml(it.sec));
      if (it.date) meta.push(escapeHtml(it.date));
      var inner = tag
        + '<span class="pd-nt-c">' + escapeHtml(it.title) + '</span>'
        + (meta.length ? '<span class="pd-nm-c">' + meta.join(' · ') + '</span>' : '');
      if (it.url) {
        return '<a class="pd-ni-c" href="' + escapeHtml(it.url) + '" target="_blank" rel="noopener">' + inner + '</a>';
      }
      return '<div class="pd-ni-c">' + inner + '</div>';
    }).join('');
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

  async function load(pv) {
    var events = await fetchCLS();
    // 客户端安全过滤：丢弃今天之前开始的事件 + 宏观类型
    var todayStr = new Date().toISOString().slice(0, 10);
    events = events.filter(function (ev) { return ev.date >= todayStr && ev.cat !== 'macro'; });
    var c = pv ? pv.querySelector('#prophetContent') : document.getElementById('prophetContent');
    renderCalendar(events, c);
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
      // ===== 事件详情智能分析（新增） =====
      // 事件摘要列表
      '.pd-summary-list{margin:8px 0 0;padding-left:18px;}',
      '.pd-summary-list li{font-size:13.5px;color:var(--text);line-height:1.65;margin-bottom:6px;'
        + 'list-style-type:disc;list-style-position:outside;}',
      // 发酵度指示器
      '.pd-ferment{display:inline-flex;align-items:center;gap:8px;margin-top:10px;'
        + 'padding:5px 12px;background:var(--panel);border-radius:10px;border:1px solid var(--line);}',
      '.pf-label{font-size:11.5px;font-weight:700;color:var(--sub);text-transform:uppercase;letter-spacing:1px;}',
      '.pf-badge{font-size:12px;font-weight:600;color:var(--midstream,var(--text));}',
      // 关联产业链标签
      '.pd-chain-tags{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0;}',
      '.pd-chain-tag{font-size:13px;font-weight:700;padding:4px 14px;border-radius:20px;'
        + 'background:transparent;border:1.5px solid;cursor:pointer;transition:all .15s;}',
      '.pd-chain-tag:hover{background:currentColor;color:#fff !important;}',
      // 个股标签
      '.pd-stock-tags{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:10px;}',
      '.pd-stock-label{font-size:11.5px;font-weight:600;color:var(--sub);margin-right:4px;}',
      '.pd-stock-tag{font-size:12px;font-weight:600;padding:3px 10px;border-radius:14px;'
        + 'color:#c0504d;background:rgba(192,80,77,.10);border:1px solid rgba(192,80,77,.25);'
        + 'cursor:pointer;transition:all .15s;}',
      '.pd-stock-tag:hover{background:rgba(192,80,77,.22);border-color:rgba(192,80,77,.45);}',
      // 紧凑滚动新闻列表（替代旧版 pd-news-list）
      '.pd-news-scroll{display:flex;flex-direction:column;gap:4px;margin-top:8px;'
        + 'max-height:360px;overflow-y:auto;padding-right:4px;}'
        + '/* 滚动条美化 */'
        + '.pd-news-scroll::-webkit-scrollbar{width:5px;}'
        + '.pd-news-scroll::-webkit-scrollbar-track{background:transparent;}'
        + '.pd-news-scroll::-webkit-scrollbar-thumb{background:var(--line);border-radius:3px;}',
      '.pd-ni-c{display:block;text-decoration:none;padding:7px 10px;border-bottom:1px solid var(--line);'
        + 'transition:background .12s;}',
      '.pd-ni-c:last-child{border-bottom:none;}',
      '.pd-ni-c:hover{background:var(--panel);}',
      '.pd-ni-c .pd-nk{font-size:10.5px;font-weight:700;padding:1px 6px;border-radius:8px;margin-right:6px;vertical-align:baseline;}',
      '.pd-ni-c .pd-nt-c{font-size:13px;font-weight:600;color:var(--text);line-height:1.45;display:inline;}',
      '.pd-ni-c .pd-nm-c{font-size:11px;color:var(--sub);margin-left:8px;display:inline;}',
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
      +   '<button class="psub" data-sub="news">7×24</button>'
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
    if (window.setTopNav) window.setTopNav('prophet');
    if (typeof topView !== 'undefined') topView = 'prophet';
  }

  // ---------------- 新闻库（7×24 实时快讯，多源聚合 + 话题筛选） ----------------
  // 数据源：华尔街见闻(CORS直连) / 东财7×24(JSONP) —— 对用户透明，不展示来源名
  // 筛选维度：按话题关键词过滤（全部实况 / 美伊冲突 / 俄乌战线 / 贸易壁垒）
  var NEWS_SRC = {
    wscn:      { label: '华尔街见闻', path: '/api/prophet/wscn',      cls: 'wscn' },
    emflash:   { label: '东财7×24',   path: '/api/prophet/emflash',   cls: 'em' }
  };
  var NEWS_ORDER = ['wscn', 'emflash'];
  var newsCache = {};

  // 话题筛选配置：每个话题一组关键词，匹配新闻 title+content
  var NEWS_TOPICS = {
    all:       { label: '全部实照', keywords: [] },          // 空关键词 = 不过滤
    iran:      { label: '美伊冲突', keywords: ['伊朗','以色列','美伊','核设施','中东局势','霍尔木兹','德黑兰','特拉维夫','导弹袭击'] },
    ukraine:   { label: '俄乌战线', keywords: ['俄乌','乌克兰','俄罗斯','基辅','莫斯科','顿涅茨克','北约援乌','泽连斯基','普京','停火谈判','前线'] },
    trade:     { label: '贸易壁垒', keywords: ['关税','贸易战','出口管制','芯片禁令','制裁','反制','301条款','科技封锁','稀土','供应链脱钩','WTO','倾销调查'] }
  };
  var TOPIC_ORDER = ['all', 'iran', 'ukraine', 'trade'];

  // 带超时的 fetch 封装（防止网络不通时永久挂起）
  function fetchTimeout(url, opts, ms) {
    ms = ms || 10000;
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms);
    return fetch(url, Object.assign({}, opts || {}, { signal: ctrl.signal })).then(function (r) {
      clearTimeout(timer);
      return r;
    }).catch(function (e) {
      clearTimeout(timer);
      throw e;
    });
  }

  // ---------- 华尔街见闻 直连 ----------
  // 网页端：WSCN 开放 CORS（精确白名单 github.io 源）
  // 本地端：尝试直连（可能被 CORS 拒绝），失败后 fallback 到 server.py 代理
  function fetchWSCNDirect() {
    return new Promise(function (resolve) {
      var done = false;
      function finish(arr) { if (done) return; done = true; resolve(Array.isArray(arr) ? arr : []); }
      var api = 'https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=global&client=pc&cursor=0&limit=30';
      fetchTimeout(api, { cache: 'no-store', headers: { 'Accept': 'application/json' } }, 10000)
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var items = (j && j.data && Array.isArray(j.data.items)) ? j.data.items : [];
          var out = items.map(function (it) {
            var dt = Number(it.display_time) || 0;
            return {
              src: 'wscn',
              ts: dt * 1000,
              time: String(it.showTime || ''),
              title: String(it.title || it.content_text || '').replace(/<[^>]+>/g, '').trim(),
              content: String(it.content_text || '').replace(/<[^>]+>/g, '').trim(),
              tags: Array.isArray(it.tags) ? it.tags.map(function (t) { return (t && t.name) || t; }).filter(Boolean) : [],
              symbols: Array.isArray(it.symbols) ? it.symbols : [],
              url: it.uri || (it.article && it.article.uri) || ''
            };
          });
          finish(out);
        })
        .catch(function (e) { console.warn('[Prophet] wscn direct failed:', e); finish([]); });
      setTimeout(function () { finish([]); }, 12000);
    });
  }

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
  // 网页端走 JSONP/CORS 直连；本地端先尝试直连，失败 fallback 到 server.py 同源代理。
  // 注意：JSONP（<script>注入）与 CORS 无关 → emflash 在网页+本地两端均可用；
  //       wscn 受 CORS 精确白名单限制（仅放行 github.io），本地尝试直连→失败则走 server.py。
  // 所有 fetch 均带 AbortController 超时（8~10s），防止永久挂起。
  async function fetchNews(key) {
    var meta = NEWS_SRC[key];
    if (!meta) return [];

    // emflash：JSONP 直连（东财 search-api-web 支持回调）——网页与本地均可用
    if (key === 'emflash') {
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

    // wscn：网页端走 CORS 直连（精确白名单 github.io）；本地端也尝试直连，
    //       失败后 fallback 到 server.py 代理
    if (key === 'wscn') {
      try {
        var wItems = await fetchWSCNDirect();
        if (wItems && wItems.length) {
          console.log('[Prophet] wscn via direct:', wItems.length, 'items');
          return wItems.map(function (it) {
            return { srcLabel: meta.label, srcCls: meta.cls, ts: it.ts || 0,
              timeText: it.ts ? fmtTs(it.ts) : (it.date || ''),
              title: it.title || '', content: (it.content && it.content !== it.title) ? it.content : '',
              url: it.url || '', tags: it.tags || [], symbols: it.symbols || [], extra: '' };
          });
        }
      } catch (e) {
        console.warn('[Prophet] wscn direct failed, fallback to proxy:', e);
      }
    }

    var url = pickURL(meta.path);
    if (!url) { console.warn('[Prophet] 未配置代理，无法拉取', key); return []; }
    try {
      var r = await fetchTimeout(url, { cache: 'no-store' }, 8000);
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
      + '<div class="f-meta">'
      + '<span class="f-time">' + escapeHtml(it.timeText || '') + '</span>' + link + '</div>'
      + '<div class="f-title">' + escapeHtml(it.title || '') + '</div>'
      + (it.content ? '<div class="f-content">' + escapeHtml(it.content) + '</div>' : '')
      + (tags || syms || extra ? '<div class="f-foot">' + extra + tags + syms + '</div>' : '')
      + '</div>';
  }

  function renderNews(pv, c) {
    var bar = '<div class="flash-bar">';
    TOPIC_ORDER.forEach(function (t) {
      var topic = NEWS_TOPICS[t];
      var lbl = topic ? topic.label : t;
      bar += '<button class="fbtn' + (t === 'all' ? ' active' : '') + '" data-ntopic="' + t + '">' + escapeHtml(lbl) + '</button>';
    });
    bar += '</div>';
    c.innerHTML = '<div class="prophet-head">7×24</div>'
      + bar + '<div id="newsList" class="flash-list"><div class="news-loading">加载中…</div></div>';
    var list = c.querySelector('#newsList');
    Array.prototype.forEach.call(c.querySelectorAll('.flash-bar .fbtn'), function (b) {
      b.addEventListener('click', function () {
        c.querySelectorAll('.flash-bar .fbtn').forEach(function (x) { x.classList.toggle('active', x === b); });
        loadNews(b.dataset.ntopic, list);
      });
    });
    loadNews('all', list);
  }

  async function loadNews(topic, list) {
    if (!list) return;
    list.innerHTML = '<div class="news-loading">加载中…</div>';

    // 1) 先拉全量数据（所有源），仅首次拉取时缓存
    var allItems = [];
    try {
      var results = await Promise.all(NEWS_ORDER.map(function (k) {
        if (newsCache[k]) return newsCache[k];
        return fetchNews(k).then(function (items) { newsCache[k] = items; return items; });
      }));
      results.forEach(function (items) { (items || []).forEach(function (it) { allItems.push(it); }); });
      // 按时间倒序
      allItems.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
      window.__allNews = allItems; // 缓存全量供话题切换秒切
    } catch (e) {
      list.innerHTML = '<div class="news-loading">获取失败：' + escapeHtml((e && e.message) || e) + '</div>';
      return;
    }

    // 2) 话题关键词过滤
    var topicCfg = NEWS_TOPICS[topic];
    var kwList = (topicCfg && topicCfg.keywords) ? topicCfg.keywords : [];
    var filtered = allItems;
    if (kwList.length > 0) {
      filtered = allItems.filter(function (it) {
        var text = (it.title + ' ' + (it.content || '') + ' ' + (it.extra || '')).toLowerCase();
        return kwList.some(function (kw) { return text.indexOf(kw.toLowerCase()) !== -1; });
      });
    }

    // 诊断日志
    console.log('[Prophet] news total=' + allItems.length + ' topic=' + (topicCfg ? topicCfg.label : topic) + ' filtered=' + filtered.length);

    if (!filtered.length) {
      list.innerHTML = '<div class="news-loading">暂无可显示的新闻（' + escapeHtml((topicCfg && topicCfg.label) || topic) + '）。</div>';
      return;
    }
    list.innerHTML = filtered.map(newsCardHTML).join('');
  }

  function showChain() {
    closeProphetDetail();
    var app = document.getElementById('app');
    var pv = document.getElementById('prophetView');
    var fn = document.getElementById('floatNav');
    if (app) app.classList.remove('hidden');
    if (fn) fn.classList.remove('hidden');
    if (pv) pv.classList.add('hidden');
    if (window.setTopNav) window.setTopNav('chain');
    if (typeof topView !== 'undefined') topView = 'chain';
    // 恢复产业链子视图（主页总览 / 具体赛道详情）
    if (window.renderChain) window.renderChain();
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

  window.Prophet = { fetchCLS: fetchCLS, render: renderCalendar, load: load, renderNews: renderNews, loadNews: loadNews, showProphet: showProphet, showChain: showChain, openProphetDetail: openProphetDetail, closeProphetDetail: closeProphetDetail };
})();

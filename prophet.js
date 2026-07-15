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
        '国产替代','自主可控','信创','数字经济','新质生产力']
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
    }
  };


  // ---- 泛词黑名单：这些词太通用，作为独立搜索词会引入大量无关结果 ----
  // 分两级：
  //   A) 绝对泛词（停用词级别）：绝不搜、打分极低权重
  //   B) 宽行业词（如"人工智能""芯片"）：不单独搜（会引入整行业噪声），
  //      但打分时可作辅助确认实体（generic 权重）
  var GENERIC_TERMS = ['开源','全量','发布','上线','数据','报告','技术','发展',
    '建设','推动','促进','提升','加强','深化','完善','优化','加快','实施',
    '落实','推进','支持','保障','关于','对于','通过','进行','开展','工作',
    '研究','规划','方案','措施','意见','通知','说明','解读','分析','会议',
    '服务','平台','系统','产品','应用','项目','业务','能力','模式','生态',
    '创新','智能','数字','信息','网络','安全','管理','运营','合作','战略',
    '投资','融资','资本','市场','经济','产业','企业','公司','集团','股份',
    '中国','国内','全球','国际','年度','季度','月份','今日','近期','未来',
    // ---- 宽行业词（B级）：事件辅助确认用，但绝不单独搜索 ----
    '人工智能','大模型','芯片','半导体','新能源','光伏','风电','储能','锂电',
    '医药','创新药','医疗器械','机器人','人形机器人','具身智能','电动车','新能源汽车',
    '房地产','楼市','券商','证券','银行','保险','非银','金融','消费','零售',
    '白酒','食品饮料','旅游','免税','商业航天','卫星','低空经济','低空','eVTOL',
    'CPI','PPI','GDP','PMI','社融','M2','降息','加息','LPR','MLF',
    '科创板','北交所','注册制','IPO','再融资','美联储','央行','发改委','工信部',
    'GPT','LLM','AIGC','生成式','算力','GPU','光刻机','存储器'];

  // ---- 实体提取：从事件标题中提取核心实体用于精准检索 ----
  // 返回 { core, full, short, known, distinctive, generic }
  //   distinctive = 高特异性词（不在泛词黑名单中，指向性强的实体）
  //   generic     = 泛词（出现频率高、单独搜索会引入噪声的词）
  function extractEventEntities(title) {
    var t = (title || '').trim();
    if (!t) return { core: [], full: t, short: t, known: [], distinctive: [], generic: [] };
    // 常见事件模式匹配
    var entities = [];
    var known = [];
    // 1. 中文引号/书名号内的名称：《xxx》或"xxx"
    var quoted = t.match(/[\u300A\u300B\u201C\u201D]([^\u300A\u300B\u201C\u201D]{2,20})[\u300A\u300B\u201C\u201D]/g);
    if (quoted) quoted.forEach(function(q) { entities.push(q.replace(/[\u300A\u300B\u201C\u201D]/g, '')); });
    // 2. 已知技术名词/产品名（高频实体库）
    var techPatterns = [
      /(?:星闪|OpenHarmony|鸿蒙|HarmonyOS|NearLink|SparkLink|SLE|SLB|协议栈)/g,
      /(?:人工智能|AI拟人化|互动服务|管理办法|暂行办法)/g,
      /(?:GPT|LLM|大模型|算力|GPU|芯片|半导体|光刻机|存储器)/g,
      /(?:商业航天|卫星|火箭|发射|低空经济|eVTOL|无人机)/g,
      /(?:机器人|人形机器人|具身智能|伺服电机|减速器)/g,
      /(?:创新药|ADC|GLP-1|临床试验|IND|NDA|FDA)/g,
      /(?:CPI|PPI|GDP|PMI|社融|M2|降息|加息|LPR|MLF)/g,
      /(?:科创板|北交所|注册制|IPO|再融资|减持|回购|增持)/g,
      /(?:美联储|欧央行|日本央行|央行|国新办|发改委|工信部)/g,
      /(?:华为|百度|阿里|腾讯|字节|小米|苹果|英伟达|特斯拉)/g,
      /(?:宁德时代|比亚迪|贵州茅台|工商银行|中国石油)/g,
      /(?:半导体设备|晶圆代工|光模块|PCB|CPO|液冷)/g,
      /(?:碳达峰|碳中和|新能源|光伏|风电|储能|锂电)/g,
      /(?:房地产|房贷|限购|首付|公积金|保交楼)/g,
      /(?:医保|集采|DRG[\/]DIP|创新药|医疗器械)/g
    ];
    techPatterns.forEach(function(pat) { var m; while ((m = pat.exec(t)) !== null) { if (entities.indexOf(m[0]) === -1) { entities.push(m[0]); known.push(m[0]); } } });
    // 3. 长中文词组（3-8字的连续中文，排除常见虚词）
    var longCn = t.match(/[\u4e00-\u9fa5]{3,8}/g);
    if (longCn) longCn.forEach(function(w) {
      var skipWords = ['关于','对于','根据','按照','通过','经过','以及','或者',
        '如果','因为','所以','但是','然而','因此','其中','之后','之前','期间',
        '办法','规定','通知','公告','报告','会议','发布会','说明','解读'];
      if (skipWords.indexOf(w) === -1 && entities.indexOf(w) === -1) entities.push(w);
    });
    // 核心实体 = 引号内 + 技术名词（最精准）
    var core = entities.filter(function(e) { return e.length >= 2; });
    // 短检索词：取前2个最长实体（若标题>15字则截断）
    var shortKw = t.length > 18 ? (core.length >= 2 ? core.slice(0, 2).join(' ') : core[0] || t.slice(0, 12)) : t;
    // ---- 实体分级：distinctive（高特异）vs generic（泛词）----
    var distinctive = [], generic = [];
    var genSet = {};
    GENERIC_TERMS.forEach(function(g){ genSet[g] = 1; });
    core.forEach(function(e){
      if (genSet[e]) generic.push(e);
      else distinctive.push(e);
    });
    return { core: core, full: t, short: shortKw, known: known, distinctive: distinctive, generic: generic };
  }


  // ---- 多维相关性打分：评估单条新闻与目标事件的相关度（V7：标志性实体硬门槛）----
  // 返回 { score: 0~1, reasons: string[], level: 'high'|'mid'|'low'|'none' }
  // 核心改进：
  //   - 实体分两级：distinctive(高特异) vs generic(泛词)
  //   - 硬门槛：不含任何 distinctive 实体的新闻 → score 封顶 0.12（最高 mid）
  //   - Dim B 英文子串修复：跳过纯 ASCII <4 字符的子串（避免 "OpenHarmony"→"open" 命中 OpenAI）
  function scoreRelevance(newsItem, evTitle, entities) {
    var title = (newsItem.title || '').toLowerCase();
    var content = (newsItem.summary || newsItem.content || '').toLowerCase();
    var combined = title + ' ' + content;
    var evLower = (evTitle || '').toLowerCase();
    var score = 0;
    var reasons = [];
    var distinctList = (entities && entities.distinctive) || [];
    var genericList = (entities && entities.generic) || [];

    // ════════════════════════════════════════
    // 维度A：标题是否包含事件核心实体（权重 0~0.54）
    //   distinctive hit = 0.15 each (cap 0.45) —— 高特异实体命中权重大
    //   generic hit     = 0.03 each (cap 0.09) —— 泛词命中权重低
    // ════════════════════════════════════════
    var distHitCount = 0;
    distinctList.forEach(function(ent) {
      var el = ent.toLowerCase();
      if (title.indexOf(el) !== -1) { distHitCount++; reasons.push('标志性:' + ent); }
    });
    if (distHitCount > 0) score += Math.min(distHitCount * 0.15, 0.45);

    var genHitCount = 0;
    genericList.forEach(function(ent) {
      var el = ent.toLowerCase();
      if (title.indexOf(el) !== -1) { genHitCount++; reasons.push('泛词:' + ent); }
    });
    if (genHitCount > 0) score += Math.min(genHitCount * 0.03, 0.09);

    // ════════════════════════════════════════
    // 维度B：标题是否包含事件本身的关键片段（权重 0~0.20）
    //   取事件标题的 3~6 字片段做模糊匹配
    //   【V7修复】跳过纯 ASCII 且长度<4 的子串（防止 "Open" 命中 OpenAI 等）
    // ════════════════════════════════════════
    var evSegments = [];
    for (var sl = 6; sl >= 3; sl--) {  // 最短3字符（V7：不再取2字符片段）
      for (var si = 0; si <= evLower.length - sl; si++) {
        var seg = evLower.slice(si, si + sl);
        if (seg.replace(/\s/g, '').length >= sl) {
          // V7：跳过纯英文ASCII子串（长度>=3但全是字母的，如 "ope"/"pen"/"nHa"）
          if (!/^[a-zA-Z]+$/.test(seg)) evSegments.push(seg);
        }
      }
    }
    var segHits = 0;
    evSegments.some(function(seg) {
      if (seg.length < 3) return false;
      if (title.indexOf(seg) !== -1) { segHits++; reasons.push('标题命中:' + seg); }
      return segHits >= 3; // 最多计3个
    });
    score += Math.min(segHits * 0.06, 0.20);

    // ════════════════════════════════════════
    // 维度C：正文实体密度（权重 0~0.16）
    //   只计算 distinctive 实体的正文补充（泛词正文出现太普遍无区分度）
    // ════════════════════════════════════════
    var bodyDistHits = 0;
    distinctList.forEach(function(ent) {
      if (combined.indexOf(ent.toLowerCase()) !== -1) bodyDistHits++;
    });
    if (bodyDistHits > distHitCount) {
      score += Math.min((bodyDistHits - distHitCount) * 0.04, 0.16);
      reasons.push('正文标志性');
    }

    // ════════════════════════════════════════
    // ★★★ V7 硬门槛：不含任何 distinctive 实体 → 封顶 0.12 ★★★
    // ════════════════════════════════════════
    if (distHitCount === 0 && bodyDistHits === 0) {
      score = Math.min(score, 0.12);
      reasons.push('无标志性实体[封顶]');
    }

    // 维度D：时间新鲜度奖励（权重 0~0.08，7天内线性递减）
    if (newsItem.date) {
      var nd = new Date(newsItem.date + 'T00:00:00');
      var now = new Date(); now.setHours(0,0,0,0);
      var daysDiff = Math.floor((now - nd) / 86400000);
      if (daysDiff >= 0 && daysDiff <= 7) {
        score += 0.08 * (1 - daysDiff / 7);
        reasons.push('时效性+' + Math.round(8*(1-daysDiff/7)) + '%');
      }
    }

    // ---- 惩罚项（乘法衰减）----

    // P1: 泛市场快讯惩罚（标题只包含大盘/指数类泛词而无具体实体）
    var genericMarket = /^(?:大盘|沪指|深指|创业板|美股|港股|A股|三大股指|欧洲股市|亚太股市|收涨|收跌|震荡|反弹|跳水|拉升|V型)/;
    if (genericMarket.test(title) && distHitCount === 0) {
      score *= 0.08;
      reasons.push('惩罚:泛市场快讯');
    }

    // P2: 个股业绩预告惩罚（除非事件本身就是某公司财报）
    var earningsPattern = /(?:预告|业绩|营收|净利润|同比|环比|EPS|TTM).*?(?:增长|下降|预增|预减|扭亏|亏损)/;
    if (earningsPattern.test(title) && distHitCount === 0) {
      score *= 0.12;
      reasons.push('惩罚:无关业绩预告');
    }

    // P3: 纯行情数据流（无任何实质内容）
    if (/^\d+\.\d+%/.test(title) || /^涨\d+|跌\d+|收\d+/.test(title)) {
      if (distHitCount === 0) { score *= 0.05; reasons.push('惩罚:纯行情数字'); }
    }

    // P4: >30天旧闻轻微惩罚
    if (newsItem.date) {
      var oldNd = new Date(newsItem.date + 'T00:00:00');
      var oldDiff = Math.floor((new Date() - oldNd) / 86400000);
      if (oldDiff > 30) { score *= Math.max(0.3, 1 - (oldDiff - 30) / 90); reasons.push('旧闻衰减'); }
    }

    score = Math.max(0, Math.min(1, score));

    // 分级阈值（V7 提高：要求真正的标志性实体命中才能到 high）
    var level = 'none';
    if (score >= 0.20 && distHitCount > 0) level = 'high';   // V7: high 要求有标志性命中
    else if (score >= 0.10) level = 'mid';
    else if (score >= 0.03) level = 'low';

    return { score: Math.round(score * 1000) / 1000, reasons: reasons, level: level,
             entityHits: distHitCount + genHitCount, bodyHits: bodyDistHits,
             distHits: distHitCount, genHits: genHitCount };
  }


  // ---- 事件类型 → 产业链先验映射（基于标题关键词推断候选产业链） ----

  // ---- 从文本抽取「关键事实」用于多源交叉验证 ----
  function extractFacts(text) {
    var t = (text || '').replace(/<[^>]+>/g, '');
    var facts = [];
    // 数字+单位
    var numRe = /\d+(?:\.\d+)?\s*(?:万行|亿行|万|亿|倍|%|小时|天|年|个月|μs|毫秒|ms|公里|亿元|万元)/g;
    var m; while ((m = numRe.exec(t)) !== null) facts.push(m[0].replace(/\s/g, ''));
    // 日期
    var dateRe = /(?:20\d{2}年)?\d{1,2}月\d{1,2}日/g;
    while ((m = dateRe.exec(t)) !== null) facts.push(m[0]);
    // 已知专有名词
    var nouns = ['OpenHarmony','开源鸿蒙','鸿蒙','星闪','NearLink','蓝牙','WiFi','Wi-Fi','SLE','SLB','双模','物理层','应用层','协议栈','无芯片绑定','无授权费','标准库','OpenHarmony社区'];
    nouns.forEach(function(n){ if (t.indexOf(n) !== -1) facts.push(n); });
    var seen = {}; return facts.filter(function(f){ if(seen[f]) return false; seen[f]=true; return true; });
  }
  // ---- 多源交叉验证：核心报道的关键事实，被多少其他高相关源印证 ----
  function crossValidate(coreItem, others) {
    if (!coreItem) return null;
    var coreText = (coreItem.title || '') + ' ' + (coreItem.summary || coreItem.content || '');
    var facts = extractFacts(coreText);
    var srcSet = {};
    (others || []).forEach(function(o){ if (o.item && o.item.src) srcSet[o.item.src] = 1; });
    var corroborated = [];
    facts.forEach(function(f){
      var cnt = 0;
      (others || []).forEach(function(o){
        var ot = (o.item.title || '') + ' ' + (o.item.summary || o.item.content || '');
        if (ot.indexOf(f) !== -1) cnt++;
      });
      if (cnt >= 1) corroborated.push(f); // 至少另1源印证
    });
    return { facts: facts, corroborated: corroborated, sources: Object.keys(srcSet).length };
  }

  // ---- 事件类型 → 产业链先验映射（基于标题关键词推断候选产业链） ----

  var EVENT_INDUSTRY_MAP = [
    { keys: ['星闪','OpenHarmony','鸿蒙','开源','协议栈','HarmonyOS','开源鸿蒙'],          ind: 'ai',   reason: '鸿蒙/星闪生态' },
    { keys: ['人工智能','AI拟人化','大模型','GPT','生成式','AIGC','深度合成','算法推荐'],       ind: 'ai',   reason: 'AI技术政策' },
    { keys: ['算力','GPU','芯片','半导体','光刻','晶圆','HBM','存储','CoWoS','先进封装'],     ind: 'ai',   reason: '半导体硬件' },
    { keys: ['航天','卫星','发射','轨道','星座','SpaceX','星链','探月','载人航天','运载火箭'],ind: 'space', reason: '航天产业' },
    { keys: ['机器人','人形','具身智能','伺服','减速器','灵巧手','协作机器人'],                ind: 'robot', reason: '机器人产业' },
    { keys: ['创新药','ADC','GLP-1','临床','FDA','NMPA','CDE','PD-1','CAR-T','mRNA','疫苗'], ind: 'bio',   reason: '医药生物' },
    { keys: ['医药','医疗','医保','集采','DRG','创新药','医疗器械'],                          ind: 'bio',   reason: '医疗健康' },
    { keys: ['低空','无人机','eVTOL','飞行汽车','通航','低空经济'],                            ind: 'ai',   reason: '低空经济' },  // 归入AI(高端装备)
    { keys: ['新能源汽车','电动车','电池','锂电','固态电池','充电桩','智能驾驶','自动驾驶'], ind: 'ai',   reason: '新能源车' },
    { keys: ['光伏','风电','储能','硅料','组件','逆变器','碳中和','碳达峰','新能源'],         ind: 'ai',   reason: '新能源' },
    { keys: ['房地产','楼市','房贷','首付','公积金','保交楼','房企','商品房'],               ind: 'ai',   reason: '地产' },  // 宏观归默认
    { keys: ['消费','零售','社零','餐饮','旅游','免税','白酒','食品饮料'],                     ind: 'ai',   reason: '消费' },
    { keys: ['券商','证券','非银','保险','银行','金融','LPR','利率','降息','加息','MLF'],     ind: 'ai',   reason: '金融' },
    { keys: ['CPI','PPI','GDP','PMI','社融','M2','宏观经济','国民经济','统计局','数据发布'],    ind: 'ai',   reason: '宏观数据' }
  ];
  function inferIndustryFromTitle(title) {
    var t = (title || '').toLowerCase();
    var best = null, bestMatch = 0;
    EVENT_INDUSTRY_MAP.forEach(function(rule) {
      var hit = 0;
      rule.keys.some(function(k) { if (t.indexOf(k.toLowerCase()) !== -1) { hit++; return hit >= 2; } });
      if (hit > bestMatch) { bestMatch = hit; best = rule; }
    });
    return best;
  }

  // ---- 个股识别：复用顶部搜索框的 emSuggest（东财全市场实时搜索） ----
  // 原则：不维护任何本地公司名库/别名映射。用户搜索框输入"阿斯麦"→返回 usASML；
  // "长鑫科技"→返回 sh688825。同理这里从事件文本抽候选词 → 逐个问 emSuggest → 命中就收录。
  function resolveCompaniesViaSearch(text, cb) {
    cb = cb || function(){};
    var t = text || '';
    if (!t || typeof emSuggest !== 'function') { cb([]); return; }

    var candidates = {};
    var seenLower = {};

    function addCand(word) {
      var k = word.toLowerCase();
      if (k.length < 2 || seenLower[k]) return;
      seenLower[k] = true;
      candidates[word] = true;
    }

    // 1) 中文候选：严格公司全称后缀（最可靠）
    ['股份有限公司','集团有限公司','有限责任公司','集团股份有限公司','控股有限公司'].forEach(function(suf) {
      try {
        var re = new RegExp('([\u4e00-\u9fa5]{2,6})' + suf, 'g');
        var m;
        while ((m = re.exec(t)) !== null) { addCand(m[1]); }
      } catch(e){}
    });

    // 2) 英文候选：大写开头的英文单词/缩写
    var engMatches = t.match(/\b[A-Z][A-Za-z0-9]{1,15}\b/g);
    if (engMatches) engMatches.forEach(function(w) {
      if (w.length >= 2 && w.length <= 15 &&
          !/^(The|A|An|In|On|At|To|For|Of|By|With|From|Is|Are|Was|Were|Be|It|This|That|These|Those|And|Or|But|Not|No|Yes|We|They|He|She|Its|Their|Our|Your|His|Her|My|I|Me|Us|All|Any|Each|Every|Some|More|Most|Such|Which|Who|What|When|Where|Why|How|Can|Could|Would|Should|May|Might|Will|Shall|Did|Do|Does|Has|Have|Had|If|Then|Else|Than|Also|Just|Only|Even|Still|Yet|Already|Always|Never|Often|Once|Here|There|Now|Today|Tomorrow|Yesterday|Please|Thank|Best|New|Old|Good|Bad|Big|Small|Long|Short|High|Low|First|Last|Next|Other|Another|Same|Different|Many|Much|Few|Little|Less|Own|Both|Fewer|Half|Double|Whole|Full|Empty|Open|Close|Free|True|False|Real|Right|Wrong|Sure|Clear|Safe|Easy|Hard|Fast|Slow|Early|Late|Over|Under|Above|Below|Around|Through|Across|Along|Into|Onto|Upon|Within|Without|Before|After|During|Since|Until|About|Against|Between|Among|Behind|Beyond|Inside|Outside|Up|Down|Off|Out|Back|Away|Near|Far|Apart|Aside|Together|Again|Once)$/.test(w)) {
        addCand(w);
      }
    });

    // 3) 短中文候选（2-6字，跳过纯虚词/泛词）
    var cnMatches = t.match(/[\u4e00-\u9fa5]{2,6}/g);
    if (cnMatches) cnMatches.forEach(function(w) {
      if (/^(关于|对于|根据|按照|通过|进行|开展|工作|研究|规划|方案|措施|意见|通知|说明|解读|分析|会议|服务|平台|系统|产品|应用|项目|业务|能力|模式|生态|创新|智能|数字|信息|网络|安全|管理|运营|合作|战略|投资|融资|资本|市场|经济|产业|企业|公司|集团|股份|中国|国内|全球|国际|年度|季度|月份|今日|近期|未来|上述|其中|之后|之前|期间|相关|有关|涉及|包括|正式|后续|初始|最终|初步|完成|结束|开始|启动|业内|板块|概念|题材|指数|成分|发行|公告|披露|招股|申购|缴款|上市|挂牌|战略|询价|定价|募集|路演|审核|核准|注册|备案|登记|托管|超额|配售|选择权|行权|网上|网下|摇号|中签)$/.test(w)) return;
      addCand(w);
    });

    var candList = Object.keys(candidates).slice(0, 12);
    if (!candList.length) { cb([]); return; }

    var out = {};
    var pending = candList.length;
    var done = false;
    var gto = setTimeout(function () {
      if (!done) { done = true; pending = 0; cb(Object.keys(out).map(function(k){ return out[k]; })); }
    }, 8000);

    function finish() {
      pending--;
      if (pending <= 0 && !done) { clearTimeout(gto); done = true; cb(Object.keys(out).map(function(k){ return out[k]; })); }
    }

    candList.forEach(function(q) {
      try {
        emSuggest(q, function(arr) {
          if (arr && arr.length && arr[0] && arr[0].code) {
            var best = arr[0];
            out[best.code] = { code: best.code, name: best.name || q };
          }
          finish();
        });
      } catch(e) { finish(); }
    });
  }
  // ---- 事件摘要生成：聚焦事件本体的报道（V5增强版） ----
  // 只使用高相关度(high+mid)的新闻来构建事件详情，低相关度的扔到"延伸阅读"
  function generateEventSummary(ev, newsItems, scoredItems, coreReport) {
    // 1. 高相关新闻(high+mid)作为事件本体报道；核心报道置顶
    var relevant = (scoredItems || []).filter(function(s) { return s.level === 'high' || s.level === 'mid'; });
    var points = [];
    var seenText = {};
    function pushPt(it, core) {
      var txt = (it.summary || it.content || it.title || '').trim();
      if (!txt || seenText[txt]) return;
      seenText[txt] = true;
      if (txt.length > 160) txt = txt.slice(0, 157) + '…';
      points.push({ txt: txt, core: !!core });
    }
    if (coreReport && coreReport.item) pushPt(coreReport.item, true);
    relevant.forEach(function(si) { if (si !== coreReport) pushPt(si.item, false); });

    // 2. 发酵度统计（基于全部结果）
    var srcSet = {}, highCount = 0, midCount = 0, lowCount = 0;
    (scoredItems || []).forEach(function(si) {
      if (si.item.src) srcSet[si.item.src] = (srcSet[si.item.src] || 0) + 1;
      if (si.level === 'high') highCount++;
      else if (si.level === 'mid') midCount++;
      else if (si.level === 'low') lowCount++;
    });

    return {
      title: ev.title || '',
      points: points,
      coreTitle: (coreReport && coreReport.item) ? (coreReport.item.title || '') : '',
      coreSrc: (coreReport && coreReport.item) ? (coreReport.item.src || '') : '',
      noCore: points.length === 0,
      srcCount: Object.keys(srcSet).length,
      newsCount: (newsItems || []).length,
      sources: srcSet,
      highCount: highCount,
      midCount: midCount,
      lowCount: lowCount,
      hasContent: points.length > 0,
      relevantCount: relevant.length
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

    // 弹层正文：两区块（事件详情 / 关联产业链与个股）
    var body = document.getElementById('pDetBody');
    body.innerHTML =
        '<div class="d-section" id="pdSummary"><h3>事件详情</h3>'
      +   '<div class="pd-summary-loading">正在分析事件…</div></div>'
      + '<div class="d-section" id="pdChain"><h3>关联产业链与个股</h3>'
      +   '<div class="d-note">正在匹配产业链与相关标的…</div></div>';

    // 异步拉取新闻 → 分析 → 渲染全部区块
    loadProphetNewsAndAnalyze(ev);

    modal.classList.remove('hidden');
  }

  // ---- 核心：拉取新闻 + 相关性打分 + 智能分析 + 渲染两区块（V7：泛词过滤+公告控制） ----
  function loadProphetNewsAndAnalyze(ev) {
    var kw = (ev && ev.title ? ev.title : '').trim();
    var summaryEl = document.getElementById('pdSummary');
    var chainEl = document.getElementById('pdChain');

    // 0) 提取事件核心实体（含 distinctive/generic 分级）
    var entities = extractEventEntities(kw);
    // 事件类型先验（用于产业链推断偏置）
    var priorIndustry = inferIndustryFromTitle(kw);

    // 1) 并行拉取：「高质量关键词精准检索」（V7：泛词不搜、公告受控）
    //    原则：
    //    a) 只用 distinctive（高特异）术语作为搜索词，generic 泒词绝不单独查
    //    b) 整条标题超20字时截断或不用（东财长查询匹配差）
    //    c) notice（公告）仅对"像公司名/股票代码"的词发起，泛词不搜公告
    var queryTerms = [];
    function addQ(k) { if (k && queryTerms.indexOf(k) === -1) queryTerms.push(k); }
    // ★ distinctive 术语优先（这些是真正能定位到事件的词）
    (entities.distinctive || []).forEach(function (e) {
      if (e.length >= 2 && e.length <= 10) addQ(e);
    });
    // 如果 distinctive 太少，从 core 里补（但仍跳过泛词）
    if (queryTerms.length < 2) {
      entities.core.forEach(function (e) {
        if (e && e.length >= 2 && e.length <= 8) {
          var isGeneric = (entities.generic || []).indexOf(e) !== -1;
          if (!isGeneric) addQ(e);
        }
      });
    }
    // 构建最终查询集（整条标题仅当较短时使用；最多5个精准词）
    var finalQs = [];
    if (kw.length <= 22) finalQs.push(kw);  // 短标题保留整条查询
    finalQs = finalQs.concat(queryTerms.slice(0, 5));

    // 判定哪些词"看起来像公司名/股票代码"（可用于搜公告）
    function looksLikeCompany(term) {
      if (!term || term.length < 2) return false;
      // 英文proper noun / 股票代码模式
      if (/^[A-Z]{2,6}$/.test(term)) return true;
      // 中文公司名特征：含"科技/股份/软件/电子/生物/医药/证券/银行/保险/集团"
      if (/科技|股份|软件|电子|生物|医药|证券|银行|保险|集团|控股|能源|材料|设备|重工|汽车|航空|航天|通信|网络|信息|数据/.test(term)) return true;
      // known 公司名（大厂）
      var bigCos = ['华为','百度','阿里','腾讯','字节','小米','苹果','英伟达','特斯拉',
        '宁德时代','比亚迪','贵州茅台','工商银行','中国石油','中芯国际','隆基绿能',
        '创耀科技','润和软件','科大国创','软通动力'];
      return bigCos.indexOf(term) !== -1;
    }

    var seenQ = {};
    var emQueries = [];
    finalQs.forEach(function (q) {
      if (!q || seenQ[q]) return; seenQ[q] = 1;
      emQueries.push(searchEMNews(q, 'cmsArticleWebOld', 4)); // 新闻：4页
      // V7 公告控制：只有"像公司名"的词才搜公告，避免基金招募书污染
      if (looksLikeCompany(q)) {
        emQueries.push(searchEMNews(q, 'notice', 2));
      }
    });
    Promise.all(emQueries).then(function (res) {
      // 1.5) 合并所有结果（大池子）+ 相关性打分
      var allNews = mergeProphetNews(res, 150); // 先广撒网捞足，再筛
      var scoredItems = allNews.map(function(item) {
        var sr = scoreRelevance(item, kw, entities);
        return { item: item, score: sr.score, level: sr.level, reasons: sr.reasons };
      });
      // 按相关度降序排列
      scoredItems.sort(function(a, b) { return b.score - a.score; });
      // 取 top 30 用于展示
      var topNews = scoredItems.slice(0, 30).map(function(s) { return s.item; });

      // 1.8) 核心报道识别 + 多源交叉验证（V7：必须含标志性实体）
      var highItems = scoredItems.filter(function(s) { return s.level === 'high'; });
      // V7：无标志性实体的 high 条目降级为 mid（泛词堆出来的高分不算）
      scoredItems.forEach(function(s) {
        if (s.level === 'high' && (s.distHits || 0) === 0) s.level = 'mid';
      });
      highItems = scoredItems.filter(function(s) { return s.level === 'high'; }); // 重新筛选

      var coreReport = null, coreCentrality = -1;
      highItems.forEach(function(s) {
        // V7 新中心度：标志性实体权重极高，泛词几乎不计
        var c = (s.distHits || 0) * 5 + (s.genHits || 0) * 1 + (s.bodyHits || 0) * 3;
        if (c > coreCentrality) { coreCentrality = c; coreReport = s; }
      });
      var cross = (coreReport && coreReport.item)
        ? crossValidate(coreReport.item, scoredItems.filter(function(s) { return s !== coreReport; }))
        : null;

      // 2) 生成事件摘要（核心报道置顶，只用 high+mid 级别）
      var summary = generateEventSummary(ev, topNews, scoredItems.slice(0, 30), coreReport);

      // 3) 匹配产业链 & 个股 —— 只用高相关新闻的聚合文本！
      var relevantText = [kw];
      scoredItems.forEach(function(si) {
        if (si.level === 'high' || si.level === 'mid') {
          relevantText.push(si.item.title || '');
          relevantText.push(si.item.summary || si.item.content || '');
        }
      });
      var relAggregate = relevantText.join(' ');
      var industries = matchIndustries(relAggregate, priorIndustry);
      // 个股识别：纯 emSuggest（与顶部搜索框同一套东财全市场数据）
      resolveCompaniesViaSearch(relAggregate, function(stocks) {
        stocks = (stocks||[]).slice(0, 15);
        renderChainBlock(chainEl, industries, stocks, priorIndustry);
      });

      // 4) 渲染「事件详情」区块（不依赖个股，先画）
      renderSummaryBlock(summaryEl, summary, coreReport, cross);

    }).catch(function (e) {
      if (summaryEl) summaryEl.querySelector('.pd-summary-loading')
        && (summaryEl.querySelector('.pd-summary-loading').textContent = '分析失败：' + escapeHtml((e && e.message) || e));
    });
  }

  // ---- 渲染：事件详情摘要 ----
  function renderSummaryBlock(el, s, coreReport, cross) {
    if (!el) return;
    var html = '';
    if (s.hasContent) {
      // 核心报道卡（置顶）
      if (s.coreTitle) {
        html += '<div class="pd-core-report">'
          + '<span class="pd-core-badge">核心报道</span>'
          + '<div class="pd-core-title">' + escapeHtml(s.coreTitle) + '</div>'
          + (s.coreSrc ? '<div class="pd-core-src">' + escapeHtml(s.coreSrc) + '</div>' : '')
          + '</div>';
      }
      // 多源交叉验证
      if (cross && cross.corroborated && cross.corroborated.length) {
        html += '<div class="pd-cross">'
          + '<span class="pd-cross-lbl">多源交叉验证</span>'
          + '<span class="pd-cross-txt">核心事实经 ' + cross.sources + ' 家媒体印证：'
          + cross.corroborated.slice(0, 6).map(function(f){ return escapeHtml(f); }).join('、') + '</span>'
          + '</div>';
      }
      // 相关报道列表（仅当有非核心条目时显示区域标题）
      var relatedPoints = s.points.filter(function(p) { return !p.core; });
      if (relatedPoints.length > 0) {
        html += '<div class="pd-related-section">'
          + '<span class="pd-related-lbl">相关报道</span>'
          + '<ul class="pd-summary-list">';
        relatedPoints.forEach(function (p) {
          html += '<li>' + escapeHtml(p.txt) + '</li>';
        });
        html += '</ul></div>';
      } else if (s.points.length > 0 && s.points[0].core) {
        // 只有核心报道没有其他相关报道 → 不显示空列表
      }
      // （兼容：旧版无 core 标记的 points 全部归入相关报道）
      var legacyPoints = s.points.filter(function(p) { return typeof p.core === 'undefined'; });
      if (legacyPoints.length > 0) {
        html += '<div class="pd-related-section">'
          + '<span class="pd-related-lbl">相关报道</span>'
          + '<ul class="pd-summary-list">';
        legacyPoints.forEach(function (p) {
          html += '<li>' + escapeHtml(p.txt) + '</li>';
        });
        html += '</ul></div>';
      }
      // 发酵度指示器
      if (s.newsCount > 0) {
        html += '<div class="pd-ferment">'
          + '<span class="pf-label">发酵度</span>'
          + '<span class="pf-badge">' + s.newsCount + '篇报道'
          + (s.srcCount > 0 ? ' · ' + s.srcCount + '个来源' : '')
          + '</span></div>';
      }
    } else {
      html += '<div class="d-note">暂无该事件的核心报道（已检索相关资讯，但未发现高相关内容；事件可能为预告型或刚发布）。</div>';
    }
    // 替换 loading 占位
    var loading = el.querySelector('.pd-summary-loading');
    if (loading) { loading.outerHTML = html; }
  }

  // ---- 渲染：关联产业链 + 个股标签 ----
  function renderChainBlock(el, industries, stocks, priorIndustry) {
    if (!el) return;
    var html = '';

    // 先验推断提示
    if (priorIndustry && priorIndustry.ind) {
      var piCh = CHAIN_KEYWORDS[priorIndustry.ind];
      if (piCh) {
        html += '<div class="pd-prior-hint" style="font-size:11.5px;color:var(--sub);margin-bottom:6px;padding:4px 10px;'
          + 'background:var(--panel);border-radius:6px;border-left:3px solid ' + piCh.color + ';">'
          + '事件推断 → ' + piCh.label
          + (priorIndustry.reason ? ' (' + priorIndustry.reason + ')' : '')
          + '</div>';
      }
    }

    // 产链链标签（带命中词数和备注）
    if (industries.length > 0) {
      html += '<div class="pd-chain-tags">';
      industries.forEach(function (ind) {
        var titleExtra = '命中 ' + ind.words.length + '个关键词';
        if (ind.note) titleExtra += ' ' + ind.note;
        html += '<span class="pd-chain-tag" data-ind="' + ind.key + '" style="border-color:' + ind.color + ';color:' + ind.color + '" title="' + titleExtra + '">'
          + escapeHtml(ind.label)
          + '</span>';
      });
      html += '</div>';
    } else {
      html += '<div class="d-note" style="font-size:12.5px;">未检测到明确的产链链关联（或该事件属宏观政策/市场层面）</div>';
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

    el.innerHTML = '<h3>关联产链与个股</h3>' + html;

    el.querySelectorAll('.pd-chain-tag[data-ind]').forEach(function (tag) {
      tag.addEventListener('click', function () {
        var indKey = tag.dataset.ind;
        closeProphetDetail();
        if (window.showChainTrack) window.showChainTrack(indKey);
        else if (window.setIndustry) window.setIndustry(indKey);
      });
    });

    el.querySelectorAll('.pd-stock-tag[data-code]').forEach(function (tag) {
      tag.addEventListener('click', function () {
        var code = tag.dataset.code;
        closeProphetDetail();
        if (typeof openDetail === 'function') openDetail(code);
      });
    });
  }


  // ---- 渲染：紧凑滚动新闻列表（V5：带相关度等级标签+分级展示） ----
  function renderCompactNews(box, srcLabel, items, summary, scoredItems, coreReport) {
    var highCnt = 0, midCnt = 0, lowCnt = 0;
    if (scoredItems) {
      scoredItems.forEach(function(s) {
        if (s.level === 'high') highCnt++;
        else if (s.level === 'mid') midCnt++;
        else if (s.level === 'low') lowCnt++;
      });
    }
    if (srcLabel) {
      var total = (items || []).length;
      var detail = '';
      if (total > 0) {
        detail = total + '篇';
        if (highCnt > 0) detail += ' · <span style="color:#c0504d;font-weight:700">' + highCnt + '高关联</span>';
        if (midCnt > 0) detail += ' ' + midCnt + '中';
        if (lowCnt > 0) detail += ' ' + lowCnt + '低';
      }
      srcLabel.innerHTML = detail + ' <span style="font-weight:400;color:var(--sub)">东方财富</span>';
    }
    if (!box) return;

    if (!items || !items.length) {
      box.innerHTML = '<div class="news-loading">暂无相关报道</div>';
      return;
    }

    // 按相关度分级渲染，低关联默认折叠
    var levels = { high: [], mid: [], low: [] };
    (scoredItems || []).forEach(function(si, idx) {
      if (idx >= items.length) return;
      var lvl = si.level || 'low';
      if (!levels[lvl]) levels[lvl] = [];
      levels[lvl].push({ item: items[idx], si: si });
    });

    var levelLabels = {
      high: '<span class="pd-rel-lbl high">高关联</span>',
      mid: '<span class="pd-rel-lbl mid">中关联</span>',
      low: '<span class="pd-rel-lbl low" style="display:none">低关联</span>'
    };
    var html = '';

    ['high', 'mid', 'low'].forEach(function(lvl) {
      var list = levels[lvl];
      if (!list || !list.length) return;
      html += '<div class="pd-news-level-group" data-level="' + lvl + '">';
      html += levelLabels[lvl] || '';
      list.forEach(function(entry) {
        var it = entry.item;
        var isCore = coreReport && coreReport.item === it;
        var tag = (isCore ? '<span class="pd-nk core">核心</span>' : '')
          + (it.kind === 'ann'
          ? '<span class="pd-nk ann">公告</span>'
          : '<span class="pd-nk news">报道</span>');
        var meta = [];
        if (it.sec) meta.push(escapeHtml(it.sec));
        if (it.date) meta.push(escapeHtml(it.date));
        var inner = tag
          + '<span class="pd-nt-c">' + escapeHtml(it.title) + '</span>'
          + (meta.length ? '<span class="pd-nm-c">' + meta.join(' · ') + '</span>' : '');
        if (it.url) {
          html += '<a class="pd-ni-c" href="' + escapeHtml(it.url) + '" target="_blank" rel="noopener">' + inner + '</a>';
        } else {
          html += '<div class="pd-ni-c">' + inner + '</div>';
        }
      });
      // 低关联折叠按钮
      if (lvl === 'low' && list.length > 0) {
html += '<button class="pd-show-low" data-act="sl">'
      html += '\u5c55\u5f00 ' + list.length + ' \u6761\u4f4e\u5173\u8052\u2193</button>';
        // 默认隐藏低关联条目
        html = html.replace(/<a class="pd-ni-c"/g, '<a class="pd-ni-c" style="display:none"');
        html = html.replace(/<div class="pd-ni-c"(?!.*?style="display:none")/g, '<div class="pd-ni-c" style="display:none"');
      }
      html += '</div>';
    });

    box.innerHTML = html || '<div class="news-loading">暂无相关报道</div>';

    // 低关联展开按钮事件绑定（onclick已内联，无需额外bind）
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
          inner.param[type] = { searchScope: 'default', sort: 'relevance', pageIndex: pi, pageSize: 20, preTag: '<em>', postTag: '</em>' };
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

  // 合并多路新闻/公告，按时间倒序、去重、限制条数
  function mergeProphetNews(lists, limit) {
    var seen = {}, out = [];
    (lists || []).forEach(function (list) {
      (list || []).forEach(function (it) {
        if (!it || !it.title) return;
        var k = (it.url || '') + '|' + it.title;
        if (seen[k]) return;
        seen[k] = 1; out.push(it);
      });
    });
    out.sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    return out.slice(0, limit || 60);
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
      '.pd-summary-list li{font-size:13px;color:var(--sub);line-height:1.6;margin-bottom:5px;'
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
            // 相关度等级标签
      '.pd-rel-lbl{font-size:10.5px;font-weight:800;padding:1px 7px;border-radius:8px;margin-right:6px;vertical-align:middle;}',
      '.pd-rel-lbl.high{color:#fff;background:#c0504d;}',
      '.pd-rel-lbl.mid{color:#d98b2b;background:rgba(217,139,43,.14);}',
      '.pd-rel-lbl.low{color:var(--sub);background:var(--panel);}',
      // 核心报道卡
      '.pd-core-report{margin:10px 0 12px;padding:12px 14px;border-radius:12px;'
        + 'background:linear-gradient(135deg,rgba(192,80,77,.10),rgba(224,169,59,.08));'
        + 'border:1px solid rgba(192,80,77,.35);position:relative;}',
      '.pd-core-badge{display:inline-block;font-size:11px;font-weight:800;color:#fff;'
        + 'background:linear-gradient(135deg,#c0504d,#e0a93b);padding:2px 10px;border-radius:20px;margin-bottom:7px;letter-spacing:.5px;}',
      '.pd-core-title{font-size:15px;font-weight:800;color:var(--text);line-height:1.5;}',
      '.pd-core-src{font-size:12px;color:var(--sub);margin-top:4px;}',
      // 多源交叉验证
      '.pd-cross{display:flex;flex-wrap:wrap;align-items:center;gap:7px;margin:0 0 12px;padding:9px 12px;'
        + 'background:var(--panel);border-left:3px solid #5b9bd5;border-radius:8px;}',
      '.pd-cross-lbl{font-size:11.5px;font-weight:800;color:#5b9bd5;flex:0 0 auto;}',
      '.pd-cross-txt{font-size:12.5px;color:var(--text);line-height:1.5;}',
      // 摘要列表：核心条目高亮
      '.pd-summary-list li.pd-li-core{color:var(--text);font-weight:600;}'
        + '.pd-summary-list li.pd-li-core::marker{color:#c0504d;}',
      // 相关报道区域（与核心报道卡视觉分隔）
      '.pd-related-section{margin-top:14px;padding-top:10px;border-top:1px solid var(--line);}',
      '.pd-related-lbl{display:inline-block;font-size:11.5px;font-weight:800;color:var(--midstream);'
        + 'letter-spacing:1px;margin-bottom:6px;padding:0 2px;}',
      // 新闻列表：核心报道标
      '.pd-nk.core{color:#fff;background:linear-gradient(135deg,#c0504d,#e0a93b);}',
      // 新闻分组容器
      '.pd-news-level-group{margin-bottom:6px;}',
      '.pd-news-level-group .pd-rel-lbl{margin-bottom:4px;display:inline-block;}',
      // 展开/折叠低关联
      '.pd-show-low{font-size:11.5px;color:var(--midstream);background:var(--panel-2);border:1px solid var(--line);'
        + 'border-radius:6px;padding:3px 12px;cursor:pointer;width:100%;text-align:center;margin-top:4px;}',
      '.pd-show-low:hover{background:var(--panel);border-color:var(--midstream);}',
      // 先验推断提示
      '.pd-prior-hint{line-height:1.4;}',
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

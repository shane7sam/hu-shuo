#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地代理服务器：为本机预览/浏览器提供 AI 产业链实时行情。
- 服务端（已验证有外网）拉取腾讯实时行情(qt.gtimg.cn) + 多源日K线
- K 线多源回退：腾讯(A/港) -> 东方财富(全市场,补美股/北交所) -> Stooq(全球兜底) -> 雅虎(美股) -> 新浪(兜底)
- 源健康度冷却：某源连续 3 次异常才冷却 60s；「返回了但数据不足」不算失败，自动跳下一源
- 区间数据落盘缓存 .kline_cache.json：重启/网络抖动后仍可展示历史区间
- /api/quotes 返回合并后的 JSON：{updated, count, total, quotes:{code:{price,day,dayAmt,p5,p20,p60}}}
- 页面通过同源 /api/quotes 获取数据，规避预览环境无外网出口 / CORS 问题
"""
import os, re, json, time, threading, datetime, concurrent.futures, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
HTML = os.path.join(HERE, 'ai-industry-chain.html')
KLINE_CACHE_FILE = os.path.join(HERE, '.kline_cache.json')

def get_codes():
    txt = open(HTML, encoding='utf-8').read()
    return sorted(set(re.findall(r"c:'(\w+)'", txt)))

CODES = get_codes()

def _get(url, timeout=12):
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()

# ------------------------------------------------------------------ 实时行情
def fetch_realtime(codes):
    out = {}
    for i in range(0, len(codes), 50):
        url = 'https://qt.gtimg.cn/q=' + ','.join(codes[i:i + 50])
        try:
            raw = _get(url).decode('gbk')
        except Exception:
            continue
        for line in raw.split(';\n'):
            m = re.match(r'v_(\w+)="([^"]*)"', line)
            if not m:
                continue
            code = m.group(1)
            p = m.group(2).split('~')
            try:
                price = float(p[3])
            except Exception:
                continue
            dt = -1
            for i2, x in enumerate(p):
                if re.match(r'^\d{14}$', x) or re.match(r'^\d{4}/\d{2}/\d{2}', x):
                    dt = i2
                    break
            amt = float(p[dt + 1]) if dt >= 0 else (float(p[31]) if len(p) > 31 else 0.0)
            pct = float(p[dt + 2]) if dt >= 0 else (float(p[32]) if len(p) > 32 else 0.0)
            out[code] = {'price': price, 'dayAmt': amt, 'day': pct}
    return out

# ------------------------------------------------------------------ 代码映射
def _em_secid(code):
    if code.startswith('sh'):
        return '1.' + code[2:]
    if code.startswith('sz') or code.startswith('bj'):
        return '0.' + code[2:]
    if code.startswith('hk'):
        return '116.' + code[2:]
    if code.startswith('us'):
        return '105.' + code[2:]
    return None

def _stooq_sym(code):
    if code.startswith('us'):
        return code[2:].lower() + '.us'
    if code.startswith('hk'):
        return code[2:] + '.hk'
    if code.startswith('sh'):
        return code[2:] + '.ss'
    if code.startswith('sz'):
        return code[2:] + '.sz'
    if code.startswith('bj'):
        return code[2:] + '.bj'
    return None

def _sina_sym(code):
    if code.startswith('us'):
        return 'gb_' + code[2:]
    if code.startswith('hk'):
        return 'r_' + code
    return code

# ------------------------------------------------------------------ K 线数据源
# 腾讯新版行情代理（旧 web.ifzq.gtimg.cn 已返回 501 废弃；proxy.finance.qq.com 仍可用且支持 CORS）
_TENCENT = 'https://proxy.finance.qq.com/ifzqgtimg/appstock/app'

def _src_tencent(code):
    # A/港/京用 fqkline；美股用 usfqkline（腾讯美股日K历史极少，通常仅 1~2 根，无法算区间→交给其他源）
    path = 'usfqkline/get' if code.startswith('us') else 'fqkline/get'
    url = '%s/%s?param=%s,day,2024-01-01,2099-01-01,130,qfq' % (_TENCENT, path, code)
    j = json.loads(_get(url).decode('utf-8'))
    node = (j.get('data') or {}).get(code)
    if not node:
        return None
    for k in ('qfqday', 'day'):
        if isinstance(node.get(k), list) and node[k]:
            return [float(e[2]) for e in node[k] if e and len(e) > 2]
    return None

def fetch_kline_raw(code):
    # 返回腾讯 K 线原始 JSON（含 qt 行情块，供浏览器提取 PB）；服务端抓取规避浏览器跨域/区域拦截
    path = 'usfqkline/get' if code.startswith('us') else 'fqkline/get'
    url = '%s/%s?param=%s,day,2024-01-01,2099-01-01,130,qfq' % (_TENCENT, path, code)
    try:
        return json.loads(_get(url).decode('utf-8'))
    except Exception:
        return None

def _src_eastmoney(code):
    # 东方财富 K 线（A/港/美/京全覆盖，国内可达，是美股/北交所区间数据的核心补充源）
    sid = _em_secid(code)
    if not sid:
        return None
    url = ('https://push2his.eastmoney.com/api/qt/stock/kline/get?fields1=f1,f2,f3,f4,f5,f6'
           '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1'
           '&secid=%s&end=20500101&lmt=130' % sid)
    d = json.loads(_get(url, timeout=15).decode('utf-8'))
    # 东方财富结构：data[secid]{klines:[...]}（secid 为键，多嵌套一层）
    data_node = d.get('data') or {}
    kd = data_node.get(sid) or (next(iter(data_node.values())) if data_node else {})
    kl = (kd or {}).get('klines') or []
    out = []
    for row in kl:
        if not row:
            continue
        p = row.split(',')
        if len(p) > 2:
            try:
                out.append(float(p[2]))
            except Exception:
                pass
    if len(out) < 2:
        # 源可用但本次无数据 → 交给下一源（不视为异常）
        return None
    return out

def _src_stooq(code):
    # Stooq 免费日线（覆盖 A/港/美，全球可达，作为东财之外的兜底）；北交所(.bj)通常无覆盖
    sym = _stooq_sym(code)
    if not sym:
        return None
    url = 'https://stooq.com/q/d/l/?s=%s&i=d' % sym
    txt = _get(url, timeout=20).decode('utf-8')
    out = []
    for line in txt.split('\n')[1:]:
        if not line.strip():
            continue
        p = line.split(',')
        if len(p) >= 5:
            try:
                out.append(float(p[4]))
            except Exception:
                pass
    if len(out) < 2:
        return None
    return out

def _src_yahoo(code):
    # 雅虎财经（仅美股）；国内常被墙(403)，仅作海外环境兜底
    if not code.startswith('us'):
        return None
    sym = code[2:]
    url = 'https://query1.finance.yahoo.com/v8/finance/chart/%s?range=1y&interval=1d' % sym
    d = json.loads(_get(url, timeout=12).decode('utf-8'))
    res = (d.get('chart') or {}).get('result')
    if not res or not res[0]:
        return None
    ind = res[0].get('indicators') or {}
    closes = [c for c in (ind.get('adjclose') or ind.get('close') or []) if c is not None]
    if len(closes) < 2:
        return None
    return closes

def _src_sina(code):
    # 新浪 K 线（A/港用 stock 域；美股用 usstock 域）；接口老旧，仅作最后兜底
    sym = _sina_sym(code)
    host = 'usstock' if code.startswith('us') else 'stock'
    url = ('https://stock.finance.sina.com.cn/%s/api/json_v2.php/CN_MarketDataService.getKLine'
           '?symbol=%s&scale=240&ma=no&datalen=130' % (host, sym))
    arr = json.loads(_get(url).decode('gbk', 'replace'))
    if not isinstance(arr, list):
        return None
    out = []
    for r in arr:
        if isinstance(r, list) and len(r) > 4:
            try:
                out.append(float(r[4]))
            except Exception:
                pass
    if len(out) < 2:
        return None
    return out

# ------------------------------------------------------------------ K 线原始多源（供浏览器绘制，返回腾讯兼容 JSON）
# 浏览器 analyzeTech 按 [日期,开,收,高,低,量] 解析，与腾讯 qfqday 同序。
# 腾讯美股/北交所日K仅 0~1 根，故对这类市场改走东财(完整 OHLC)/雅虎/新浪。
def _src_eastmoney_raw(code):
    # 东方财富 K 线（含完整 OHLC）：f51=日期 f52=开 f53=收 f54=高 f55=低 f56=量
    sid = _em_secid(code)
    if not sid:
        return None
    url = ('https://push2his.eastmoney.com/api/qt/stock/kline/get?fields1=f1,f2,f3,f4,f5,f6'
           '&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61&klt=101&fqt=1'
           '&secid=%s&end=20500101&lmt=260' % sid)
    d = json.loads(_get(url, timeout=15).decode('utf-8'))
    data_node = d.get('data') or {}
    kd = data_node.get(sid) or (next(iter(data_node.values())) if data_node else {})
    kl = (kd or {}).get('klines') or []
    out = []
    for row in kl:
        if not row:
            continue
        p = row.split(',')
        if len(p) < 6:
            continue
        try:
            out.append([p[0], float(p[1]), float(p[2]), float(p[3]), float(p[4]), float(p[5])])
        except Exception:
            pass
    return out if len(out) >= 2 else None

def _src_yahoo_raw(code):
    # 雅虎财经（仅美股）：返回 OHLC 时间序列
    if not code.startswith('us'):
        return None
    sym = code[2:]
    url = 'https://query1.finance.yahoo.com/v8/finance/chart/%s?range=2y&interval=1d' % sym
    d = json.loads(_get(url, timeout=12).decode('utf-8'))
    res = (d.get('chart') or {}).get('result')
    if not res or not res[0]:
        return None
    q0 = (((res[0].get('indicators') or {}).get('quote') or [{}]) + [{}])[0]
    ts = res[0].get('timestamp') or []
    opens, highs, lows, closes, vols = (q0.get('open') or [], q0.get('high') or [],
                                        q0.get('low') or [], q0.get('close') or [], q0.get('volume') or [])
    out = []
    for i, t in enumerate(ts):
        if i >= len(closes) or closes[i] is None:
            continue
        c = float(closes[i])
        dt = datetime.datetime.utcfromtimestamp(t).strftime('%Y-%m-%d')
        o = float(opens[i]) if i < len(opens) and opens[i] is not None else c
        h = float(highs[i]) if i < len(highs) and highs[i] is not None else c
        l = float(lows[i]) if i < len(lows) and lows[i] is not None else c
        v = float(vols[i]) if i < len(vols) and vols[i] is not None else 0.0
        out.append([dt, o, c, h, l, v])
    return out if len(out) >= 2 else None

def _src_sina_raw(code):
    # 新浪 K 线（A/港用 stock 域；美股用 usstock 域）：格式 [日期,开,高,低,收,量]
    sym = _sina_sym(code)
    host = 'usstock' if code.startswith('us') else 'stock'
    url = ('https://stock.finance.sina.com.cn/%s/api/json_v2.php/CN_MarketDataService.getKLine'
           '?symbol=%s&scale=240&ma=no&datalen=260' % (host, sym))
    arr = json.loads(_get(url).decode('gbk', 'replace'))
    if not isinstance(arr, list):
        return None
    out = []
    for r in arr:
        if isinstance(r, list) and len(r) >= 6:
            try:
                # 新浪顺序 [日期,开,高,低,收,量] -> 腾讯顺序 [日期,开,收,高,低,量]
                out.append([r[0], float(r[1]), float(r[4]), float(r[2]), float(r[3]), float(r[5])])
            except Exception:
                pass
    return out if len(out) >= 2 else None

def fetch_kline_raw_multi(code):
    # 返回腾讯兼容 JSON: {data:{code:{qfqday:[[日期,开,收,高,低,量], ...]}}}
    # 源顺序：腾讯(A/港) -> 东方财富(全市场含美股/北交所完整 OHLC) -> 雅虎(美股) -> 新浪(兜底)
    if not (code.startswith('us') or code.startswith('bj')):
        try:
            j = fetch_kline_raw(code)
            node = (j.get('data') or {}).get(code) if j else None
            arr = None
            if node:
                for k in ('qfqday', 'day'):
                    if isinstance(node.get(k), list) and len(node[k]) >= 2:
                        arr = node[k]
                        break
            if arr and len(arr) >= 2:
                return j
        except Exception:
            pass
    try:
        em = _src_eastmoney_raw(code)
        if em and len(em) >= 2:
            return {'data': {code: {'qfqday': em}}}
    except Exception:
        pass
    if code.startswith('us'):
        try:
            yh = _src_yahoo_raw(code)
            if yh and len(yh) >= 2:
                return {'data': {code: {'qfqday': yh}}}
        except Exception:
            pass
    try:
        sn = _src_sina_raw(code)
        if sn and len(sn) >= 2:
            return {'data': {code: {'qfqday': sn}}}
    except Exception:
        pass
    return None

# 源顺序：腾讯(A/港) -> 东方财富(全市场,补美股/北交所) -> Stooq(全球) -> 雅虎(美股) -> 新浪(兜底)
_KLINE_SRCS = [('tencent', _src_tencent), ('eastmoney', _src_eastmoney),
               ('stooq', _src_stooq), ('yahoo', _src_yahoo), ('sina', _src_sina)]

def _src_supports(name, code):
    """已知某源对某市场不可能有数据，则跳过以省请求；返回 None/'不足' 的由调用方判定。"""
    if code.startswith('na_'):
        return False
    if name == 'tencent':
        # 腾讯美股/北交所日K仅 0~1 根，交给东财/Stooq
        return not (code.startswith('us') or code.startswith('bj'))
    if name == 'yahoo':
        return code.startswith('us')
    if name == 'sina':
        return not code.startswith('bj')
    return True  # eastmoney / stooq 覆盖全市场

# 源健康度：连续 3 次「异常」才冷却 60s；「返回了但数据不足」不计入失败，自动跳下一源
_SRC_COOLDOWN = {}
_SRC_FAILS = {}
_KL_CACHE = {}                 # code -> (时间戳, {p5,p20,p60})，成功结果缓存 300s（并落盘）
_KL_LOCK = threading.Lock()
_RT_CACHE = {'data': None, 't': 0}
_PAY_CACHE = {'data': None, 't': 0}
_CACHE_LAST_SAVE = 0

def _load_disk_cache():
    try:
        with open(KLINE_CACHE_FILE, encoding='utf-8') as f:
            d = json.load(f)
        now = time.time()
        for k, v in d.items():
            if isinstance(v, dict) and 't' in v:
                _KL_CACHE[k] = (v['t'], {'p5': v.get('p5'), 'p20': v.get('p20'), 'p60': v.get('p60')})
        # 落盘缓存可能存在数小时前的旧数据，仅作为「展示兜底」：过期(>6h)的标记为陈旧，
        # 仍用于展示但会在后台尽快刷新。这里直接采用，get_kl 会按 300s 刷新成最新。
        return len(_KL_CACHE)
    except Exception:
        return 0

def _save_disk_cache():
    global _CACHE_LAST_SAVE
    now = time.time()
    if now - _CACHE_LAST_SAVE < 10:
        return
    _CACHE_LAST_SAVE = now
    try:
        payload = {k: {'p5': v[1].get('p5'), 'p20': v[1].get('p20'), 'p60': v[1].get('p60'), 't': v[0]}
                   for k, v in _KL_CACHE.items() if v and v[1]}
        with open(KLINE_CACHE_FILE, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False)
    except Exception:
        pass

def _src_healthy(name):
    return _SRC_COOLDOWN.get(name, 0) <= time.time()

def _mark_fail(name):
    _SRC_FAILS[name] = _SRC_FAILS.get(name, 0) + 1
    if _SRC_FAILS[name] >= 3:
        _SRC_COOLDOWN[name] = time.time() + 60
        _SRC_FAILS[name] = 0

def _mark_ok(name):
    _SRC_FAILS[name] = 0

def fetch_kline(code):
    """多源回退求一个标的的日K前复权收盘价序列；返回 {p5,p20,p60} 或 None。"""
    closes = None
    for name, src in _KLINE_SRCS:
        if not _src_healthy(name):
            continue
        if not _src_supports(name, code):
            continue
        try:
            c = src(code)
        except Exception:
            _mark_fail(name)
            continue
        _mark_ok(name)
        if c and len(c) >= 2:
            closes = c
            break
        # 返回了但数据不足：不算失败，尝试下一源
    if not closes:
        return None
    def pp(n):
        i = len(closes) - 1 - n
        if i < 0 or not closes[i]:
            return None
        return (closes[-1] - closes[i]) / closes[i] * 100.0
    return {'p5': pp(5), 'p20': pp(20), 'p60': pp(60)}

# ------------------------------------------------------------------ 公告代理
def _em_ann_code(code):
    """把站点内部代码(sh600519/sz300750/bj835438)转成东方财富公告接口所需的 SH600519 格式。"""
    m = {'sh': 'SH', 'sz': 'SZ', 'bj': 'BJ'}
    if code[:2] in m:
        return m[code[:2]] + code[2:].upper()
    return None

def fetch_ann(code):
    """服务端拉取东方财富公告（带 eastmoney Referer，规避浏览器端跨域/来源拦截），返回 [{date,title}]。"""
    list_code = _em_ann_code(code)
    if not list_code:
        return []
    url = ('https://np-anotice-stock.eastmoney.com/api/security/ann?sr=-1&page_size=5'
           '&page_index=1&ann_type=0&client_source=web&stock_list=%s' % list_code)
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://quote.eastmoney.com/',
        'Accept': '*/*',
    })
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            txt = r.read().decode('utf-8', 'replace')
    except Exception:
        return []
    # 去掉可能的 JSONP 包裹（cb=xxx）
    m = re.match(r'^\s*([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)\s*;?\s*$', txt)
    if m:
        txt = m.group(2)
    try:
        data = json.loads(txt)
    except Exception:
        return []
    arr = ((data.get('data') or {}).get('list') or [])
    out = []
    for it in arr[:5]:
        out.append({
            'date': (it.get('notice_date') or it.get('eitime') or '')[:10],
            'title': it.get('title') or it.get('notice_title') or '',
        })
    return out


def fetch_news(code):
    """服务端拉取东方财富个股资讯/要闻（带 eastmoney Referer），返回 [{date,title,pop,col}]。"""
    list_code = _em_ann_code(code)
    if not list_code:
        return []
    url = ('https://np-listapi.eastmoney.com/comm/web/getNewsByCode?client=PC'
           '&code=%s&num=6&page=1' % list_code)
    req = urllib.request.Request(url, headers={
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
        'Referer': 'https://quote.eastmoney.com/',
        'Accept': '*/*',
    })
    try:
        with urllib.request.urlopen(req, timeout=12) as r:
            txt = r.read().decode('utf-8', 'replace')
    except Exception:
        return []
    m = re.match(r'^\s*([A-Za-z_$][\w$]*)\s*\(([\s\S]*)\)\s*;?\s*$', txt)
    if m:
        txt = m.group(2)
    try:
        data = json.loads(txt)
    except Exception:
        return []
    arr = (((data.get('data') or {}).get('list')) or
           ((data.get('data') or {}).get('newsList')) or [])
    out = []
    for it in arr[:6]:
        if not isinstance(it, dict):
            continue
        title = it.get('title') or ''
        if not title:
            continue
        out.append({
            'date': (it.get('date') or it.get('datetime') or it.get('showtime') or '')[:10],
            'title': title,
            'pop': it.get('popularity') if it.get('popularity') is not None else it.get('count', ''),
            'col': it.get('column') or it.get('mediaName') or '',
        })
    return out

def get_rt():
    global _RT_CACHE
    now = time.time()
    if _RT_CACHE['data'] and now - _RT_CACHE['t'] < 15:
        return _RT_CACHE['data']
    _RT_CACHE['data'] = fetch_realtime(CODES)
    _RT_CACHE['t'] = now
    return _RT_CACHE['data']

def get_kl():
    # 仅补抓「缓存过期/缺失」的标的；成功结果缓存 300s，大幅降低对行情源请求量
    now = time.time()
    out, miss = {}, []
    with _KL_LOCK:
        for c in CODES:
            e = _KL_CACHE.get(c)
            if e and now - e[0] < 300:
                out[c] = e[1]
            else:
                miss.append(c)
    if miss:
        def work(c):
            r = fetch_kline(c)
            if r:
                with _KL_LOCK:
                    _KL_CACHE[c] = (time.time(), r)
                return c, r
            return c, None
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:
            for c, r in ex.map(work, miss):
                if r:
                    out[c] = r
    with _KL_LOCK:
        _save_disk_cache()
    return out

def build_payload():
    rt = get_rt()
    out = {c: dict(rt.get(c, {})) for c in CODES}
    for c, r in get_kl().items():
        if c in out:
            out[c].update(r)
    return {
        'updated': datetime.datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'count': len(out),
        'total': len(CODES),
        'klineSources': [n for n, _ in _KLINE_SRCS if _src_healthy(n)],
        'quotes': out,
    }

def build_payload_cached():
    global _PAY_CACHE
    now = time.time()
    if _PAY_CACHE['data'] and now - _PAY_CACHE['t'] < 8:
        return _PAY_CACHE['data']
    _PAY_CACHE['data'] = build_payload()
    _PAY_CACHE['t'] = now
    return _PAY_CACHE['data']

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

class H(BaseHTTPRequestHandler):
    def _send(self, code, body, ctype):
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/api/quotes'):
            try:
                payload = build_payload_cached()
                self._send(200, json.dumps(payload, ensure_ascii=False), 'application/json; charset=utf-8')
            except Exception as e:
                self._send(500, json.dumps({'error': str(e)}), 'application/json; charset=utf-8')
            return
        if self.path.startswith('/api/ann'):
            try:
                from urllib.parse import urlparse, parse_qs
                q = parse_qs(urlparse(self.path).query)
                code = (q.get('code') or [''])[0]
                self._send(200, json.dumps({'list': fetch_ann(code)}, ensure_ascii=False),
                           'application/json; charset=utf-8')
            except Exception as e:
                self._send(500, json.dumps({'error': str(e)}), 'application/json; charset=utf-8')
            return
        if self.path.startswith('/api/news'):
            try:
                from urllib.parse import urlparse, parse_qs
                q = parse_qs(urlparse(self.path).query)
                code = (q.get('code') or [''])[0]
                self._send(200, json.dumps({'list': fetch_news(code)}, ensure_ascii=False),
                           'application/json; charset=utf-8')
            except Exception as e:
                self._send(500, json.dumps({'error': str(e)}), 'application/json; charset=utf-8')
            return
        if self.path.startswith('/api/kline'):
            try:
                from urllib.parse import urlparse, parse_qs
                q = parse_qs(urlparse(self.path).query)
                code = (q.get('code') or [''])[0]
                raw = fetch_kline_raw_multi(code)
                if raw is None:
                    self._send(404, json.dumps({'error': 'no kline'}), 'application/json; charset=utf-8')
                else:
                    self._send(200, json.dumps(raw, ensure_ascii=False), 'application/json; charset=utf-8')
            except Exception as e:
                self._send(500, json.dumps({'error': str(e)}), 'application/json; charset=utf-8')
            return
        # 根路径 / 其他：返回 HTML
        try:
            html = open(HTML, encoding='utf-8').read()
            self._send(200, html, 'text/html; charset=utf-8')
        except Exception as e:
            self._send(500, str(e), 'text/plain; charset=utf-8')

    def log_message(self, *a):
        pass

if __name__ == '__main__':
    import socket
    n = _load_disk_cache()
    port = int(os.environ.get('PORT', '8787'))
    host = os.environ.get('HOST', '0.0.0.0')
    srv = ThreadingHTTPServer((host, port), H)
    # 自动探测局域网 IP，方便手机/同网设备访问
    lan = '127.0.0.1'
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))
        lan = s.getsockname()[0]
        s.close()
    except Exception:
        pass
    print('AI 产业链行情代理已启动')
    print('  本机访问 : http://localhost:%d   (标的 %d 只, 落盘缓存 %d 条)' % (port, len(CODES), n))
    print('  手机访问 : http://%s:%d   (需与电脑同一 WiFi)' % (lan, port))
    print('  * 已监听 0.0.0.0，局域网内设备可直接访问；首次可能需允许防火墙通过')
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        srv.shutdown()

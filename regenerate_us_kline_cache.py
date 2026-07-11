# -*- coding: utf-8 -*-
"""
美股 K 线预抓取脚本（方案 B：内嵌静态快照）
------------------------------------------------------------
为何需要：云端(GitHub Pages)浏览器直连新浪美股 K 线被反爬(Referer)拦截、
Yahoo 无 CORS、东财 push2his 对美股返回空；纯静态页无其他可靠实时源。
本脚本在「部署前」于本机/服务端(可带 Referer)抓取新浪完整美股日K，
内嵌成 us_kline_cache.js(window.US_KLINE_CACHE)，页面在所有实时源失败时
回退到它，保证云端美股 K 线 100% 显示、零运行时外部依赖。

用法：
    python regenerate_us_kline_cache.py
部署前跑一次即可刷新快照（数据静态，需重新部署才更新）。
"""
import re, json, time, urllib.request, urllib.parse

HTML = r'C:/Users/senha/Desktop/AI投资/ai-industry-chain.html'
OUT  = r'C:/Users/senha/Desktop/AI投资/us_kline_cache.js'
KEEP = 500   # 保留近 ~2 年交易日，足够画 K 线 + 算 5/20/60

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
REF = 'https://finance.sina.com.cn/'

def extract_us_codes(path):
    """从 LAYERS 数据块提取全部美股代码 usXXXX -> XXXX(ticker)"""
    txt = open(path, encoding='utf-8').read()
    codes = set(re.findall(r"c:'us([A-Z]{2,6})'", txt))
    return sorted(codes)

def _fetch_once(ticker, cb):
    path = '/usstock/api/jsonp_v2.php/var%20' + cb + '=/US_MinKService.getDailyK?symbol=' + ticker.lower()
    url = 'https://stock.finance.sina.com.cn' + path
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Referer': REF, 'Accept': '*/*'
    })
    with urllib.request.urlopen(req, timeout=25) as r:
        body = r.read().decode('utf-8', 'replace')
    # 剥离反爬注入前缀： /*<script>location.href='//sina.com';</script>*/
    body = re.sub(r'^/\*.*?\*/\s*', '', body, flags=re.S)
    # 新浪返回可能是 var cb=([...]); 或 var cb=[...]; —— 数组外可能有括号，需兼容
    m = re.search(r'var\s+' + re.escape(cb) + r'\s*=\s*\(?(\[[\s\S]*?\])\s*\)?\s*;?\s*$', body, flags=re.S)
    if not m:
        return None
    arr = json.loads(m.group(1))
    out = []
    for x in arr:
        if not isinstance(x, dict):
            continue
        try:
            out.append([
                x['d'],
                round(float(x['o']), 4),
                round(float(x['c']), 4),
                round(float(x['h']), 4),
                round(float(x['l']), 4),
                int(float(x.get('v') or 0))
            ])
        except Exception:
            pass
    return out[-KEEP:] if out else None

def fetch_sina(ticker):
    cb = '_xn_' + ticker.lower()
    for attempt in range(3):
        try:
            return _fetch_once(ticker, cb)
        except Exception:
            time.sleep(1.0)
    return None

def main():
    codes = extract_us_codes(HTML)
    print('发现美股成分 %d 只: %s' % (len(codes), ','.join(codes)))
    cache, fail = {}, []
    for tk in codes:
        try:
            arr = fetch_sina(tk)
        except Exception as e:
            arr = None
            print('  %-6s 抓取异常: %s' % (tk, e))
        if arr and len(arr) >= 20:
            cache['us' + tk] = arr
            print('  %-6s OK  %d 根 (%s ~ %s)' % (tk, len(arr), arr[0][0], arr[-1][0]))
        else:
            fail.append(tk)
            print('  %-6s 无数据(跳过)' % tk)
        time.sleep(0.35)
    print('-' * 50)
    print('成功 %d / %d；缺失: %s' % (len(cache), len(codes), ','.join(fail) or '无'))
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write('window.US_KLINE_CACHE=')
        json.dump(cache, f, ensure_ascii=False, separators=(',', ':'))
        f.write(';')
    import os
    print('已写出 %s (%.0f KB, %d 只)' % (OUT, os.path.getsize(OUT) / 1024, len(cache)))

if __name__ == '__main__':
    main()

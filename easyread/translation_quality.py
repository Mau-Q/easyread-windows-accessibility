"""可确定检查的数量边界；仅拒绝新输出，绝不自动改写译文。"""
import re

WORDS = dict(zip(('zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'), range(11)))


def chinese(n):
    if not float(n).is_integer() or not 0 <= int(n) <= 999:
        return None
    n = int(n)
    digits = '零一二三四五六七八九'
    if n < 10:
        return digits[n]
    if n < 100:
        return (digits[n // 10] if n >= 20 else '') + '十' + (digits[n % 10] if n % 10 else '')
    return digits[n // 100] + '百' + (('零' if n % 100 < 10 else '') + chinese(n % 100) if n % 100 else '')


def issues(source, zh):
    number = r'(?:\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten)'
    found = []
    for match in re.finditer(r'\b(more than|greater than|less than|fewer than)\s+(' + number + r')\b', source, re.I):
        direction, literal = match.group(1).lower(), match.group(2).lower()
        value = str(WORDS[literal]) if literal in WORDS else literal
        suffix = '以上' if direction in ('more than', 'greater than') else '以下'
        # 同一段若同时出现同数值的严格/非严格条件，缺少可靠句子对齐时不强行判定。
        inclusive = r'\b(?:at least|at most|no fewer than|no more than)\s+(?:' + re.escape(literal) + '|' + re.escape(value) + r')\b'
        if re.search(inclusive, source, re.I):
            continue
        variants = [re.escape(value)]
        cn = chinese(value)
        if cn:
            variants.append(re.escape(cn))
        # 中文数字紧邻“包括”等前文也应识别；防止十六被错误匹配为六。
        pattern = r'(?<![\d零一二三四五六七八九十百千万])(?:' + '|'.join(variants) + r')[个条种项套名次天层组篇类]{0,2}(?:及|或)?' + suffix
        bad = re.search(pattern, zh)
        if bad:
            proper = '超过/多于（严格大于）' if suffix == '以上' else '少于（严格小于）'
            found.append(f'原文 "{match.group(0)}" 的严格数量边界不能译成 "{bad.group(0)}"；请使用{proper}并完整保留其他内容。')
    return found

/**
 * 将用户输入的 scheme / Deep Link / URL 解析为可传给 `am start -d` 的字符串，并给出可读分解信息。
 */
export interface SchemeParseResult {
  /** 规范化后用于 adb 的 data Uri */
  normalizedUri: string;
  valid: boolean;
  error?: string;
  /** 解析摘要（展示用） */
  summary?: string;
}

export function parseSchemeInput(raw: string): SchemeParseResult {
  const input = raw.trim();
  if (!input) {
    return { normalizedUri: '', valid: false, error: '请输入 scheme 或链接' };
  }

  try {
    const u = new URL(input);
    const scheme = u.protocol.replace(/:$/, '');
    if (!scheme) {
      return { normalizedUri: input, valid: false, error: '无法识别协议（scheme）' };
    }
    const normalizedUri = u.toString();
    const parts: string[] = [`scheme=${scheme}`];
    if (u.hostname) parts.push(`host=${u.hostname}`);
    const rest = `${u.pathname}${u.search}${u.hash}`.trim();
    if (rest && rest !== '/') parts.push(`path=${rest}`);
    return {
      normalizedUri,
      valid: true,
      summary: parts.join('，')
    };
  } catch {
    // 非标准 URL（少数 ROM 或手写格式）：允许原样传递，由系统解析
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:.+/.test(input)) {
      return {
        normalizedUri: input,
        valid: true,
        summary: '已按原样传递（非标准 URL 格式）'
      };
    }
    return {
      normalizedUri: input,
      valid: false,
      error: '格式无效，请输入如 myapp://path、https://a.com/b 等'
    };
  }
}

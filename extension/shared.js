/*
 * Hằng số và hàm dùng chung cho popup.js và content.js.
 * File này không truy cập mạng, không đọc cookie và không đụng vào trang web.
 */
(function (root) {
  'use strict';

  const REDEEM_URL = 'https://redeem.df.garena.sg/vi/cdkgarena.html';
  const REDEEM_MATCH = 'https://redeem.df.garena.sg/*';

  const JOB_KEY = 'dfr.job';
  const SETTINGS_KEY = 'dfr.settings';
  const HOOK_EVENT = 'dfr:redeem-result'; // page-hook.js → content.js (trùng tên trong page-hook.js)
  const HOOK_PING_EVENT = 'dfr:hook-ping';

  // Thời gian chờ giữa 2 code (ms). Không cho thấp hơn 3 giây để không spam máy chủ Garena.
  const DELAY = Object.freeze({ min: 3000, max: 10000, step: 500, default: 6000 });

  const MAX_ATTEMPTS = 3; // số lần thử tối đa cho một code khi gặp lỗi mạng
  const MAX_NETWORK_STREAK = 5; // lỗi mạng liên tiếp bấy nhiêu lần thì tự tạm dừng
  const MAX_UNKNOWN_STREAK = 3; // mã kết quả lạ liên tiếp (có thể đang bị giới hạn) thì tự tạm dừng
  const RESULT_TIMEOUT_MS = 45000; // trang tự hủy request sau 40 giây
  const SEND_TIMEOUT_MS = 5000; // bấm "Đổi" mà quá thời gian này trang chưa gửi request → thử lại
  const PAGE_LOCK_MS = 1500; // trang khóa nút "Đổi" 1 giây sau mỗi lần đổi (cộng thêm dự phòng)
  const MAX_LOGS = 1000;
  const MIN_CODE_LENGTH = 6; // code thật ngắn nhất đã gặp: 6 ký tự (vd. RCA812)
  const MAX_CODE_LENGTH = 40;

  // Chữ Nga/Hy Lạp trông giống hệt chữ Latin, hay lẫn vào khi copy code từ mạng xã hội.
  // Chữ thường kiểu "chữ hoa thu nhỏ" (в к м н т) được gợi ý thành chữ hoa.
  const LOOKALIKES = Object.freeze({
    А: 'A', В: 'B', Е: 'E', К: 'K', М: 'M', Н: 'H', О: 'O', Р: 'P', С: 'C', Т: 'T', Х: 'X', У: 'Y',
    І: 'I', Ј: 'J', Ѕ: 'S', а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j',
    ѕ: 's', в: 'B', к: 'K', м: 'M', н: 'H', т: 'T',
    Α: 'A', Β: 'B', Ε: 'E', Ζ: 'Z', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T',
    Υ: 'Y', Χ: 'X', ο: 'o', ν: 'v', ι: 'i',
  });

  // Mã phản hồi của API đổi code, lấy từ mã nguồn trang redeem.df.garena.sg.
  const RESULT_BY_CODE = Object.freeze({
    0: { kind: 'success', text: 'Đổi thành công! Quà được gửi vào hộp thư trong game.' },
    400072: { kind: 'used', text: 'Tài khoản này đã đổi code này rồi.' },
    400067: { kind: 'used', text: 'Tài khoản đã đạt giới hạn đổi của nhóm code này.' },
    400053: { kind: 'used', text: 'Tài khoản không thể đổi thêm code của gói quà này.' },
    400068: { kind: 'invalid', text: 'Code đã hết lượt đổi.' },
    400054: { kind: 'invalid', text: 'Code không hợp lệ.' },
    400069: { kind: 'invalid', text: 'Code chưa đến thời gian đổi.' },
    400070: { kind: 'invalid', text: 'Code đã hết hạn.' },
    400073: { kind: 'error', text: 'Gói quà bị lỗi cấu hình (lỗi phía Garena).' },
    503001: { kind: 'error', text: 'Tài khoản chưa đủ điều kiện nhận quà này.' },
    503701: { kind: 'network', text: 'Máy chủ Garena báo lỗi mạng.' },
    300001: { kind: 'session', text: 'Phiên đăng nhập đã hết hạn.' },
  });

  const KIND_LABEL = Object.freeze({
    pending: 'Chưa đổi',
    success: 'Thành công',
    used: 'Đã nhận trước đó',
    invalid: 'Không dùng được',
    error: 'Lỗi',
    network: 'Lỗi mạng',
    session: 'Hết phiên đăng nhập',
  });

  /**
   * Tách danh sách code thô. Mọi ký tự không phải chữ/số/-/_ đều là dấu phân cách
   * (dấu cách, xuống dòng, phẩy, chấm phẩy, hai chấm, |, /, emoji, ...).
   * - codes:      code sẽ được đổi, giữ nguyên hoa/thường (code phân biệt hoa/thường).
   * - ignored:    từ không phải code: ngắn hơn 6 ký tự (G3, AS, VAL...), toàn số, hoặc
   *               chữ có dấu tiếng Việt.
   * - suspicious: trông như code nhưng lẫn chữ Nga/Hy Lạp giống chữ Latin (vd. "DFAXIOм33").
   *               Không tự gửi đi, chỉ gợi ý bản sửa.
   */
  function parseCodes(text) {
    const codes = [];
    const ignored = [];
    const suspicious = [];
    const seen = new Set();
    let duplicates = 0;
    for (const raw of String(text ?? '').normalize('NFKC').split(/[^\p{L}\p{N}_-]+/u)) {
      const token = raw.replace(/^[-_]+|[-_]+$/g, '');
      if (!token) continue;
      if (/^[A-Za-z0-9_-]+$/.test(token)) {
        if (!looksLikeCode(token)) {
          ignored.push(token);
        } else if (seen.has(token)) {
          duplicates += 1;
        } else {
          seen.add(token);
          codes.push(token);
        }
        continue;
      }
      const suggestion = fixLookalikes(token);
      if (suggestion && /[A-Za-z0-9]/.test(token) && looksLikeCode(suggestion)) {
        suspicious.push({ token, suggestion });
      } else {
        ignored.push(token);
      }
    }
    return { codes, duplicates, ignored, suspicious };
  }

  function looksLikeCode(token) {
    return token.length >= MIN_CODE_LENGTH && token.length <= MAX_CODE_LENGTH && /[A-Za-z]/.test(token);
  }

  /** Thay chữ Nga/Hy Lạp bằng chữ Latin giống nó; trả về null nếu vẫn còn ký tự lạ. */
  function fixLookalikes(token) {
    const upperOnly = !/[a-z]/.test(token);
    let out = '';
    for (const ch of token) {
      if (/[A-Za-z0-9_-]/.test(ch)) {
        out += ch;
      } else if (LOOKALIKES[ch]) {
        out += upperOnly ? LOOKALIKES[ch].toUpperCase() : LOOKALIKES[ch];
      } else {
        return null;
      }
    }
    return out;
  }

  function clampDelay(ms) {
    const value = Number(ms);
    if (!Number.isFinite(value)) return DELAY.default;
    const stepped = Math.round(value / DELAY.step) * DELAY.step;
    return Math.min(DELAY.max, Math.max(DELAY.min, stepped));
  }

  /** Kết quả do page-hook.js đọc từ phản hồi của máy chủ → { kind, text, code }. */
  function describeApiResult(detail) {
    const code = typeof detail.code === 'number' ? detail.code : null;
    const httpStatus = Number(detail.httpStatus) || 0;
    if (code === null || httpStatus !== 200) {
      return {
        kind: 'network',
        text: httpStatus && httpStatus !== 200
          ? `Lỗi kết nối tới máy chủ (HTTP ${httpStatus}).`
          : 'Lỗi kết nối tới máy chủ Garena.',
      };
    }
    const known = RESULT_BY_CODE[code];
    if (known) return { kind: known.kind, text: known.text, code };
    // Mã chưa biết. Trang cũng giấu 601008 và 503601 (không báo gì khi gặp).
    const msg = typeof detail.msg === 'string' ? detail.msg.trim() : '';
    return { kind: 'error', text: `Máy chủ trả mã ${code}${msg ? `: ${msg}` : ''}.`, code, unknown: true };
  }

  /**
   * Dự phòng khi không đọc được phản hồi máy chủ: dựa vào thông báo trang hiển thị.
   * Trang chỉ dùng hộp thoại #diaTips cho trường hợp thành công; lỗi hiện ở #superTips.
   */
  function describePageMessage(message) {
    if (message.where === 'dialog') {
      return { kind: 'success', text: message.text || RESULT_BY_CODE[0].text };
    }
    // Trang tiếng Việt thiếu bản dịch cho một số lỗi nên hiện nguyên chữ "error_hint_4000xx".
    const hint = /error_hint_(\d+)/.exec(message.text);
    if (hint && RESULT_BY_CODE[hint[1]]) {
      const known = RESULT_BY_CODE[hint[1]];
      return { kind: known.kind, text: known.text, code: Number(hint[1]) };
    }
    return { kind: 'error', text: `Trang báo: ${message.text || '(không có nội dung)'}` };
  }

  function pushLog(job, kind, text, code) {
    job.logs.push({ t: Date.now(), kind, text, code: code || '' });
    if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS);
  }

  function summarize(job) {
    const s = { total: 0, done: 0, pending: 0, success: 0, used: 0, invalid: 0, failed: 0 };
    for (const item of job ? job.items : []) {
      s.total += 1;
      if (item.status === 'pending') {
        s.pending += 1;
        continue;
      }
      s.done += 1;
      if (item.status === 'success') s.success += 1;
      else if (item.status === 'used') s.used += 1;
      else if (item.status === 'invalid') s.invalid += 1;
      else s.failed += 1;
    }
    return s;
  }

  function formatSeconds(ms) {
    return `${(ms / 1000).toLocaleString('vi-VN', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} giây`;
  }

  root.DFR = Object.freeze({
    REDEEM_URL,
    REDEEM_MATCH,
    JOB_KEY,
    SETTINGS_KEY,
    HOOK_EVENT,
    HOOK_PING_EVENT,
    DELAY,
    MAX_ATTEMPTS,
    MAX_NETWORK_STREAK,
    MAX_UNKNOWN_STREAK,
    RESULT_TIMEOUT_MS,
    SEND_TIMEOUT_MS,
    PAGE_LOCK_MS,
    RESULT_BY_CODE,
    KIND_LABEL,
    parseCodes,
    clampDelay,
    describeApiResult,
    describePageMessage,
    pushLog,
    summarize,
    formatSeconds,
  });
})(globalThis);

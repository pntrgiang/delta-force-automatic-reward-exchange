// Kiểm thử các hàm thuần trong extension/shared.js: `npm run test:parse`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('../extension/shared.js', import.meta.url), 'utf8'), context);
const { parseCodes, clampDelay, describeApiResult, describePageMessage, summarize } = context.DFR;
const plain = (value) => JSON.parse(JSON.stringify(value)); // đối tượng từ vm context khác realm

test('tách code theo mọi loại dấu phân cách', () => {
  const text = 'DFUTS26GR2702C57\r\nDFCC0001, LAISEGAME;TrickOrTreat|devstreamtdm : GARENADFNY2501C158\t'
    + 'DELTAFORCEVN_8MD718JT4GR / fvzelRxYajwVViFSTSZ 🎁RCA812';
  assert.deepEqual(plain(parseCodes(text).codes), [
    'DFUTS26GR2702C57', 'DFCC0001', 'LAISEGAME', 'TrickOrTreat', 'devstreamtdm', 'GARENADFNY2501C158',
    'DELTAFORCEVN_8MD718JT4GR', 'fvzelRxYajwVViFSTSZ', 'RCA812',
  ]);
});

test('bỏ từ ngắn, số thuần, chữ có dấu và code trùng', () => {
  const r = plain(parseCodes('Code Delta Force mới: DFCL503\nG3\nAS VAL\n123456789\nDFCL503\nDFSH428'));
  assert.deepEqual(r.codes, ['DFCL503', 'DFSH428']);
  assert.equal(r.duplicates, 1);
  assert.deepEqual(r.ignored, ['Code', 'Delta', 'Force', 'mới', 'G3', 'AS', 'VAL', '123456789']);
});

test('phân biệt hoa/thường khi lọc trùng', () => {
  assert.deepEqual(plain(parseCodes('DFSpark119 dfspark119 DFSpark119').codes), ['DFSpark119', 'dfspark119']);
});

test('cảnh báo code lẫn chữ Nga/Hy Lạp thay vì gửi sai', () => {
  const r = plain(parseCodes('DFAXIOм33\ndevstreаmraptor'));
  assert.deepEqual(r.codes, []);
  assert.deepEqual(r.suspicious, [
    { token: 'DFAXIOм33', suggestion: 'DFAXIOM33' },
    { token: 'devstreаmraptor', suggestion: 'devstreamraptor' },
  ]);
});

test('chuẩn hóa chữ full-width', () => {
  assert.deepEqual(plain(parseCodes('ＤＦ０９２２２Ａ').codes), ['DF09222A']);
});

test('giới hạn thời gian chờ trong khoảng 3–10 giây', () => {
  assert.equal(clampDelay(0), 3000);
  assert.equal(clampDelay(4200), 4000);
  assert.equal(clampDelay(99999), 10000);
  assert.equal(clampDelay('abc'), 6000);
});

test('diễn giải mã phản hồi của máy chủ', () => {
  assert.equal(describeApiResult({ httpStatus: 200, code: 0 }).kind, 'success');
  assert.equal(describeApiResult({ httpStatus: 200, code: 400072 }).kind, 'used');
  assert.equal(describeApiResult({ httpStatus: 200, code: 400054 }).kind, 'invalid');
  assert.equal(describeApiResult({ httpStatus: 200, code: 400070 }).text, 'Code đã hết hạn.');
  assert.equal(describeApiResult({ httpStatus: 200, code: 503701 }).kind, 'network');
  assert.equal(describeApiResult({ httpStatus: 200, code: 300001 }).kind, 'session');
  assert.equal(describeApiResult({ httpStatus: 0, code: null }).kind, 'network');
  assert.equal(describeApiResult({ httpStatus: 502, code: null }).kind, 'network');
  const unknown = describeApiResult({ httpStatus: 200, code: 601008, msg: 'busy' });
  assert.equal(unknown.kind, 'error');
  assert.equal(unknown.unknown, true);
  assert.match(unknown.text, /601008: busy/);
  assert.equal(describeApiResult({ httpStatus: 200, code: 400073 }).unknown, undefined);
});

test('dự phòng bằng thông báo trên trang', () => {
  assert.equal(describePageMessage({ where: 'dialog', text: 'Đã nhận thành công!' }).kind, 'success');
  assert.equal(describePageMessage({ where: 'tips', text: 'error_hint_400072' }).kind, 'used');
  assert.equal(describePageMessage({ where: 'tips', text: 'CDKey đã nhập không hợp lệ.' }).kind, 'error');
});

test('thống kê kết quả', () => {
  const job = { items: ['success', 'used', 'invalid', 'network', 'error', 'pending'].map((status) => ({ status })) };
  assert.deepEqual(plain(summarize(job)), {
    total: 6, done: 5, pending: 1, success: 1, used: 1, invalid: 1, failed: 2,
  });
});

// API 버전: api-v1 (2026-11-15)
// HR×AI 데스크탑 관리 도구(exe)용 창구
// - 기존 '코드.gs'(v4.6)는 건드리지 않음. Apps Script 편집기에서 새 파일 'API'를 만들어 이 코드를 붙여넣음
// - 처음 한 번: setupApi 실행 → 실행 로그에 나온 토큰을 exe 설정 화면에 입력
// - 배포 → 새 배포 → 웹 앱 (실행 계정: 나 / 액세스 권한: 모든 사용자)
// - 코드.gs나 이 파일을 고친 뒤에는 '배포 관리 → 수정 → 버전: 새 버전'을 해야 exe에 반영됨

const API_VERSION = 'api-v1';

// ===== 처음 한 번 실행 =====

// 토큰을 만들고(이미 있으면 그대로) 실행 로그에 보여줌
function setupApi() {
  const props = PropertiesService.getScriptProperties();
  let token = props.getProperty('API_TOKEN');
  if (!token) {
    token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('API_TOKEN', token);
  }
  props.setProperty('SHEET_ID', SpreadsheetApp.getActive().getId());
  Logger.log('API 토큰 (exe 설정 화면에 붙여넣기): ' + token);
}

// 토큰이 새었을 때: 새 토큰으로 교체 (이전 토큰은 바로 못 씀)
function resetApiToken() {
  PropertiesService.getScriptProperties().deleteProperty('API_TOKEN');
  setupApi();
}

// ===== 요청 창구 =====

// exe가 보내는 요청: { token, action, params }
// 응답: { ok: true, data } 또는 { ok: false, error }
function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return apiJson_({ ok: false, error: '요청 형식이 JSON이 아닙니다' });
  }
  const token = PropertiesService.getScriptProperties().getProperty('API_TOKEN');
  if (!token) return apiJson_({ ok: false, error: '시트에서 setupApi를 먼저 실행하세요' });
  if (req.token !== token) return apiJson_({ ok: false, error: '토큰이 맞지 않습니다' });

  const fn = apiActions_()[req.action];
  if (!fn) return apiJson_({ ok: false, error: '알 수 없는 요청: ' + req.action });
  try {
    return apiJson_({ ok: true, data: fn(req.params || {}) });
  } catch (err) {
    return apiJson_({ ok: false, error: err.message });
  }
}

// 브라우저로 URL을 열었을 때 안내 (데이터는 보여주지 않음)
function doGet() {
  return apiJson_({ ok: true, data: { service: 'HR×AI 관리 도구 API', version: API_VERSION } });
}

function apiActions_() {
  return {
    ping: apiPing_,
    status: apiStatus_,
    keywords: apiKeywords_,
    keyword_add: apiKeywordAdd_,
    keyword_status: apiKeywordStatus_,
    run_weekly: apiRunWeekly_,
    run_keywords: apiRunKeywords_,
    pending: apiPending_,
    review_set: apiReviewSet_,
    apply_reviews: apiApplyReviews_,
    cases: apiCases_,
    draft: apiDraft_,
    dashboard: apiDashboard_,
  };
}

// ===== 요청별 처리 =====

function apiPing_() {
  const ss = apiSs_();
  return { version: API_VERSION, sheet: ss.getName(), time: apiVal_(new Date()) };
}

// 홈 화면: 할 일 탭의 마지막 실행 + 주요 숫자
function apiStatus_() {
  const ss = apiSs_();
  const todo = ss.getSheetByName(SHEET_TODO);
  const log = ss.getSheetByName(SHEET_LOG);
  const cases = ss.getSheetByName(SHEET_CASES);
  if (!log || !cases) throw new Error('먼저 시트에서 setup(초기 설정)을 실행하세요');
  const logRows = readRows_(log, LOG_HEADERS.length);
  const kwRows = readRows_(getKw_(ss), KW_HEADERS.length).filter(r => r[KC.KW]);
  return {
    lastRun: todo ? apiVal_(todo.getRange('B2').getValue()) : '',
    lastResult: todo ? String(todo.getRange('B3').getValue()) : '',
    cases: readRows_(cases, 1).filter(r => r[0] !== '').length,
    pending: logRows.filter(r => r[2] === '보류' && !r[7]).length,
    suggested: kwRows.filter(r => r[KC.STATUS] === '제안').length,
    keywordsInUse: kwRows.filter(r => r[KC.STATUS] === '사용').length,
  };
}

function apiKeywords_() {
  return readRows_(getKw_(apiSs_()), KW_HEADERS.length)
    .map((r, i) => ({
      row: i + 2,
      keyword: String(r[KC.KW]).trim(),
      lang: r[KC.LANG] || 'ko',
      status: r[KC.STATUS] || '',
      source: r[KC.SRC] || '',
      total: Number(r[KC.TOTAL]) || 0,
      recent: Number(r[KC.RECENT]) || 0,
      reason: r[KC.REASON] || '',
      added: apiVal_(r[KC.DATE]),
    }))
    .filter(k => k.keyword);
}

function apiKeywordAdd_(p) {
  const k = String(p.keyword || '').trim();
  if (!k) throw new Error('키워드가 비어 있습니다');
  const kw = getKw_(apiSs_());
  const exists = readRows_(kw, KW_HEADERS.length)
    .some(r => String(r[KC.KW]).trim().toLowerCase() === k.toLowerCase());
  if (exists) throw new Error('이미 있는 키워드입니다: ' + k);
  kw.appendRow([false, k, p.lang === 'en' ? 'en' : 'ko', '사용', '직접 추가', 0, 0, '', new Date()]);
  return apiKeywords_();
}

// 행 번호와 키워드가 둘 다 맞을 때만 바꿈 (그사이 시트에서 행이 바뀐 경우 보호)
function apiKeywordStatus_(p) {
  const allowed = ['사용', '제안', '거절', '중지'];
  if (allowed.indexOf(p.status) < 0) throw new Error('상태는 사용/제안/거절/중지 중 하나여야 합니다');
  const kw = getKw_(apiSs_());
  const items = [].concat(p.items || []);
  items.forEach(it => {
    const cur = String(kw.getRange(it.row, KC.KW + 1).getValue()).trim();
    if (cur !== it.keyword) throw new Error('시트가 바뀌었습니다. 새로고침 후 다시 시도하세요 (' + it.keyword + ')');
  });
  items.forEach(it => kw.getRange(it.row, KC.STATUS + 1).setValue(p.status));
  return apiKeywords_();
}

function apiRunWeekly_() {
  withLock_(runWeekly_);
  return apiStatus_();
}

function apiRunKeywords_(p) {
  const names = [].concat(p.names || []);
  if (!names.length) throw new Error('키워드를 하나 이상 고르세요');
  const text = runKeywordsFromPicker(names);
  return { text: text, status: apiStatus_() };
}

// 보류 목록: 사람이 아직 판정하지 않은 것
function apiPending_() {
  const log = apiSs_().getSheetByName(SHEET_LOG);
  return readRows_(log, LOG_HEADERS.length)
    .map((r, i) => ({ row: i + 2, r: r }))
    .filter(x => x.r[2] === '보류' && !x.r[7])
    .map(x => ({
      row: x.row,
      date: apiVal_(x.r[0]),
      keyword: x.r[1],
      score: x.r[3],
      reason: x.r[4],
      title: x.r[5],
      url: x.r[6],
    }));
}

// 사람판정 칸에 '사례로 추가' 또는 '제외 확정'을 적음 (반영은 apply_reviews에서)
function apiReviewSet_(p) {
  const allowed = ['사례로 추가', '제외 확정'];
  if (allowed.indexOf(p.decision) < 0) throw new Error('판정은 사례로 추가/제외 확정 중 하나여야 합니다');
  const log = apiSs_().getSheetByName(SHEET_LOG);
  const items = [].concat(p.items || []);
  items.forEach(it => {
    if (String(log.getRange(it.row, 7).getValue()) !== it.url) {
      throw new Error('검사기록이 바뀌었습니다. 새로고침 후 다시 시도하세요');
    }
  });
  items.forEach(it => log.getRange(it.row, 8).setValue(p.decision));
  return apiPending_();
}

function apiApplyReviews_() {
  const n = withLock_(() => applyReviews_(apiSs_()));
  updateKeywordStats_(apiSs_());
  return { done: n, status: apiStatus_() };
}

// 사례 탭 최근 N건 (최신이 위)
function apiCases_(p) {
  const limit = Math.min(Number(p.limit) || 100, 300);
  const rows = readRows_(apiSs_().getSheetByName(SHEET_CASES), HEADERS.length)
    .filter(r => r[0] !== '');
  return rows.slice(-limit).reverse().map(r => {
    const o = {};
    HEADERS.forEach((h, i) => { o[h] = apiVal_(r[i]); });
    return o;
  });
}

// 이번 주 초안 탭 최신 1건 + 지난 초안 목록(날짜만)
function apiDraft_() {
  const rows = readRows_(apiSs_().getSheetByName(SHEET_DRAFT), 2).filter(r => r[1]);
  return {
    latest: rows.length ? { date: apiVal_(rows[0][0]), text: String(rows[0][1]) } : null,
    history: rows.slice(0, 20).map(r => ({ date: apiVal_(r[0]), text: String(r[1]) })),
  };
}

// 대시보드: HR 기능·AI 유형·국가별 사례 수, 주별 채택 수
function apiDashboard_() {
  const rows = readRows_(apiSs_().getSheetByName(SHEET_CASES), HEADERS.length)
    .filter(r => r[0] !== '');
  const count = idx => {
    const c = {};
    rows.forEach(r => { const k = r[idx] || '미분류'; c[k] = (c[k] || 0) + 1; });
    return c;
  };
  const byFunc = {};
  HR_FUNCS.forEach(f => { byFunc[f] = 0; });
  rows.forEach(r => { if (r[4] in byFunc) byFunc[r[4]]++; });
  const byWeek = {};
  rows.forEach(r => {
    if (!(r[0] instanceof Date)) return;
    const d = new Date(r[0]);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7));  // 그 주 월요일
    const k = Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
    byWeek[k] = (byWeek[k] || 0) + 1;
  });
  return { total: rows.length, byFunc: byFunc, byType: count(5), byCountry: count(2), byWeek: byWeek };
}

// ===== 내부 도우미 =====

function apiSs_() {
  const ss = SpreadsheetApp.getActive();
  if (ss) return ss;
  const id = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  if (!id) throw new Error('시트에서 setupApi를 먼저 실행하세요');
  return SpreadsheetApp.openById(id);
}

// 날짜는 'yyyy-MM-dd HH:mm' 글자로, 나머지는 그대로
function apiVal_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  return v === null || v === undefined ? '' : v;
}

function apiJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

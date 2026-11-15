// 버전: v4.6 (2026-11-15)
// HR×AI 사례 아카이브 자동화 (구글 시트 + Apps Script)
// 처음 한 번: setup 실행 → 이후 매주 월요일 오전 8시에 runWeekly 자동 실행
// 키워드는 '키워드' 탭에서 관리 (상태가 '사용'인 것만 수집에 쓰임)

// ===== 설정 (여기만 바꾸면 됨) =====
const MAX_ARTICLES = 40;          // 한 번에 AI로 검사할 최대 기사 수 (키워드를 돌아가며 고르게 뽑음)
const BATCH_SIZE = 5;             // AI 한 번에 판별할 기사 수 (호출 수·비용 절감)
const MODEL = 'claude-sonnet-5-5';
const RUN_DAY = ScriptApp.WeekDay.MONDAY;
const RUN_HOUR = 8;               // 0~23, 프로젝트 시간대 기준
const LOG_KEEP_DAYS = 30;         // 검사기록 보관 기간 (사람 판정을 남긴 행은 계속 보관)
const SCORE_ACCEPT = 70;          // 확신도 이상이면 채택
const SCORE_REJECT = 30;          // 확신도 이하면 제외, 그 사이는 2차 검토
// ==================================

// 처음 '키워드' 탭을 만들 때 넣는 기본 키워드
const DEFAULT_KEYWORDS = [
  ['AI 채용 도입', 'ko'], ['AI 면접', 'ko'], ['AI 역량검사', 'ko'], ['채용 챗봇', 'ko'],
  ['AI 교육 플랫폼 도입', 'ko'], ['사내 AI 교육', 'ko'], ['AI 인사관리', 'ko'],
  ['HR 생성형 AI', 'ko'], ['인사 챗봇', 'ko'], ['AI 채용 규제', 'ko'],
  ['AI in recruiting', 'en'], ['AI hiring', 'en'], ['HR generative AI', 'en'],
];

const SHEET_CASES = '사례';
const SHEET_DRAFT = '이번 주 초안';
const SHEET_DASH = '대시보드';
const SHEET_LOG = '검사기록';
const SHEET_KW = '키워드';
const SHEET_TODO = '할 일';
const HEADERS = ['수집일', '기업기관명', '국가', '업종', 'HR기능', 'AI유형', '한줄요약',
  '도입배경', '결과수치', '시사점초안', '기사제목', '출처URL', '포스팅여부'];
const LOG_HEADERS = ['검사일', '키워드', 'AI판정', '확신도', '사유', '기사제목', '출처URL', '사람판정', '처리'];
const KW_HEADERS = ['선택', '키워드', '언어', '상태', '출처', '누적 채택', '최근 4주 채택', '제안 이유', '추가일'];
const KC = { SEL: 0, KW: 1, LANG: 2, STATUS: 3, SRC: 4, TOTAL: 5, RECENT: 6, REASON: 7, DATE: 8 };  // 키워드 탭 열 위치
const HR_FUNCS = ['채용', '교육·육성', '평가·보상', '조직문화', 'HR 운영', '정책·규제'];
const TIME_LIMIT_MS = 4 * 60 * 1000;  // 기사 검사에 쓰는 최대 시간 (전체 6분 제한 대비)
const FLUSH_EVERY = 10;               // 기사 N건 검사할 때마다 시트에 저장 (중간에 멈춰도 앞부분은 남김)
let claudeCalls = 0;                  // 이번 실행의 AI 호출 수 (전후 비교용)

// 시트를 열 때 상단에 'HR×AI 자동화' 메뉴 추가
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('HR×AI 자동화')
    .addItem('지금 수집 실행', 'runWeekly')
    .addItem('체크한 키워드만 수집 (키워드 탭 체크박스)', 'runChecked')
    .addItem('키워드 골라서 수집 (선택 창)', 'openKeywordPicker')
    .addItem('재검토 반영 (사람판정 처리)', 'applyReviews')
    .addItem('초기 설정 (탭·차트·예약)', 'setup')
    .addSeparator()
    .addSubMenu(ui.createMenu('데이터 정리')
      .addItem('날짜 지정 삭제', 'deleteByDate')
      .addItem('전체 초기화', 'resetAll'))
    .addToUi();
  try {
    getKw_(SpreadsheetApp.getActive());  // 시트를 열 때 키워드 탭 구조를 최신으로 맞춤 ('선택' 체크박스 열)
  } catch (e) {
    Logger.log(`키워드 탭 확인 실패: ${e.message}`);
  }
}

// 처음 한 번 실행: 탭, 대시보드, 주간 예약 생성 (데이터는 지우지 않음)
function setup() {
  const ss = SpreadsheetApp.getActive();

  // 맨 앞 '할 일' 탭: 마지막 실행 결과 + 사람이 볼 항목(보류, 키워드 제안) 자동 목록
  const todo = ss.getSheetByName(SHEET_TODO) || ss.insertSheet(SHEET_TODO, 0);
  todo.clear();
  todo.getRange('A1').setValue('할 일').setFontWeight('bold').setFontSize(14);
  todo.getRange('A2:A3').setValues([['마지막 실행'], ['결과']]).setFontWeight('bold');
  todo.getRange('A5').setValue('보류: 검사기록 탭 사람판정 칸에서 선택 → 메뉴 \'재검토 반영\'').setFontWeight('bold');
  todo.getRange('A6:C6').setValues([['기사제목', '사유', '출처URL']]).setFontWeight('bold');
  todo.getRange('A7').setFormula(
    `=IFERROR(CHOOSECOLS(FILTER('${SHEET_LOG}'!A2:I,'${SHEET_LOG}'!C2:C="보류",'${SHEET_LOG}'!H2:H=""),6,5,7),"없음")`);
  todo.getRange('E5').setValue('키워드 제안: 키워드 탭 상태를 \'사용\' 또는 \'거절\'로 변경').setFontWeight('bold');
  todo.getRange('E6:F6').setValues([['키워드', '제안 이유']]).setFontWeight('bold');
  todo.getRange('E7').setFormula(
    `=IFERROR(CHOOSECOLS(FILTER('${SHEET_KW}'!A2:I,'${SHEET_KW}'!D2:D="제안"),2,8),"없음")`);
  todo.setColumnWidth(1, 360);
  todo.setColumnWidth(5, 200);
  todo.setColumnWidth(6, 300);

  const cases = getOrCreate_(ss, SHEET_CASES);
  if (cases.getLastRow() === 0) {
    cases.appendRow(HEADERS);
    cases.setFrozenRows(1);
    cases.getRange(1, 1, 1, HEADERS.length).setFontWeight('bold');
  }
  cases.getRange('M2:M').setDataValidation(listRule_(['대기', '게시완료']));

  const draft = getOrCreate_(ss, SHEET_DRAFT);
  if (draft.getLastRow() === 0) {
    draft.appendRow(['생성일', '블로그 초안']);
    draft.setFrozenRows(1);
    draft.getRange(1, 1, 1, 2).setFontWeight('bold');
    draft.setColumnWidth(2, 700);
  }

  const dash = getOrCreate_(ss, SHEET_DASH);
  dash.clear();
  dash.getCharts().forEach(c => dash.removeChart(c));
  dash.getRange(1, 1, 1, 2).setValues([['HR 기능', '사례 수']]).setFontWeight('bold');
  HR_FUNCS.forEach((f, i) => {
    dash.getRange(i + 2, 1).setValue(f);
    dash.getRange(i + 2, 2).setFormula(`=COUNTIF('${SHEET_CASES}'!E:E,A${i + 2})`);
  });
  const chart = dash.newChart()
    .setChartType(Charts.ChartType.BAR)
    .addRange(dash.getRange(1, 1, HR_FUNCS.length + 1, 2))
    .setPosition(1, 4, 0, 0)
    .setOption('title', 'HR 기능별 누적 사례 수')
    .setOption('legend', { position: 'none' })
    .build();
  dash.insertChart(chart);

  const log = getOrCreate_(ss, SHEET_LOG);
  if (log.getLastRow() === 0) {
    log.appendRow(LOG_HEADERS);
    log.setFrozenRows(1);
    log.getRange(1, 1, 1, LOG_HEADERS.length).setFontWeight('bold');
    log.setColumnWidth(6, 360);
  }
  log.getRange('H2:H').setDataValidation(listRule_(['사례로 추가', '제외 확정']));

  getKw_(ss);

  const oldSeen = ss.getSheetByName('_seen');  // v3 이하에서 쓰던 탭 정리
  if (oldSeen) ss.deleteSheet(oldSeen);

  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'runWeekly')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('runWeekly').timeBased().onWeekDay(RUN_DAY).atHour(RUN_HOUR).create();

  Logger.log('초기 설정 완료: 탭, 대시보드, 주간 예약 생성됨');
}

// 전체 초기화: 사례·초안·검사기록을 비움. 키워드 탭은 선택에 따라 기본값으로 되돌림
function resetAll() {
  const ui = SpreadsheetApp.getUi();
  const kwAns = ui.alert('전체 초기화 (1/2)',
    '키워드 탭도 기본 키워드로 되돌릴까요?\n\n예: 키워드까지 초기화\n아니요: 키워드는 그대로 유지',
    ui.ButtonSet.YES_NO_CANCEL);
  if (kwAns !== ui.Button.YES && kwAns !== ui.Button.NO) return;
  const resetKw = kwAns === ui.Button.YES;

  const ok = ui.alert('전체 초기화 (2/2)',
    `사례, 이번 주 초안, 검사기록${resetKw ? ', 키워드를' : '을'} 모두 지웁니다. 되돌릴 수 없습니다. 진행할까요?`,
    ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  const ss = SpreadsheetApp.getActive();
  const targets = [SHEET_CASES, SHEET_DRAFT, SHEET_LOG].concat(resetKw ? [SHEET_KW] : []);
  targets.forEach(name => {
    const sh = ss.getSheetByName(name);
    if (sh && sh.getMaxRows() > 1) {
      sh.getRange(2, 1, sh.getMaxRows() - 1, sh.getMaxColumns()).clearContent();
    }
  });
  if (resetKw) seedKeywords_(getKw_(ss));
  updateKeywordStats_(ss);
  writeTodo_(ss, '전체 초기화됨');
  ui.alert('초기화 완료. 메뉴에서 \'지금 수집 실행\'을 누르면 처음부터 다시 수집합니다.');
}

// 날짜 지정 삭제: 그 기간의 사례·초안·검사기록 삭제 (+ 선택하면 그 기간에 추가된 키워드)
function deleteByDate() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();
  const res = ui.prompt('날짜 지정 삭제',
    '지울 날짜를 입력하세요.\n하루: 2026-11-14\n기간: 2026-11-10~2026-11-14',
    ui.ButtonSet.OK_CANCEL);
  if (res.getSelectedButton() !== ui.Button.OK) return;
  const range = parseDateRange_(res.getResponseText());
  if (!range) {
    ui.alert('날짜 형식이 맞지 않습니다. 예: 2026-11-14 또는 2026-11-10~2026-11-14');
    return;
  }
  const [from, to] = range;
  const label = from === to ? from : `${from} ~ ${to}`;
  const inRange = v => { const k = dateKey_(v); return k && k >= from && k <= to; };

  const cases = ss.getSheetByName(SHEET_CASES);
  const draft = ss.getSheetByName(SHEET_DRAFT);
  const log = ss.getSheetByName(SHEET_LOG);
  const kw = getKw_(ss);
  const nCases = readRows_(cases, 1).filter(r => inRange(r[0])).length;
  const nDraft = readRows_(draft, 1).filter(r => inRange(r[0])).length;
  const nLog = readRows_(log, 1).filter(r => inRange(r[0])).length;
  const kwMatch = r => inRange(r[KC.DATE]) && r[KC.STATUS] !== '사용';
  const nKw = readRows_(kw, KW_HEADERS.length).filter(kwMatch).length;

  let delKw = false;
  if (nKw) {
    const kwAns = ui.alert('키워드 포함 여부',
      `이 기간에 추가된 키워드 ${nKw}개도 삭제할까요?\n(상태가 '사용'인 키워드는 남깁니다)`,
      ui.ButtonSet.YES_NO_CANCEL);
    if (kwAns !== ui.Button.YES && kwAns !== ui.Button.NO) return;
    delKw = kwAns === ui.Button.YES;
  }
  const ok = ui.alert('날짜 지정 삭제',
    `${label} 기간의 사례 ${nCases}건, 초안 ${nDraft}건, 검사기록 ${nLog}건` +
    `${delKw ? `, 키워드 ${nKw}개를` : '을'} 삭제합니다.\n` +
    '검사기록이 지워진 기사는 다음 수집 때 다시 검사됩니다(최근 7일 기사만). 진행할까요?',
    ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  deleteRowsWhere_(cases, 1, r => inRange(r[0]));
  deleteRowsWhere_(draft, 1, r => inRange(r[0]));
  deleteRowsWhere_(log, 1, r => inRange(r[0]));
  if (delKw) deleteRowsWhere_(kw, KW_HEADERS.length, kwMatch);
  updateKeywordStats_(ss);
  writeTodo_(ss, `${label} 데이터 삭제됨`);
  ui.alert('삭제 완료');
}

// 키워드 탭 '선택' 칸에 체크한 키워드로만 수집 (상태 무관). 끝나면 체크 해제
function runChecked() {
  const ui = SpreadsheetApp.getUi();
  const ss = SpreadsheetApp.getActive();
  const kw = getKw_(ss);
  const picked = [];
  readRows_(kw, KW_HEADERS.length).forEach((r, i) => {
    if (r[KC.SEL] === true && r[KC.KW]) {
      picked.push({ row: i + 2, keyword: String(r[KC.KW]).trim(), lang: r[KC.LANG] === 'en' ? 'en' : 'ko' });
    }
  });
  if (!picked.length) {
    ui.alert('키워드 탭의 \'선택\' 칸에 체크한 키워드가 없습니다.');
    return;
  }
  const text = withLock_(() => runKeywordSet_(ss, picked));
  picked.forEach(p => kw.getRange(p.row, KC.SEL + 1).setValue(false));
  ui.alert('체크한 키워드 실행 결과', text, ui.ButtonSet.OK);
}

// 선택 창: 키워드 목록을 상태별 체크박스로 보여주고, 고른 키워드로만 수집
function openKeywordPicker() {
  const items = readRows_(getKw_(SpreadsheetApp.getActive()), KW_HEADERS.length)
    .filter(r => r[KC.KW])
    .map(r => ({ k: String(r[KC.KW]).trim(), s: r[KC.STATUS] || '미지정', n: r[KC.TOTAL] || 0 }));
  const data = JSON.stringify(items).replace(/</g, '\\u003c');
  const html = HtmlService.createHtmlOutput(PICKER_HTML.replace('__DATA__', () => data))
    .setWidth(440).setHeight(560);
  SpreadsheetApp.getUi().showModalDialog(html, '키워드 골라서 수집');
}

// 선택 창의 '실행' 버튼이 부르는 함수
function runKeywordsFromPicker(names) {
  const ss = SpreadsheetApp.getActive();
  const wanted = new Set(names);
  const picked = readRows_(getKw_(ss), KW_HEADERS.length)
    .filter(r => wanted.has(String(r[KC.KW]).trim()))
    .map(r => ({ keyword: String(r[KC.KW]).trim(), lang: r[KC.LANG] === 'en' ? 'en' : 'ko' }));
  if (!picked.length) return '선택한 키워드가 없습니다.';
  return withLock_(() => runKeywordSet_(ss, picked));
}

// 메뉴용: 검사기록의 사람판정을 지금 바로 반영
function applyReviews() {
  const n = withLock_(() => applyReviews_(SpreadsheetApp.getActive()));
  SpreadsheetApp.getUi().alert(`재검토 반영 완료: ${n}건 처리`);
}

// 매주 자동 실행 (수동 실행과 겹치지 않게 잠금)
function runWeekly() {
  withLock_(runWeekly_);
}

function runWeekly_() {
  const startedAt = Date.now();
  const ss = SpreadsheetApp.getActive();
  const cases = ss.getSheetByName(SHEET_CASES);
  const log = ss.getSheetByName(SHEET_LOG);
  const kwSheet = getKw_(ss);
  if (!cases || !log) throw new Error('먼저 setup(초기 설정)을 실행하세요');

  // 1) 지난주 사람판정 반영 → 2) 오류·오래된 기록 정리
  const reviewed = applyReviews_(ss);
  if (reviewed) Logger.log(`재검토 반영: ${reviewed}건`);
  cleanupLog_(log);

  // 3) 수집
  const keywords = loadKeywords_(kwSheet);
  const logRows = readRows_(log, LOG_HEADERS.length);  // 검사기록은 한 번만 읽어 재사용
  const seen = new Set(logRows.map(r => r[6]));
  const articles = collectArticles_(keywords, seen);
  Logger.log(`키워드 ${keywords.length}개, 새 기사 ${articles.length}건 검사 시작`);

  // 4) 판별
  const { newRows, perKw, stat } = judgeArticles_(ss, articles, startedAt, logRows);
  const today = new Date();

  // 5) 초안
  if (newRows.length) {
    const rowsText = newRows.map(r =>
      `- ${r[1]} | ${r[4]} | ${r[5]} | ${r[6]} | 배경: ${r[7]} | 결과: ${r[8]} | 시사점: ${r[9]} | 출처: ${r[11]}`
    ).join('\n');
    const week = Math.floor((today.getDate() - 1) / 7) + 1;
    const draftText = callClaude_(draftPrompt_(today.getMonth() + 1, week, rowsText), 4000);
    const draftSheet = ss.getSheetByName(SHEET_DRAFT);
    draftSheet.insertRowAfter(1);
    draftSheet.getRange(2, 1, 1, 2).setValues([[today, draftText]])
      .setWrap(true).setVerticalAlignment('top');
  }

  // 6) 키워드 성과 집계 + 새 키워드 제안
  updateKeywordStats_(ss);
  let suggested = 0;
  try {
    suggested = suggestKeywords_(ss, newRows);
  } catch (e) {
    Logger.log(`키워드 제안 실패: ${e.message}`);
  }

  // 7) 알림
  const newPending = Object.keys(perKw).reduce((s, k) => s + (perKw[k]['보류'] || 0), 0);
  const pending = logRows.filter(r => r[2] === '보류' && !r[7]).length + newPending;
  Logger.log(`완료: 채택 ${newRows.length}건, 보류 대기 ${pending}건, 키워드 제안 ${suggested}개`);
  writeTodo_(ss, `채택 ${newRows.length}건 · 보류 대기 ${pending}건 · 키워드 제안 ${suggested}개 · ${stat}`);
}

// ----- 아래는 내부 함수 -----

function getOrCreate_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function listRule_(values) {
  return SpreadsheetApp.newDataValidation().requireValueInList(values).build();
}

// 제목 줄을 뺀 데이터 행 전체 (없으면 빈 배열)
function readRows_(sheet, cols) {
  const last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, cols).getValues();
}

// 맨 아래에 여러 행을 한 번에 추가 (행이 모자라면 먼저 늘림)
function appendRows_(sheet, rows) {
  if (!rows.length) return;
  const start = sheet.getLastRow() + 1;
  const need = start + rows.length - 1 - sheet.getMaxRows();
  if (need > 0) sheet.insertRowsAfter(sheet.getMaxRows(), need);
  sheet.getRange(start, 1, rows.length, rows[0].length).setValues(rows);
}

// 동시에 두 번 실행되지 않게 잠금 (수동 실행과 예약 실행이 겹칠 때)
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('다른 수집이 실행 중입니다. 잠시 후 다시 시도하세요');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// 기사 목록을 판별해 사례·검사기록에 기록. 키워드별 판정 집계도 돌려줌
function judgeArticles_(ss, articles, startedAt, logRows) {
  const cases = ss.getSheetByName(SHEET_CASES);
  const log = ss.getSheetByName(SHEET_LOG);
  const examples = loadExamples_(logRows || readRows_(log, LOG_HEADERS.length));
  const recent = loadRecent_(cases);
  const today = new Date();
  const newRows = [];
  const perKw = {};
  const caseBuf = [], logBuf = [];
  const flush = () => {  // 사례 → 검사기록 순서로 한 번에 저장
    appendRows_(cases, caseBuf);
    appendRows_(log, logBuf);
    caseBuf.length = 0;
    logBuf.length = 0;
  };
  const t0 = Date.now(), calls0 = claudeCalls;
  let judged = 0;
  try {
    for (let i = 0; i < articles.length; i += BATCH_SIZE) {
      if (Date.now() - startedAt > TIME_LIMIT_MS) {
        Logger.log('시간 제한에 가까워 나머지 기사는 다음 실행으로 넘김');
        break;
      }
      const batch = articles.slice(i, i + BATCH_SIZE);
      const results = judgeBatchSafe_(batch, recent, examples);
      batch.forEach((a, j) => {
        let verdict, score = '', reason = '', card = null;
        try {
          const r = results[j];
          if (r.error) throw new Error(r.error);
          score = Number(r.case_score) || 0;
          reason = r.reason || '';
          card = r;
          if (r.is_duplicate) {
            verdict = '중복';
          } else if (score >= SCORE_ACCEPT) {
            verdict = '채택';
          } else if (score <= SCORE_REJECT) {
            verdict = '제외';
          } else {
            const r2 = secondOpinion_(a, r);
            verdict = ['채택', '제외', '보류'].includes(r2.decision) ? r2.decision : '보류';
            reason = `[2차] ${r2.reason || ''} / [1차] ${reason}`;
          }
        } catch (e) {
          verdict = '오류';
          reason = e.message;
        }

        if (verdict === '채택') {
          const row = caseRow_(today, card, a);
          caseBuf.push(row);
          newRows.push(row);
          recent.push(`${row[1]} | ${row[6]}`);
        }
        logBuf.push([today, a.keyword, verdict, score, reason, a.title, a.link, '', '']);
        perKw[a.keyword] = perKw[a.keyword] || {};
        perKw[a.keyword][verdict] = (perKw[a.keyword][verdict] || 0) + 1;
        judged++;
        Logger.log(`${verdict}: ${a.title.slice(0, 40)}`);
      });
      if (logBuf.length >= FLUSH_EVERY) flush();
    }
  } finally {
    flush();
  }
  const stat = `판별 ${judged}건 · AI 호출 ${claudeCalls - calls0}회 · ${Math.round((Date.now() - t0) / 1000)}초`;
  Logger.log(stat);
  return { newRows, perKw, stat };
}

function writeTodo_(ss, text) {
  const todo = ss.getSheetByName(SHEET_TODO);
  if (todo) todo.getRange('B2:B3').setValues([[new Date()], [text]]);
}

function seedKeywords_(kw) {
  const today = new Date();
  DEFAULT_KEYWORDS.forEach(([k, lang]) => kw.appendRow([false, k, lang, '사용', '기본', 0, 0, '', today]));
}

// 키워드 탭을 돌려줌. 없으면 만들고, v4.2 이하 구조면 맨 앞에 '선택' 체크박스 열을 추가
function getKw_(ss) {
  const kw = ss.getSheetByName(SHEET_KW) || ss.insertSheet(SHEET_KW);
  let changed = false;
  if (kw.getLastRow() === 0) {
    kw.appendRow(KW_HEADERS);
    kw.setFrozenRows(1);
    kw.getRange(1, 1, 1, KW_HEADERS.length).setFontWeight('bold');
    seedKeywords_(kw);
    changed = true;
  } else if (kw.getRange(1, 1).getValue() !== '선택') {
    kw.insertColumnBefore(1);
    kw.getRange(1, 1).setValue('선택').setFontWeight('bold');
    if (kw.getRange(1, KC.DATE + 1).getValue() !== '추가일') {
      kw.getRange(1, KC.DATE + 1).setValue('추가일').setFontWeight('bold');
    }
    changed = true;
  }
  if (changed) {
    kw.getRange('A2:A').setDataValidation(SpreadsheetApp.newDataValidation().requireCheckbox().build());
    kw.getRange('C2:C').setDataValidation(listRule_(['ko', 'en']));
    kw.getRange('D2:D').setDataValidation(listRule_(['사용', '제안', '거절', '중지']));
    kw.setColumnWidth(1, 50);
  }
  return kw;
}

// 고른 키워드로 수집·판별하고 키워드별 결과 요약을 돌려줌 (초안·키워드 제안은 만들지 않음)
function runKeywordSet_(ss, keywords) {
  const startedAt = Date.now();
  const log = ss.getSheetByName(SHEET_LOG);
  if (!log || !ss.getSheetByName(SHEET_CASES)) throw new Error('먼저 setup(초기 설정)을 실행하세요');
  cleanupLog_(log);
  const logRows = readRows_(log, LOG_HEADERS.length);
  const seen = new Set(logRows.map(r => r[6]));
  const articles = collectArticles_(keywords, seen);
  const result = judgeArticles_(ss, articles, startedAt, logRows);
  updateKeywordStats_(ss);
  const lines = keywords.map(({ keyword }) => {
    const c = result.perKw[keyword] || {};
    const total = Object.values(c).reduce((x, y) => x + y, 0);
    const parts = ['채택', '보류', '제외', '중복', '오류'].filter(k => c[k]).map(k => `${k} ${c[k]}`);
    return `- ${keyword}: 새 기사 ${total}건${parts.length ? ' → ' + parts.join(' · ') : ''}`;
  });
  writeTodo_(ss, `선택 실행(${keywords.length}개 키워드): 채택 ${result.newRows.length}건 · ${result.stat}`);
  return lines.join('\n');
}

// 날짜 칸 값 → 'yyyy-MM-dd' (프로젝트 시간대 기준), 날짜가 아니면 ''
function dateKey_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  const m = String(v || '').match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
}

// '2026-11-14' 또는 '2026-11-10~2026-11-14' → ['from', 'to'], 형식이 틀리면 null
function parseDateRange_(text) {
  const parts = String(text || '').split('~').map(t => dateKey_(t.trim()));
  if (!parts[0] || parts.length > 2 || (parts.length === 2 && !parts[1])) return null;
  const from = parts[0], to = parts[1] || parts[0];
  return from <= to ? [from, to] : [to, from];
}

// 조건에 맞는 데이터 행을 아래에서부터 삭제
function deleteRowsWhere_(sheet, cols, fn) {
  const rows = readRows_(sheet, cols);
  for (let i = rows.length - 1; i >= 0; i--) {
    if (fn(rows[i])) sheet.deleteRow(i + 2);
  }
}

function caseRow_(date, c, a) {
  return [date, c['기업기관명'], c['국가'], c['업종'], c['HR기능'], c['AI유형'],
    c['한줄요약'], c['도입배경'], c['결과수치'], c['시사점초안'], a.title, a.link, '대기']
    .map(v => (v === undefined || v === null) ? '' : v);
}

// 검사기록의 사람판정 처리: '사례로 추가' → 사례 탭에 추가 / '제외 확정' → 사례 탭에서 삭제
function applyReviews_(ss) {
  const log = ss.getSheetByName(SHEET_LOG);
  const cases = ss.getSheetByName(SHEET_CASES);
  const rows = readRows_(log, LOG_HEADERS.length);
  let done = 0;
  rows.forEach((r, i) => {
    const human = r[7], processed = r[8];
    if (!human || processed) return;
    const rowNo = i + 2;
    const a = { title: r[5], link: r[6], summary: '' };
    try {
      if (human === '사례로 추가' && r[2] !== '채택') {
        const card = parseJson_(callClaude_(cardPrompt_(a), 1000));
        cases.appendRow(caseRow_(new Date(), card, a));
      } else if (human === '제외 확정' && r[2] === '채택') {
        const caseRows = readRows_(cases, HEADERS.length);
        for (let j = caseRows.length - 1; j >= 0; j--) {
          if (caseRows[j][11] === r[6]) cases.deleteRow(j + 2);
        }
      }
      log.getRange(rowNo, 9).setValue('완료');
      done++;
    } catch (e) {
      Logger.log(`재검토 실패 (${rowNo}행): ${e.message}`);
    }
  });
  return done;
}

// 오류 행(다음 실행에서 재검사)과 보관 기간 지난 행 삭제. 사람판정이 있는 행은 남김
// 남길 행을 위에서부터 다시 쓴 뒤 남는 아래쪽을 비움 (도중에 멈춰도 데이터는 지워지지 않음)
function cleanupLog_(log) {
  const rows = readRows_(log, LOG_HEADERS.length);
  const cutoff = Date.now() - LOG_KEEP_DAYS * 24 * 60 * 60 * 1000;
  const keep = rows.filter(r => {
    if (r[7]) return true;
    const old = r[0] instanceof Date && r[0].getTime() < cutoff;
    return !(r[2] === '오류' || old);
  });
  if (keep.length === rows.length) return;
  if (keep.length) log.getRange(2, 1, keep.length, LOG_HEADERS.length).setValues(keep);
  log.getRange(2 + keep.length, 1, rows.length - keep.length, LOG_HEADERS.length).clearContent();
}

function loadKeywords_(kwSheet) {
  return readRows_(kwSheet, KW_HEADERS.length)
    .filter(r => r[KC.KW] && r[KC.STATUS] === '사용')
    .map(r => ({ keyword: String(r[KC.KW]).trim(), lang: r[KC.LANG] === 'en' ? 'en' : 'ko' }));
}

// 사람판정이 있는 최근 10건 → 판별 기준 학습용 예시
function loadExamples_(rows) {
  return rows
    .filter(r => r[7])
    .slice(-10)
    .map(r => `- "${r[5]}" → 사람 판단: ${r[7] === '사례로 추가' ? '사례임' : '사례 아님'} (AI 1차 판정: ${r[2]})`);
}

// 사례 탭의 최근 50건 (기업 | 한 줄 요약) — 중복 판별용
function loadRecent_(cases) {
  return readRows_(cases, 7).slice(-50).map(v => `${v[1]} | ${v[6]}`);
}

function updateKeywordStats_(ss) {
  const kwSheet = getKw_(ss);
  const log = ss.getSheetByName(SHEET_LOG);
  if (!log) return;
  const kws = readRows_(kwSheet, KW_HEADERS.length);
  if (!kws.length) return;
  const since = Date.now() - 28 * 24 * 60 * 60 * 1000;
  const total = {}, recent = {};
  readRows_(log, LOG_HEADERS.length).forEach(r => {
    const adopted = r[2] === '채택' || r[7] === '사례로 추가';
    if (!adopted || r[7] === '제외 확정') return;
    total[r[1]] = (total[r[1]] || 0) + 1;
    if (r[0] instanceof Date && r[0].getTime() >= since) recent[r[1]] = (recent[r[1]] || 0) + 1;
  });
  const values = kws.map(r => [total[r[KC.KW]] || 0, recent[r[KC.KW]] || 0]);
  kwSheet.getRange(2, KC.TOTAL + 1, values.length, 2).setValues(values);
}

function suggestKeywords_(ss, newRows) {
  const kwSheet = getKw_(ss);
  const kws = readRows_(kwSheet, KW_HEADERS.length);
  const existing = new Set(kws.map(r => String(r[KC.KW]).trim().toLowerCase()));
  const kwText = kws.map(r => `- ${r[KC.KW]} (${r[KC.STATUS]}, 누적 채택 ${r[KC.TOTAL]})`).join('\n');
  const funcCount = {};
  readRows_(ss.getSheetByName(SHEET_CASES), 5).forEach(r => { funcCount[r[4]] = (funcCount[r[4]] || 0) + 1; });
  const funcText = HR_FUNCS.map(f => `${f}: ${funcCount[f] || 0}건`).join(', ');
  const caseText = newRows.length
    ? newRows.map(r => `- ${r[1]} | ${r[4]} | ${r[6]}`).join('\n')
    : '(이번 실행에서 채택된 사례 없음)';

  const text = callClaude_(`너는 HR×AI 사례 수집용 구글 뉴스 검색 키워드를 관리한다.
아래 정보를 보고 새로 추가하면 좋을 검색 키워드를 3~5개 제안하라.
- 사례가 적은 HR 기능을 우선 보강한다.
- 이번 주 채택 사례에 나온 표현 중 검색에 쓸 만한 것을 활용한다.
- 이미 있는 키워드(상태 무관)와 같거나 거의 같은 것은 제안하지 않는다.
- 2~4단어의 짧은 검색어로 쓴다. 한국어 위주, 필요하면 영어(en)도 가능.

반드시 JSON 배열 하나만 출력하라.
[{"keyword": "", "lang": "ko 또는 en", "reason": "제안 이유 한 줄"}]

[현재 키워드]
${kwText}

[HR 기능별 누적 사례 수]
${funcText}

[이번 주 채택 사례]
${caseText}`, 1000);

  const list = parseJsonArray_(text);
  let added = 0;
  list.slice(0, 5).forEach(s => {
    const k = String(s.keyword || '').trim();
    if (!k || existing.has(k.toLowerCase())) return;
    existing.add(k.toLowerCase());
    kwSheet.appendRow([false, k, s.lang === 'en' ? 'en' : 'ko', '제안', 'AI 제안', 0, 0, s.reason || '', new Date()]);
    added++;
  });
  return added;
}

function rssUrl_(keyword, lang) {
  const q = encodeURIComponent(keyword + ' when:7d');
  return lang === 'ko'
    ? `https://news.google.com/rss/search?q=${q}&hl=ko&gl=KR&ceid=KR:ko`
    : `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`;
}

// 키워드별 기사를 모은 뒤, 키워드를 돌아가며 한 건씩 뽑음 (앞쪽 키워드가 자리를 독차지하지 않게)
function collectArticles_(keywords, seen) {
  const responses = fetchRss_(keywords);
  const lists = keywords.map(({ keyword }, idx) => {
    try {
      const xml = responses[idx].getContentText();
      return XmlService.parse(xml).getRootElement().getChild('channel').getChildren('item').map(it => ({
        keyword: keyword,
        title: (it.getChildText('title') || '').trim(),
        link: it.getChildText('link'),
        summary: (it.getChildText('description') || '').replace(/<[^>]+>/g, ' ').slice(0, 1500),
      }));
    } catch (e) {
      Logger.log(`RSS 실패: ${keyword} / ${e.message}`);
      return [];
    }
  });

  const out = [];
  const links = new Set(), titles = new Set();
  const pos = lists.map(() => 0);
  let more = true;
  while (more && out.length < MAX_ARTICLES) {
    more = false;
    lists.forEach((list, i) => {
      while (pos[i] < list.length && out.length < MAX_ARTICLES) {
        const a = list[pos[i]++];
        if (!a.link || seen.has(a.link) || links.has(a.link) || titles.has(a.title)) continue;
        links.add(a.link);
        titles.add(a.title);
        out.push(a);
        break;
      }
      if (pos[i] < list.length) more = true;
    });
  }
  return out;
}

// 키워드별 RSS를 한 번에 동시에 가져옴. 실패한 것만 한 개씩 다시 시도 (실패 시 빈 응답)
function fetchRss_(keywords) {
  const requests = keywords.map(k => ({ url: rssUrl_(k.keyword, k.lang), muteHttpExceptions: true }));
  let responses = [];
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (e) {
    Logger.log(`RSS 일괄 요청 실패, 하나씩 다시 시도: ${e.message}`);
  }
  return requests.map((req, i) => {
    const res = responses[i];
    if (res && res.getResponseCode() === 200) return res;
    try {
      Utilities.sleep(300);
      return UrlFetchApp.fetch(req.url, { muteHttpExceptions: true });
    } catch (e) {
      return { getContentText: () => '' };
    }
  });
}

function callClaude_(prompt, maxTokens) {
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('스크립트 속성에 ANTHROPIC_API_KEY가 없습니다');
  claudeCalls++;
  const res = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }],
    }),
    muteHttpExceptions: true,
  });
  const body = JSON.parse(res.getContentText());
  if (res.getResponseCode() !== 200) {
    throw new Error(body.error ? body.error.message : res.getContentText());
  }
  const text = (body.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('')
    .trim();
  if (!text) throw new Error('AI 응답에 텍스트가 없습니다: ' + res.getContentText().slice(0, 200));
  return text;
}

function parseJson_(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  return JSON.parse(text.slice(start, end + 1));
}

// AI 응답에서 JSON 배열만 꺼냄
function parseJsonArray_(text) {
  const start = text.indexOf('['), end = text.lastIndexOf(']');
  if (start < 0 || end < start) throw new Error('AI 응답에 JSON 배열이 없습니다');
  const list = JSON.parse(text.slice(start, end + 1));
  if (!Array.isArray(list)) throw new Error('AI 응답이 배열 형식이 아닙니다');
  return list;
}

// 기사 여러 건을 AI 한 번에 판별 → 기사 순서대로 결과 배열 (각 결과에 id = 기사 번호)
function judgeBatch_(batch, recent, examples) {
  return parseJsonArray_(callClaude_(judgePrompt_(batch, recent, examples), 600 * batch.length + 400));
}

// 묶음 판별. 묶음이 실패하거나 결과가 빠진 기사만 1건씩 다시 판별 (그래도 실패하면 error)
function judgeBatchSafe_(batch, recent, examples) {
  let list = [];
  try {
    list = judgeBatch_(batch, recent, examples);
  } catch (e) {
    Logger.log(`묶음 판별 실패, 1건씩 다시 판별: ${e.message}`);
  }
  return batch.map((a, j) => {
    const hit = list.find(x => x && Number(x.id) === j + 1);
    if (hit) return hit;
    try {
      const one = judgeBatch_([a], recent, examples)[0];
      if (!one) throw new Error('AI 응답에서 판별 결과를 찾지 못했습니다');
      return one;
    } catch (e) {
      return { error: e.message };
    }
  });
}

function secondOpinion_(a, first) {
  return parseJson_(callClaude_(`너는 HR 실무자 관점의 2차 검토자다.
1차 검토에서 아래 기사가 HR×AI 사례인지 애매하다고 판단했다.
"HR 담당자가 AI 활용 사례로 참고할 가치가 있는가"를 기준으로 다시 판단하라.
확신이 서지 않으면 "보류"를 고른다. 사람이 최종 확인한다.

반드시 아래 JSON 하나만 출력하라.
{"decision": "채택 또는 제외 또는 보류", "reason": "이유 한 줄"}

[1차 판단 이유] ${first.reason || ''}
[기사 제목] ${a.title}
[기사 요약] ${a.summary}`, 500));
}

const CARD_FIELDS = `  "기업기관명": "",
  "국가": "국내 또는 해외",
  "업종": "",
  "HR기능": "${HR_FUNCS.join('/')} 중 1개",
  "AI유형": "생성형 AI/예측·분석/챗봇/자동화 중 1개",
  "한줄요약": "40자 이내",
  "도입배경": "1~2줄",
  "결과수치": "",
  "시사점초안": "HR 담당자 관점 1줄"`;

function judgePrompt_(batch, recent, examples) {
  const recentText = recent.length ? recent.map(x => '- ' + x).join('\n') : '(없음)';
  const exampleText = examples.length ? examples.join('\n') : '(아직 없음)';
  const articleText = batch.map((a, i) =>
    `[기사 ${i + 1}]\n제목: ${a.title}\n링크: ${a.link}\n요약: ${a.summary}`).join('\n\n');
  return `너는 HR 담당자 관점에서 HR×AI 사례를 정리하는 에디터다.
아래 기사 ${batch.length}건 각각이 "특정 기업·기관이 HR 업무(채용, 교육, 평가, 보상, 조직문화, HR 운영)에 AI를 실제 도입했거나 도입을 발표한 사례" 또는 "HR 분야 AI 관련 법·정책 변화"일 가능성을 0~100으로 매겨라.
"AI가 HR을 바꾼다" 같은 일반론, 광고성 기사, 특정 기업이 없는 기사는 낮게 준다.
아래 [사람의 판정 예시]가 있으면 그 기준을 우선 따른다.
기사마다 따로 판단하고, 한 기사의 내용을 다른 기사 결과에 섞지 마라.

반드시 JSON 배열 하나만 출력하라. 다른 말은 쓰지 마라.
기사 1건당 객체 1개를 기사 번호 순서대로 넣고, id에는 기사 번호를 쓴다.
case_score가 31 이상이면 카드 항목을 채우고, 30 이하면 비워 둔다.
기사에 없는 내용은 추측하지 말고 "기사에 언급 없음"으로 쓴다. 기사 문장을 그대로 옮기지 말고 네 문장으로 재구성한다.

[
{
  "id": 기사 번호,
  "case_score": 0~100 정수,
  "is_duplicate": true 또는 false,
  "reason": "판단 이유 한 줄",
${CARD_FIELDS}
}
]

is_duplicate는 아래 [이미 저장된 최근 사례] 중에, 또는 이번 목록에서 번호가 더 앞선 기사 중에 같은 기업의 같은 소식(언론사만 다른 보도 포함)이 있으면 true다.
같은 기업이라도 다른 서비스·다른 발표면 false다.

[사람의 판정 예시]
${exampleText}

[이미 저장된 최근 사례]
${recentText}

[판별할 기사]
${articleText}`;
}

// 사람이 '사례로 추가'한 기사: 판별 없이 카드로만 정리
function cardPrompt_(a) {
  return `아래 기사는 사람이 HR×AI 사례로 판단한 기사다. 판별하지 말고 카드 항목만 채워라.
반드시 아래 JSON 하나만 출력하라. 기사에 없는 내용은 "기사에 언급 없음"으로 쓴다.

{
${CARD_FIELDS}
}

[기사 제목] ${a.title}
[기사 링크] ${a.link}`;
}

function draftPrompt_(month, week, rows) {
  return `아래 사례 목록으로 블로그 글 초안을 작성하라.
- 제목: "[${month}월 ${week}주차] HR×AI 사례 브리핑: (가장 눈에 띄는 사례 한 줄)"
- 도입부 2~3문장: 이번 주 공통 흐름
- 본문: HR 기능별로 묶고, 사례마다 아래 카드 형식 사용
  [기업명] 한 줄 요약
  - HR 기능 / 활용 AI
  - 도입 배경
  - 결과
  - 시사점
  - 출처: 링크
- 마무리: 이번 주 한 줄 정리 + 다음 주 지켜볼 포인트
- 맨 아래에 "※ AI로 수집·요약 후 직접 검수한 글입니다." 한 줄
- 블로그 편집기에 바로 붙여넣을 수 있게 마크다운 기호(#, **)는 쓰지 마라.
- 초안 본문만 출력하라. 앞뒤에 참고, 메모, 설명, 구분선(---)을 붙이지 마라.
- 같은 기업의 같은 소식이 여러 건이면 카드 한 장으로 합치고 출처를 모두 단다.
- 말투: ~합니다체, 담백하게. 목록에 없는 사실은 쓰지 마라.

[사례 목록]
${rows}`;
}

// 선택 창 화면 (__DATA__ 자리에 키워드 목록이 들어감)
const PICKER_HTML = `<!DOCTYPE html>
<html><head><base target="_top"><style>
body { font-family: Arial, sans-serif; font-size: 13px; margin: 0; padding: 12px; }
#list { height: 380px; overflow-y: auto; border: 1px solid #ddd; border-radius: 6px; padding: 8px; }
.grp { font-weight: bold; margin: 10px 0 4px; color: #444; }
.grp:first-child { margin-top: 0; }
label { display: block; padding: 3px 0; cursor: pointer; }
.cnt { color: #888; font-size: 12px; }
.bar { margin-top: 10px; display: flex; gap: 6px; }
button { padding: 6px 12px; border: 1px solid #bbb; border-radius: 4px; background: #fff; cursor: pointer; }
button.main { background: #1a73e8; color: #fff; border-color: #1a73e8; }
button:disabled { opacity: 0.5; cursor: default; }
#msg { margin-top: 10px; white-space: pre-wrap; color: #333; }
</style></head><body>
<div id="list"></div>
<div class="bar">
<button class="main" id="run" onclick="run()">실행</button>
<button onclick="setAll(false)">전체 해제</button>
<button onclick="google.script.host.close()">닫기</button>
</div>
<div id="msg"></div>
<script>
var items = __DATA__;
var order = ['사용', '제안', '중지', '거절'];
var groups = {};
items.forEach(function (it) { (groups[it.s] = groups[it.s] || []).push(it); });
var keys = order.filter(function (s) { return groups[s]; })
  .concat(Object.keys(groups).filter(function (s) { return order.indexOf(s) < 0; }));
var list = document.getElementById('list');
keys.forEach(function (s) {
  var h = document.createElement('div');
  h.className = 'grp';
  h.textContent = s + ' (' + groups[s].length + ')';
  list.appendChild(h);
  groups[s].forEach(function (it) {
    var label = document.createElement('label');
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.value = it.k;
    var cnt = document.createElement('span');
    cnt.className = 'cnt';
    cnt.textContent = '  누적 채택 ' + it.n;
    label.appendChild(cb);
    label.appendChild(document.createTextNode(' ' + it.k));
    label.appendChild(cnt);
    list.appendChild(label);
  });
});
function setAll(v) {
  document.querySelectorAll('#list input').forEach(function (c) { c.checked = v; });
}
function msg(t) { document.getElementById('msg').textContent = t; }
function run() {
  var names = Array.prototype.map.call(document.querySelectorAll('#list input:checked'), function (c) { return c.value; });
  if (!names.length) { msg('키워드를 하나 이상 고르세요.'); return; }
  document.getElementById('run').disabled = true;
  msg('수집 중입니다. 키워드 수에 따라 1~5분 걸립니다.');
  google.script.run
    .withSuccessHandler(function (t) { document.getElementById('run').disabled = false; msg(t); })
    .withFailureHandler(function (e) { document.getElementById('run').disabled = false; msg('오류: ' + e.message); })
    .runKeywordsFromPicker(names);
}
</script></body></html>`;

// 토스 단말기 등에서 내려받은 판매 내역 엑셀을 "베스트 에포트"로 읽어서 품목별로 집계한다.
// 파일 형식이 제각각일 수 있어서, 고정된 셀 위치가 아니라 헤더에 쓰인 단어(품목/수량/금액 등)로
// 표의 시작 위치와 각 열을 찾는 방식을 쓴다. 못 읽은 행은 버리지 않고 "확인 필요" 목록으로 따로 돌려준다.
import ExcelJS from "exceljs";

const NAME_KEYWORDS = ["상품명", "품목명", "메뉴명", "제품명", "상품", "품목", "메뉴", "제품"];
const QTY_KEYWORDS = ["수량", "판매수량", "건수"];
const AMOUNT_KEYWORDS = ["금액", "매출", "결제금액", "합계금액", "판매금액", "총금액", "합계"];
const SKIP_ROW_KEYWORDS = ["합계", "총합", "소계", "전체", "합 계"];

function normalizeCell(v) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") {
    if (v.richText) return v.richText.map((t) => t.text).join("").trim();
    if (v.text !== undefined) return String(v.text).trim();
    if (v.result !== undefined) return String(v.result).trim();
  }
  return String(v).trim();
}

function parseNumber(v) {
  const s = normalizeCell(v).replace(/[,원₩\s]/g, "");
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function findHeaderRow(rows) {
  const scanLimit = Math.min(rows.length, 20);
  for (let i = 0; i < scanLimit; i++) {
    const cells = rows[i].map(normalizeCell);
    const hasName = cells.some((c) => NAME_KEYWORDS.some((k) => c.includes(k)));
    const hasQty = cells.some((c) => QTY_KEYWORDS.some((k) => c.includes(k)));
    const hasAmount = cells.some((c) => AMOUNT_KEYWORDS.some((k) => c.includes(k)));
    if (hasName && (hasQty || hasAmount)) return i;
  }
  return -1;
}

export async function parsePosExcel(buffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  if (workbook.worksheets.length === 0) {
    return { recognized: false, summary: [], uncertain: [], message: "엑셀 파일에 시트가 없어요." };
  }

  // 시트가 여러 개면 행이 가장 많은 시트를 실제 데이터 시트로 추정
  let sheet = workbook.worksheets[0];
  for (const ws of workbook.worksheets) {
    if (ws.rowCount > sheet.rowCount) sheet = ws;
  }

  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const arr = [];
    row.eachCell({ includeEmpty: true }, (cell) => arr.push(cell.value));
    rows.push(arr);
  });

  const headerIdx = findHeaderRow(rows);
  if (headerIdx === -1) {
    return {
      recognized: false,
      summary: [],
      uncertain: rows.slice(0, 10).map((r) => r.map(normalizeCell)),
      message: "엑셀에서 품목·수량·금액 형식의 표를 찾지 못했어요. 원본 파일을 직접 확인해주세요.",
    };
  }

  const header = rows[headerIdx].map(normalizeCell);
  const nameCol = header.findIndex((c) => NAME_KEYWORDS.some((k) => c.includes(k)));
  const qtyCol = header.findIndex((c) => QTY_KEYWORDS.some((k) => c.includes(k)));
  const amountCol = header.findIndex((c) => AMOUNT_KEYWORDS.some((k) => c.includes(k)));

  const byName = new Map();
  const uncertain = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const name = normalizeCell(row[nameCol]);
    if (!name) continue;
    if (SKIP_ROW_KEYWORDS.some((k) => name.includes(k))) continue;

    const qty = qtyCol >= 0 ? parseNumber(row[qtyCol]) : null;
    const amount = amountCol >= 0 ? parseNumber(row[amountCol]) : null;

    if (qty === null && amount === null) {
      uncertain.push(row.map(normalizeCell));
      continue;
    }

    const prev = byName.get(name) || { name, qty: 0, amount: 0 };
    prev.qty += qty || 0;
    prev.amount += amount || 0;
    byName.set(name, prev);
  }

  return {
    recognized: true,
    summary: [...byName.values()].sort((a, b) => b.amount - a.amount),
    uncertain,
    message: uncertain.length > 0 ? `${uncertain.length}개 행은 자동으로 읽지 못해 따로 표시했어요.` : null,
  };
}

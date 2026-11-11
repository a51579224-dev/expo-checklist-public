// 박람회 체크리스트 — 공개용 독립 페이지.
// 로그인 없음: 행사 하나당 고유 링크(slug)로만 구분. 그 링크를 아는 사람만 보고 수정할 수 있음.
// 데이터는 Supabase(Postgres) categories jsonb 컬럼 하나에 전부 저장 (행사별로 한 행).
import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsePosExcel } from "./posParser.js";
import { isNaverConfigured, searchProducts } from "./naverProducts.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL이 설정되지 않았어요. Supabase 연결 문자열을 환경변수로 넣어주세요.");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

const app = express();
app.use(express.json({ limit: "12mb" })); // 배치도 이미지(base64)가 들어갈 수 있어서 넉넉하게
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 4100;

// 2026-11-11: '현장 운영'은 더 이상 쓰지 않아 새 행사엔 안 만듦(탭 자체를 없앰).
// 예전 행사에 이미 저장된 데이터는 지우지 않고 그대로 두되, 화면에서는 완전히 숨김(복구는 DB에서만 가능).
const CHECKLIST_CATEGORIES = [
  { id: "contract", name: "행사 정보" },
  { id: "inventory", name: "상품 재고" },
  { id: "supplies", name: "집기" },
  { id: "settlement", name: "철수 정산" },
];

const DEFAULT_TEMPLATE_ITEMS = {
  // 2026-11-11: '행사 계약' 탭은 체크리스트 대신 부스위치/배치도/차량입차시간 전용 화면으로 바뀌어서
  // 새 행사엔 더 이상 항목을 넣지 않음. 예전 행사에 이미 저장된 계약 체크리스트 항목은
  // DB에서 지우지 않고 그대로 두되(복구 가능), 화면에서만 안 보이게 처리함.
  contract: [],
  // 2026-11-11: '상품 재고'도 고정 체크리스트 문구 대신, 행사마다 품목을 직접 입력하는
  // 수량(CTN/PC)+준비완료+차량적재완료 전용 화면으로 바뀌어서 기본 항목을 비워둠.
  inventory: [],
  // 2026-11-11: '집기'도 체크리스트 문구 나열 대신, 분류(그룹)별로 묶어서 한눈에 보는 화면으로 바뀜.
  // "부스 꾸미기"/"작업 도구"/"전기용품"은 어느 브랜드든 공통으로 쓰는 고정 분류 — 기본 품목을 미리 채워둠.
  // "상품별 진열 집기"는 분류 자체를 브랜드가 +/-로 직접 만드는 영역이라 공통 템플릿엔 비워둠.
  supplies: [
    { group: "부스 꾸미기", text: "테이블" },
    { group: "부스 꾸미기", text: "벽면 장식물" },
    { group: "부스 꾸미기", text: "간판" },
    { group: "부스 꾸미기", text: "테이블보" },
    { group: "부스 꾸미기", text: "테이블 현수막" },
    { group: "작업 도구", text: "가위" },
    { group: "작업 도구", text: "테이프" },
    { group: "작업 도구", text: "테이프 커터기" },
    { group: "작업 도구", text: "매직" },
    { group: "작업 도구", text: "볼펜" },
    { group: "전기용품", text: "멀티탭" },
  ],
  // 2026-11-11: '철수 정산'도 체크리스트 대신 남은재고/일별매출/판매내역업로드/개선사항 전용 화면으로 바뀜.
  settlement: [],
};

function newId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function newSlug() {
  return crypto.randomBytes(6).toString("hex"); // 12자 — 짧고 추측 어려움
}

function buildDefaultCategories() {
  return CHECKLIST_CATEGORIES.map((c) => ({
    id: c.id,
    name: c.name,
    items: DEFAULT_TEMPLATE_ITEMS[c.id].map((entry) => {
      const isObj = typeof entry === "object" && entry !== null;
      const item = { id: newId("item"), text: isObj ? entry.text : entry, done: false };
      if (isObj && entry.group) item.group = entry.group;
      if (isObj && entry.qty !== undefined) item.qty = entry.qty;
      return item;
    }),
  }));
}

function cloneCategories(categories) {
  return categories.map((c) => ({
    id: c.id,
    name: c.name,
    // 품목(text)과 '준비 예정' 계획 수량·분류는 그대로 가져오되, 완료/적재 체크와 실제 확인 수량·메모는 초기화.
    items: c.items.map((it) => ({
      id: newId("item"),
      text: it.text,
      done: false,
      ...(it.group !== undefined ? { group: it.group } : {}),
      ...(it.qty !== undefined ? { qty: it.qty } : {}),
      ...(it.naverProductId !== undefined ? { naverProductId: it.naverProductId, naverOptionId: it.naverOptionId } : {}),
      ...(it.loaded !== undefined ? { loaded: false } : {}),
      ...(it.ctnPlanned !== undefined ? { ctnPlanned: it.ctnPlanned } : {}),
      ...(it.pcPlanned !== undefined ? { pcPlanned: it.pcPlanned } : {}),
      ...(it.boxQty !== undefined ? { boxQty: it.boxQty } : {}),
      ...(it.ctnActual !== undefined ? { ctnActual: null } : {}),
      ...(it.pcActual !== undefined ? { pcActual: null } : {}),
      ...(it.ctnRemaining !== undefined ? { ctnRemaining: null } : {}),
      ...(it.pcRemaining !== undefined ? { pcRemaining: null } : {}),
      ...(it.note !== undefined ? { note: "" } : {}),
    })),
  }));
}

// 체크박스 기반 진행률 계산에서 제외하는 카테고리: 더 이상 체크리스트가 아니거나(계약/정산),
// 탭 자체가 없어진(현장운영, 예전 데이터만 남아있을 수 있음) 경우.
const NON_CHECKLIST_CATEGORY_IDS = new Set(["contract", "operation", "settlement"]);

function computeProgress(categories) {
  let total = 0;
  let done = 0;
  const byCategory = categories.map((c) => {
    const catTotal = c.items.length;
    const catDone = c.items.filter((it) => it.done).length;
    if (!NON_CHECKLIST_CATEGORY_IDS.has(c.id)) {
      total += catTotal;
      done += catDone;
    }
    return { id: c.id, name: c.name, total: catTotal, done: catDone };
  });
  return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100), byCategory };
}

function rowToEvent(row) {
  return {
    slug: row.slug,
    name: row.name,
    startDate: row.start_date || "",
    endDate: row.end_date || "",
    location: row.location || "",
    boothCount: row.booth_count || "",
    boothLocation: row.booth_location || "",
    floorPlan: row.floor_plan || null,
    vehicleAccess: row.vehicle_access || null,
    settlement: row.settlement || null,
    categories: row.categories,
    createdAt: row.created_at,
  };
}

async function getEventRow(slug) {
  const { rows } = await pool.query("select * from events where slug = $1", [slug]);
  return rows[0] || null;
}

function findCategory(ev, catId) {
  const cat = ev.categories.find((c) => c.id === catId);
  if (!cat) throw Object.assign(new Error("존재하지 않는 카테고리입니다."), { status: 404 });
  return cat;
}

// 새 행사 생성 — 기본 템플릿으로 체크리스트 자동 생성, 고유 링크(slug) 발급
app.post("/api/events", async (req, res) => {
  const { name, startDate, endDate, location, boothCount } = req.body ?? {};
  if (!name || !name.trim()) return res.status(400).json({ error: "행사명은 필수예요." });
  try {
    let slug = newSlug();
    // 극히 희박하지만 충돌 방지
    for (let i = 0; i < 5; i++) {
      const exists = await getEventRow(slug);
      if (!exists) break;
      slug = newSlug();
    }
    const categories = buildDefaultCategories();
    const { rows } = await pool.query(
      `insert into events (slug, name, start_date, end_date, location, booth_count, categories)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [slug, name.trim(), startDate || "", endDate || "", (location || "").trim(), (boothCount || "").trim(), JSON.stringify(categories)]
    );
    res.json({ event: rowToEvent(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// 행사 상세 (슬러그로 조회)
app.get("/api/events/:slug", async (req, res) => {
  try {
    const row = await getEventRow(req.params.slug);
    if (!row) return res.status(404).json({ error: "존재하지 않는 체크리스트 링크예요." });
    const ev = rowToEvent(row);
    res.json({ event: ev, progress: computeProgress(ev.categories) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// 행사 기본정보 수정
app.put("/api/events/:slug", async (req, res) => {
  const { name, startDate, endDate, location, boothCount, boothLocation } = req.body ?? {};
  try {
    const row = await getEventRow(req.params.slug);
    if (!row) return res.status(404).json({ error: "존재하지 않는 체크리스트 링크예요." });
    const { rows } = await pool.query(
      `update events set
         name = coalesce($2, name),
         start_date = coalesce($3, start_date),
         end_date = coalesce($4, end_date),
         location = coalesce($5, location),
         booth_count = coalesce($6, booth_count),
         booth_location = coalesce($7, booth_location),
         updated_at = now()
       where slug = $1 returning *`,
      [req.params.slug, name?.trim(), startDate, endDate, location?.trim(), boothCount?.trim(), boothLocation?.trim()]
    );
    res.json({ event: rowToEvent(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// 부스 배치도 등록/수정 — 이미지(업로드 base64 또는 외부 URL)와 마커 위치(이미지 기준 0~1 상대좌표)를 통째로 교체.
app.put("/api/events/:slug/floor-plan", async (req, res) => {
  const { imageUrl, imageDataUrl, markerX, markerY } = req.body ?? {};
  try {
    const row = await getEventRow(req.params.slug);
    if (!row) return res.status(404).json({ error: "존재하지 않는 체크리스트 링크예요." });
    const floorPlan = {
      imageUrl: imageUrl || null,
      imageDataUrl: imageDataUrl || null,
      markerX: typeof markerX === "number" ? markerX : null,
      markerY: typeof markerY === "number" ? markerY : null,
    };
    const { rows } = await pool.query(
      "update events set floor_plan = $2::jsonb, updated_at = now() where slug = $1 returning *",
      [req.params.slug, JSON.stringify(floorPlan)]
    );
    res.json({ event: rowToEvent(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// 배치도 삭제(이미지+마커 전부 제거)
app.delete("/api/events/:slug/floor-plan", async (req, res) => {
  try {
    const row = await getEventRow(req.params.slug);
    if (!row) return res.status(404).json({ error: "존재하지 않는 체크리스트 링크예요." });
    const { rows } = await pool.query(
      "update events set floor_plan = null, updated_at = now() where slug = $1 returning *",
      [req.params.slug]
    );
    res.json({ event: rowToEvent(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// 차량 입차 가능 시간 등록/수정
app.put("/api/events/:slug/vehicle-access", async (req, res) => {
  const { date, startTime, endTime } = req.body ?? {};
  if (!date || !endTime) return res.status(400).json({ error: "반입 날짜와 입차 마감 시간은 필수예요." });
  try {
    const row = await getEventRow(req.params.slug);
    if (!row) return res.status(404).json({ error: "존재하지 않는 체크리스트 링크예요." });
    const vehicleAccess = { date, startTime: startTime || "", endTime };
    const { rows } = await pool.query(
      "update events set vehicle_access = $2::jsonb, updated_at = now() where slug = $1 returning *",
      [req.params.slug, JSON.stringify(vehicleAccess)]
    );
    res.json({ event: rowToEvent(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// 철수 정산 — 일별 매출 / 다음 행사 개선사항 (있는 필드만 반영)
app.put("/api/events/:slug/settlement", async (req, res) => {
  const { revenueFri, revenueSat, revenueSun, improvementNotes } = req.body ?? {};
  try {
    const row = await getEventRow(req.params.slug);
    if (!row) return res.status(404).json({ error: "존재하지 않는 체크리스트 링크예요." });
    const settlement = row.settlement || {};
    settlement.revenue = settlement.revenue || {};
    if (revenueFri !== undefined) settlement.revenue.fri = normalizeQty(revenueFri);
    if (revenueSat !== undefined) settlement.revenue.sat = normalizeQty(revenueSat);
    if (revenueSun !== undefined) settlement.revenue.sun = normalizeQty(revenueSun);
    if (improvementNotes !== undefined) settlement.improvementNotes = String(improvementNotes).trim();
    const { rows } = await pool.query(
      "update events set settlement = $2::jsonb, updated_at = now() where slug = $1 returning *",
      [req.params.slug, JSON.stringify(settlement)]
    );
    res.json({ event: rowToEvent(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// 철수 정산 — 토스 단말기 판매내역 엑셀 업로드(베타). base64로 받아서 서버에서 파싱만 하고 저장.
app.post("/api/events/:slug/settlement/pos-upload", async (req, res) => {
  const { fileName, fileDataBase64 } = req.body ?? {};
  if (!fileDataBase64) return res.status(400).json({ error: "엑셀 파일 데이터가 없어요." });
  try {
    const row = await getEventRow(req.params.slug);
    if (!row) return res.status(404).json({ error: "존재하지 않는 체크리스트 링크예요." });
    const buffer = Buffer.from(fileDataBase64, "base64");
    const parsed = await parsePosExcel(buffer);
    const settlement = row.settlement || {};
    settlement.pos = {
      fileName: fileName || "",
      uploadedAt: new Date().toISOString(),
      recognized: parsed.recognized,
      summary: parsed.summary,
      uncertain: parsed.uncertain,
      message: parsed.message,
    };
    const { rows } = await pool.query(
      "update events set settlement = $2::jsonb, updated_at = now() where slug = $1 returning *",
      [req.params.slug, JSON.stringify(settlement)]
    );
    res.json({ event: rowToEvent(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: "엑셀 파일을 읽는 중 문제가 생겼어요: " + String(err.message || err) });
  }
});

// 다른 행사로 복제 — 완료상태 초기화, 새 링크(slug) 발급. 추가했던 항목·순서는 그대로 복제.
app.post("/api/events/:slug/duplicate", async (req, res) => {
  const { newName, startDate, endDate, location, boothCount } = req.body ?? {};
  if (!newName || !newName.trim()) return res.status(400).json({ error: "새 행사명을 입력해주세요." });
  try {
    const src = await getEventRow(req.params.slug);
    if (!src) return res.status(404).json({ error: "복제할 원본 체크리스트를 찾을 수 없어요." });
    let slug = newSlug();
    for (let i = 0; i < 5; i++) {
      const exists = await getEventRow(slug);
      if (!exists) break;
      slug = newSlug();
    }
    const categories = cloneCategories(src.categories);
    const { rows } = await pool.query(
      `insert into events (slug, name, start_date, end_date, location, booth_count, categories)
       values ($1, $2, $3, $4, $5, $6, $7) returning *`,
      [
        slug,
        newName.trim(),
        startDate || "",
        endDate || "",
        location !== undefined ? location.trim() : src.location,
        boothCount !== undefined ? boothCount.trim() : src.booth_count,
        JSON.stringify(categories),
      ]
    );
    res.json({ event: rowToEvent(rows[0]) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

// 항목 추가 — '집기'의 경우 group을 같이 보내면 그 분류 소속으로 추가됨
app.post("/api/events/:slug/categories/:catId/items", async (req, res) => {
  const { text, group } = req.body ?? {};
  if (!text || !text.trim()) return res.status(400).json({ error: "항목 내용을 입력해주세요." });
  try {
    const row = await getEventRow(req.params.slug);
    if (!row) return res.status(404).json({ error: "존재하지 않는 체크리스트 링크예요." });
    const ev = rowToEvent(row);
    const cat = findCategory(ev, req.params.catId);
    const item = { id: newId("item"), text: text.trim(), done: false };
    if (group && group.trim()) item.group = group.trim();
    cat.items.push(item);
    await pool.query("update events set categories = $2, updated_at = now() where slug = $1", [req.params.slug, JSON.stringify(ev.categories)]);
    res.json({ item, progress: computeProgress(ev.categories) });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

// 네이버 스마트스토어 연동 — PET TIMES 서버에만 환경변수가 설정돼 있을 때만 동작함(조회 전용).
// 다른 브랜드 복제본은 이 라우트들이 전부 "연동 안 됨"으로만 응답하고, 화면에서도 버튼 자체가 안 보임.
app.get("/api/naver/status", (_req, res) => {
  res.json({ enabled: isNaverConfigured() });
});

app.get("/api/naver/products/search", async (req, res) => {
  if (!isNaverConfigured()) return res.status(501).json({ error: "이 서버엔 스마트스토어 연동이 설정되어 있지 않아요." });
  const q = String(req.query.q || "").trim();
  if (!q) return res.status(400).json({ error: "검색어를 입력해주세요." });
  try {
    const rows = await searchProducts(q);
    res.json({ rows });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// 스마트스토어에서 고른 상품/옵션을 '상품 재고' 품목으로 일괄 추가 — naverProductId+naverOptionId
// 기준으로 이미 추가된 건 건너뛰어서, 목록을 여러 번 다시 불러와도 중복되지 않게 함.
app.post("/api/events/:slug/categories/inventory/naver-import", async (req, res) => {
  const { items } = req.body ?? {};
  if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: "추가할 상품을 선택해주세요." });
  try {
    const row = await getEventRow(req.params.slug);
    if (!row) return res.status(404).json({ error: "존재하지 않는 체크리스트 링크예요." });
    const ev = rowToEvent(row);
    const cat = findCategory(ev, "inventory");
    const existingKeys = new Set(
      cat.items.filter((it) => it.naverProductId).map((it) => `${it.naverProductId}::${it.naverOptionId || ""}`)
    );
    let added = 0;
    let skipped = 0;
    for (const sel of items) {
      const key = `${sel.naverProductId}::${sel.naverOptionId || ""}`;
      if (existingKeys.has(key)) { skipped++; continue; }
      existingKeys.add(key);
      const text = sel.optionName ? `${sel.name} - ${sel.optionName}` : sel.name;
      cat.items.push({
        id: newId("item"), text, done: false,
        naverProductId: String(sel.naverProductId), naverOptionId: String(sel.naverOptionId || ""),
      });
      added++;
    }
    await pool.query("update events set categories = $2, updated_at = now() where slug = $1", [req.params.slug, JSON.stringify(ev.categories)]);
    res.json({ added, skipped, progress: computeProgress(ev.categories), items: cat.items });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// 숫자 입력칸 공용 보정: 빈값/음수/NaN은 전부 null로 (저장은 하되 억지로 0을 넣지 않음)
function normalizeQty(v) {
  if (v === undefined) return undefined; // 아예 안 보낸 필드는 건드리지 않음
  if (v === null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// 항목 수정 — 이름 변경, 완료/적재 체크 토글, '상품 재고'/'집기' 전용 수량·분류·메모 필드(있을 때만 반영)
app.put("/api/events/:slug/categories/:catId/items/:itemId", async (req, res) => {
  const {
    text, done, loaded, group, qty,
    ctnPlanned, pcPlanned, boxQty, ctnActual, pcActual, ctnRemaining, pcRemaining, note,
  } = req.body ?? {};
  try {
    const row = await getEventRow(req.params.slug);
    if (!row) return res.status(404).json({ error: "존재하지 않는 체크리스트 링크예요." });
    const ev = rowToEvent(row);
    const cat = findCategory(ev, req.params.catId);
    const item = cat.items.find((it) => it.id === req.params.itemId);
    if (!item) return res.status(404).json({ error: "존재하지 않는 항목이에요." });
    if (text !== undefined) {
      if (!text.trim()) return res.status(400).json({ error: "항목 내용은 비울 수 없어요." });
      item.text = text.trim();
    }
    if (done !== undefined) item.done = !!done;
    if (loaded !== undefined) item.loaded = !!loaded;
    if (group !== undefined) item.group = String(group).trim();
    if (qty !== undefined) item.qty = normalizeQty(qty);
    if (ctnPlanned !== undefined) item.ctnPlanned = normalizeQty(ctnPlanned);
    if (pcPlanned !== undefined) item.pcPlanned = normalizeQty(pcPlanned);
    if (boxQty !== undefined) item.boxQty = normalizeQty(boxQty);
    if (ctnActual !== undefined) item.ctnActual = normalizeQty(ctnActual);
    if (pcActual !== undefined) item.pcActual = normalizeQty(pcActual);
    if (ctnRemaining !== undefined) item.ctnRemaining = normalizeQty(ctnRemaining);
    if (pcRemaining !== undefined) item.pcRemaining = normalizeQty(pcRemaining);
    if (note !== undefined) item.note = String(note).trim();
    await pool.query("update events set categories = $2, updated_at = now() where slug = $1", [req.params.slug, JSON.stringify(ev.categories)]);
    res.json({ item, progress: computeProgress(ev.categories) });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

// 항목 삭제
app.delete("/api/events/:slug/categories/:catId/items/:itemId", async (req, res) => {
  try {
    const row = await getEventRow(req.params.slug);
    if (!row) return res.status(404).json({ error: "존재하지 않는 체크리스트 링크예요." });
    const ev = rowToEvent(row);
    const cat = findCategory(ev, req.params.catId);
    const before = cat.items.length;
    cat.items = cat.items.filter((it) => it.id !== req.params.itemId);
    if (cat.items.length === before) return res.status(404).json({ error: "존재하지 않는 항목이에요." });
    await pool.query("update events set categories = $2, updated_at = now() where slug = $1", [req.params.slug, JSON.stringify(ev.categories)]);
    res.json({ ok: true, progress: computeProgress(ev.categories) });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

// 같은 카테고리 안에서 항목 순서 변경 — body: { itemIds: [새 순서대로 전체 id 배열] }
app.put("/api/events/:slug/categories/:catId/reorder", async (req, res) => {
  const { itemIds } = req.body ?? {};
  if (!Array.isArray(itemIds)) return res.status(400).json({ error: "itemIds 배열이 필요해요." });
  try {
    const row = await getEventRow(req.params.slug);
    if (!row) return res.status(404).json({ error: "존재하지 않는 체크리스트 링크예요." });
    const ev = rowToEvent(row);
    const cat = findCategory(ev, req.params.catId);
    const byId = new Map(cat.items.map((it) => [it.id, it]));
    if (itemIds.length !== cat.items.length || itemIds.some((id) => !byId.has(id))) {
      return res.status(400).json({ error: "itemIds가 현재 항목 구성과 맞지 않아요." });
    }
    cat.items = itemIds.map((id) => byId.get(id));
    await pool.query("update events set categories = $2, updated_at = now() where slug = $1", [req.params.slug, JSON.stringify(ev.categories)]);
    res.json({ ok: true });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

// SPA: "/e/슬러그" 경로도 같은 index.html을 보여줌 (클라이언트에서 경로 보고 알아서 분기)
app.get("/e/:slug", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(PORT, () => {
  console.log(`박람회 체크리스트(공개) 서버 실행 중 → http://localhost:${PORT}`);
});

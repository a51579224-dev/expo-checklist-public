// 박람회 체크리스트 — 공개용 독립 페이지.
// 로그인 없음: 행사 하나당 고유 링크(slug)로만 구분. 그 링크를 아는 사람만 보고 수정할 수 있음.
// 데이터는 Supabase(Postgres) categories jsonb 컬럼 하나에 전부 저장 (행사별로 한 행).
import express from "express";
import pg from "pg";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 4100;

const CHECKLIST_CATEGORIES = [
  { id: "contract", name: "행사 계약" },
  { id: "inventory", name: "상품 재고" },
  { id: "supplies", name: "집기" },
  { id: "operation", name: "현장 운영" },
  { id: "settlement", name: "철수 정산" },
];

const DEFAULT_TEMPLATE_ITEMS = {
  contract: [
    "참가 신청 및 계약 확인",
    "부스비·잔금 결제 확인",
    "부스 번호 및 위치 확인",
    "전기·기본 집기 신청 확인",
    "출입증·반입 규정 확인",
    "물류 차량 및 반입 일정 확인",
  ],
  inventory: [
    "참가 제품 목록 확정",
    "제품별 판매 수량 확인",
    "전시용 샘플 및 예비 재고 확인",
    "행사 판매가·할인율 확인",
    "상품별 수량 검수 및 박스 포장",
    "차량 상품 적재 확인",
  ],
  supplies: [
    "테이블·선반·진열대 준비",
    "현수막·가격표·안내물 준비",
    "리플렛·쇼핑백·포장재 준비",
    "결제 단말기·충전기·멀티탭 준비",
    "가위·테이프·케이블타이 등 비품 준비",
    "집기 포장 및 차량 적재 확인",
  ],
  operation: [
    "부스 설치 및 상품 진열",
    "가격표·안내물 설치",
    "결제 단말기 및 인터넷 테스트",
    "행사 시작 전 상품 수량 확인",
    "판매 중 상품 보충 및 재고 체크",
    "일일 매출·현금·결제 내역 확인",
  ],
  settlement: [
    "남은 상품 수량 확인",
    "집기 및 비품 회수·포장",
    "철수 후 차량 적재 확인",
    "반입 상품·판매 상품·반품 수량 정산",
    "최종 매출 및 행사 비용 정리",
    "다음 행사 개선 사항 기록",
  ],
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
    items: DEFAULT_TEMPLATE_ITEMS[c.id].map((text) => ({ id: newId("item"), text, done: false })),
  }));
}

function cloneCategories(categories) {
  return categories.map((c) => ({
    id: c.id,
    name: c.name,
    items: c.items.map((it) => ({ id: newId("item"), text: it.text, done: false })),
  }));
}

function computeProgress(categories) {
  let total = 0;
  let done = 0;
  const byCategory = categories.map((c) => {
    const catTotal = c.items.length;
    const catDone = c.items.filter((it) => it.done).length;
    total += catTotal;
    done += catDone;
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
  const { name, startDate, endDate, location, boothCount } = req.body ?? {};
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
         updated_at = now()
       where slug = $1 returning *`,
      [req.params.slug, name?.trim(), startDate, endDate, location?.trim(), boothCount?.trim()]
    );
    res.json({ event: rowToEvent(rows[0]) });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
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

// 항목 추가
app.post("/api/events/:slug/categories/:catId/items", async (req, res) => {
  const { text } = req.body ?? {};
  if (!text || !text.trim()) return res.status(400).json({ error: "항목 내용을 입력해주세요." });
  try {
    const row = await getEventRow(req.params.slug);
    if (!row) return res.status(404).json({ error: "존재하지 않는 체크리스트 링크예요." });
    const ev = rowToEvent(row);
    const cat = findCategory(ev, req.params.catId);
    const item = { id: newId("item"), text: text.trim(), done: false };
    cat.items.push(item);
    await pool.query("update events set categories = $2, updated_at = now() where slug = $1", [req.params.slug, JSON.stringify(ev.categories)]);
    res.json({ item, progress: computeProgress(ev.categories) });
  } catch (err) {
    res.status(err.status || 500).json({ error: String(err.message || err) });
  }
});

// 항목 수정(이름 변경) 및/또는 완료 체크 토글
app.put("/api/events/:slug/categories/:catId/items/:itemId", async (req, res) => {
  const { text, done } = req.body ?? {};
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

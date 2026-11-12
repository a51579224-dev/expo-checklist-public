// 네이버 커머스API(스마트스토어) — PET TIMES 전용 상품 조회 클라이언트.
// 이 파일은 공개 저장소에 포함되지만, 실제로 동작하려면 서버 환경변수
// NAVER_COMMERCE_CLIENT_ID / NAVER_COMMERCE_CLIENT_SECRET 가 설정돼 있어야 한다.
// 다른 브랜드가 이 프로젝트를 복제해도 저 환경변수를 안 넣으면 그냥 버튼이 안 보일 뿐,
// 코드 자체에 특정 브랜드 정보는 들어있지 않다(조회 전용, 쓰기 API는 안 씀).
import bcrypt from "bcryptjs";

const BASE = "https://api.commerce.naver.com/external";

let cachedToken = null;
let cachedTokenExpiresAt = 0;

export function isNaverConfigured() {
  return !!(process.env.NAVER_COMMERCE_CLIENT_ID && process.env.NAVER_COMMERCE_CLIENT_SECRET);
}

async function getAccessToken() {
  if (cachedToken && Date.now() < cachedTokenExpiresAt - 5 * 60 * 1000) return cachedToken;
  const clientId = process.env.NAVER_COMMERCE_CLIENT_ID;
  const clientSecret = process.env.NAVER_COMMERCE_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error("네이버 스마트스토어 연동이 설정되지 않은 서버예요.");

  const timestamp = Date.now();
  const password = `${clientId}_${timestamp}`;
  const hashed = bcrypt.hashSync(password, clientSecret);
  const sign = Buffer.from(hashed, "utf-8").toString("base64");
  const params = new URLSearchParams({
    client_id: clientId, timestamp: String(timestamp), client_secret_sign: sign,
    grant_type: "client_credentials", type: "SELF",
  });
  const res = await fetch(`${BASE}/v1/oauth2/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: params.toString(),
  });
  if (!res.ok) throw new Error(`네이버 커머스API 토큰 발급 실패 (${res.status}): ${await res.text()}`);
  const json = await res.json();
  cachedToken = json.access_token;
  cachedTokenExpiresAt = Date.now() + json.expires_in * 1000;
  return cachedToken;
}

// 상품명으로 검색 — 조회 전용(판매가/재고 수정 등 쓰기 API는 호출하지 않음).
// ⚠️ 2026-11-12 "상품" 권한그룹 승인 후 라이브로 실제 응답을 확인해서 맞춘 버전.
//
// 확인된 사실:
// - /v1/products/search 는 searchKeyword로 서버 쪽 필터링을 해주지 않음(실제로 넣어봐도
//   전체 결과가 그대로 옴) — 그래서 전체 상품을 가져온 뒤 이름으로 직접 필터링한다.
// - 응답은 { contents: [{ originProductNo, channelProducts: [{...}] }], totalElements, ... }
//   형태이고, 옵션(사이즈/색상 등)별로 나뉜 행은 따로 안 내려줌 — channelProducts 하나가
//   그 등록상품 전체를 뜻함(옵션은 네이버 자체 옵션 UI에 들어있어도 이 응답엔 안 보임).
//   그래서 naverOptionId는 항상 빈 값으로 두고, 옵션 구분은 품목명에 들어있는 문구(상품명)
//   를 그대로 보여주는 선에서 처리한다.
// - 가격은 discountedPrice(실제 판매가)를 우선 쓰고 없으면 salePrice(정가).
// - statusType이 'SALE'이 아닌 상품(종료된 공동구매 등)은 박람회 준비 목적상 의미가
//   없어서 검색 결과에서 제외한다.
const PAGE_SIZE = 500; // PET TIMES 등록 상품 수가 수백 개 단위라 한 번에 다 가져와도 무리 없음

export async function searchProducts(query) {
  const token = await getAccessToken();
  const res = await fetch(`${BASE}/v1/products/search`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ page: 1, size: PAGE_SIZE }),
  });
  if (!res.ok) throw new Error(`네이버 상품 조회 실패 (${res.status}): ${await res.text()}`);
  const json = await res.json();
  const all = mapSearchResult(json);
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all.filter((row) => row.name.toLowerCase().includes(q));
}

function mapSearchResult(json) {
  const contents = json?.contents ?? [];
  const rows = [];
  for (const item of contents) {
    for (const cp of item.channelProducts ?? []) {
      if (cp.statusType && cp.statusType !== "SALE") continue;
      rows.push({
        naverProductId: String(cp.originProductNo ?? item.originProductNo ?? cp.channelProductNo),
        naverOptionId: "",
        name: cp.name ?? "(상품명 없음)",
        optionName: "",
        price: cp.discountedPrice ?? cp.salePrice ?? null,
        stockQuantity: cp.stockQuantity ?? null,
      });
    }
  }
  return rows;
}

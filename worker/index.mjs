/*
 * Cloudflare Worker của thiệp (cấu hình trong wrangler.jsonc).
 * File tĩnh trong website/ (thiệp, ảnh, trang tạo link, trang thống kê) được chuyển tiếp qua ASSETS.
 * Worker cũng kiểm soát các đường dẫn gốc thiệp và link ngắn:
 *   POST /api/links   { nguoiNhan, ben, matKhau? }        -> { duongDan }     tạo link ngắn
 *   POST /api/xac-nhan   { ben, ten, thamDu, soNguoi, ... }  -> { ok }           khách xác nhận tham dự
 *   POST /api/reports   { ben, matKhau, xoa? }              -> { danhSach, loiChuc }  trang /bridge-invitation|groom-invitation/reports/
 *   POST /api/loi-chuc   { ten, loiChuc, ben } | { xem }      -> { danhSach }     sổ lưu bút trên thiệp
 *   GET  /bridge-invitation/<ten>, /groom-invitation/<ten> (và /<ten> của link cũ) -> thiệp có tiêu đề xem trước + tên khách riêng
 *   GET  /bridge-invitation/demo, /groom-invitation/demo -> trang thiệp mẫu
 *   GET  link không tồn tại -> HTTP 404
 * Dữ liệu lưu trong KV "LIEN_KET". Mật khẩu tuỳ chọn (Settings → Variables and Secrets, loại Secret; không đặt = không cần):
 *   MAT_KHAU_TAO_LINK, MAT_KHAU_THONG_KE, MAT_KHAU_THONG_KE_NHA_TRAI, MAT_KHAU_THONG_KE_NHA_GAI.
 */
import { CAC_BEN, taoLinkMoi, chenThongTin, layDuongDan, benCuaLink } from '../chung/lien-ket.mjs';
import { luuXacNhan, thongKe, benThongKe, layMatKhau } from '../chung/xac-nhan.mjs';
import { layKho } from '../chung/kho-cloudflare.mjs';
import { xuLyLoiChuc } from '../chung/loi-chuc.mjs';

const json = (trangThai, duLieu) => new Response(JSON.stringify(duLieu), {
  status: trangThai,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

const API = {
  '/api/links': (kho, body, env) => taoLinkMoi(kho, body, env.MAT_KHAU_TAO_LINK),
  '/api/xac-nhan': (kho, body) => luuXacNhan(kho, body),
  '/api/loi-chuc': (kho, body) => xuLyLoiChuc(kho, body),
  // Không đặt mật khẩu thì ai có địa chỉ trang thống kê cũng xem được
  '/api/reports': (kho, body, env) => thongKe(kho, body, layMatKhau(env, benThongKe(body) || 'x'), false),
};

async function xuLyApi(request, env, xuLy) {
  if (request.method !== 'POST') return json(405, { loi: 'Chỉ nhận POST.' });
  const kho = layKho(env);
  if (!kho) return json(500, { loi: 'Chưa gắn KV namespace "LIEN_KET" cho Worker.' });
  let body = {};
  try { body = await request.json(); } catch (e) { return json(400, { loi: 'Dữ liệu không hợp lệ.' }); }
  const kq = await xuLy(kho, body, env);
  return json(kq.trangThai, kq.duLieu);
}

// Trang thiệp gốc của bên tương ứng; link cá nhân chỉ được mở sau khi tra cứu trong KV.
const layThiep = (env, url, ben) => env.ASSETS.fetch(new URL(`/${ben}/`, url));

const LINK_MAU_GOC = new Set([
  '/',
  '/index.html',
  '/bridge-invitation',
  '/bridge-invitation/index.html',
  '/groom-invitation',
  '/groom-invitation/index.html',
]);

function chuanHoaDuongDan(pathname) {
  try { return decodeURIComponent(pathname).replace(/\/+$/, '') || '/'; } catch (e) { return pathname; }
}

const khongTimThayLink = () => new Response(null, {
  status: 404,
  headers: { 'cache-control': 'no-store' },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const xuLy = API[url.pathname];
    if (xuLy) return xuLyApi(request, env, xuLy);
    if (request.method !== 'GET' && request.method !== 'HEAD') return env.ASSETS.fetch(request);

    if (LINK_MAU_GOC.has(chuanHoaDuongDan(url.pathname))) return khongTimThayLink();

    const duongDan = layDuongDan(url.pathname);
    // Không phải link thiệp (vd. ảnh không tồn tại): trả 404 như thường
    if (!duongDan) return env.ASSETS.fetch(request);

    const benDemo = CAC_BEN.find((ben) => duongDan === `${ben}/demo`);
    if (benDemo) return layThiep(env, url, benDemo);

    const kho = layKho(env);
    if (!kho) return json(500, { loi: 'Chưa gắn KV namespace "LIEN_KET" cho Worker.' });
    const duLieu = await kho.get(duongDan);
    if (!duLieu) return khongTimThayLink();

    const res = await layThiep(env, url, benCuaLink(duongDan));
    if (!(res.headers.get('content-type') || '').includes('text/html')) return res;

    const headers = new Headers(res.headers);
    headers.delete('content-length');
    headers.delete('etag');
    headers.set('cache-control', 'public, max-age=0, must-revalidate');
    return new Response(chenThongTin(await res.text(), duLieu), { status: 200, headers });
  },
};

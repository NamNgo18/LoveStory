/*
 * Link ngắn cho từng khách: dùng chung cho Cloudflare Worker (worker/index.mjs) và máy chủ xem thử (build.js --serve).
 *
 * Mỗi link ngắn (vd. /bridge-invitation/ban-duc-va-nguoi-thuong, /groom-invitation/co-lan) được lưu kèm tiêu đề, tên khách, giờ riêng và ngày tiệc.
 * Link cũ không có /bridge-invitation/ hay /groom-invitation/ (vd. /ban-duc) vẫn mở được, hiện thiệp nhà trai.
 * Khi có người mở link (kể cả Zalo/Messenger đọc để làm khung xem trước), máy chủ chèn:
 *   - tiêu đề xem trước: "<tiêu đề thiệp>: <tên khách>"
 *   - tên khách vào dòng "Thư Mời" và màn hình mở thiệp
 */

// Tên thư mục có thật trên website — không dùng làm link để tránh trùng
export const TEN_DANH_RIENG = ['anh', 'css', 'js', 'fonts', 'nhac', 'links', 'api', 'index', '404', 'bridge-invitation', 'groom-invitation', 'reports', 'demo'];

// Hai bản thiệp: /bridge-invitation/demo/ và /groom-invitation/demo/ (mỗi bên có trang /links/ riêng)
export const CAC_BEN = ['bridge-invitation', 'groom-invitation'];

export function taoDuongDan(tieuDe) {
  let s = String(tieuDe || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  if (TEN_DANH_RIENG.includes(s)) s += '-1';
  return s;
}

const escHtml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const TRUONG_GIO = {
  tiec: 'gioTiec',
  'don-khach': 'gioDonKhach',
  'khai-tiec': 'gioKhaiTiec',
};
const CAC_TRUONG_GIO = Object.values(TRUONG_GIO);
const GIO_HOP_LE = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const CAC_NGAY_TIEC = ['day_1', 'day_2'];
const MUI_GIO = 7;

function doiGioTrongLinkLich(href, gioTiec) {
  if (!GIO_HOP_LE.test(gioTiec)) return href;
  const m = /dates=(\d{4})(\d{2})(\d{2})T\d{6}Z\/\d{8}T\d{6}Z/.exec(href);
  if (!m) return href;
  const [gio, phut] = gioTiec.split(':').map(Number);
  const batDau = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], gio - MUI_GIO, phut));
  const ketThuc = new Date(batDau.getTime() + 2 * 60 * 60 * 1000);
  const dinhDang = (ngay) => ngay.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return href.replace(m[0], `dates=${dinhDang(batDau)}/${dinhDang(ketThuc)}`);
}

/** Chèn tiêu đề và tên khách của link vào HTML thiệp. */
export function chenThongTin(html, duLieu) {
  const tenKhach = String(duLieu.khach || duLieu.tieuDe || '').trim().replace(/^mời\s+/i, '');
  const tieuDe = escHtml(tenKhach);
  html = html.replace(/<title>([^<]*)<\/title>/, (_, cu) => `<title>${cu}: ${tieuDe}</title>`);
  html = html.replace(/(<meta property="og:title" content=")([^"]*)(")/, (_, a, cu, b) => `${a}${cu}: ${tieuDe}${b}`);
  if (duLieu.khach) {
    html = html.replace(/(<span data-khach-moi>)[^<]*(<\/span>)/g, (_, a, b) => a + escHtml(duLieu.khach) + b);
  }
  html = html.replace(/(<(div|span)\b[^>]*data-gio-link="(tiec|don-khach|khai-tiec)"[^>]*>)[^<]*(<\/\2>)/g,
    (match, moDau, _the, khoa, dong) => {
      const giaTri = duLieu[TRUONG_GIO[khoa]];
      return giaTri == null ? match : `${moDau}${escHtml(giaTri)}${dong}`;
    });
  if (duLieu.ngayTiec === 'day_2') {
    html = html.replace(/(<(span|div)\b[^>]*data-ngay-link="[^"]+"[^>]*data-ngay-2="([^"]*)"[^>]*>)[^<]*(<\/\2>)/g,
      (match, moDau, the, giaTri, dong) => `${moDau}${giaTri}${dong}`);
    html = html.replace(/(<div\b[^>]*\bdata-ngay-lich="(day_1|day_2)"[^>]*)(>)/g,
      (match, moDau, ngay, dong) => {
        const attrs = moDau.replace(/\s+hidden(?=\s|$)/g, '');
        return `${attrs}${ngay === 'day_1' ? ' hidden' : ''}${dong}`;
      });
    html = html.replace(/(<a\b[^>]*\bhref=")[^"]*("[^>]*\bdata-link-them-lich-2=")([^"]*)(")/,
      (match, truocHref, truocNgay2, hrefNgay2, dong) => `${truocHref}${hrefNgay2}${truocNgay2}${dong}`);
  }
  if (duLieu.gioTiec) {
    html = html.replace(/(<a\b[^>]*\bhref=")([^"]*)("[^>]*\bdata-link-them-lich-2=")/,
      (match, truocHref, href, sauHref) => `${truocHref}${doiGioTrongLinkLich(href, duLieu.gioTiec)}${sauHref}`);
  }
  return html;
}

/**
 * Tạo (hoặc dùng lại) link ngắn.
 * kho: { get(khoa) -> Promise<obj|null>, set(khoa, obj) -> Promise }
 * Trả về { trangThai, duLieu } để nơi gọi tự trả JSON.
 */
export async function taoLinkMoi(kho, body, matKhau) {
  if (matKhau && body.matKhau !== matKhau) return { trangThai: 401, duLieu: { loi: 'Sai mật khẩu tạo link.' } };
  // Chỉ cần 1 ô "người nhận": vừa là tiêu đề "Mời ..." khi chia sẻ, vừa là tên ở dòng "Thư Mời" (bỏ chữ "Mời" đứng đầu).
  // Vẫn nhận tieuDe/khach riêng để tương thích với bản cũ.
  const nguoiNhan = String(body.nguoiNhan ?? body.tieuDe ?? '').trim().slice(0, 120);
  const tieuDe = nguoiNhan;
  const khach = String(body.khach ?? (nguoiNhan.replace(/^mời\s+/i, '').trim() || nguoiNhan)).trim().slice(0, 120);
  const ben = CAC_BEN.includes(body.ben) ? body.ben : CAC_BEN[0];
  const ten = taoDuongDan(tieuDe);
  if (!ten) return { trangThai: 400, duLieu: { loi: 'Tiêu đề cần có ít nhất một chữ cái hoặc chữ số.' } };
  const coGioTiec = CAC_TRUONG_GIO.some((khoa) => Object.prototype.hasOwnProperty.call(body, khoa));
  const gio = {};
  if (coGioTiec) {
    for (const khoa of CAC_TRUONG_GIO) {
      const giaTri = typeof body[khoa] === 'string' ? body[khoa].trim() : '';
      if (!GIO_HOP_LE.test(giaTri)) {
        return { trangThai: 400, duLieu: { loi: 'Ba mốc giờ phải có dạng HH:MM (00:00–23:59).' } };
      }
      gio[khoa] = giaTri;
    }
  }
  const ngayTiec = body.ngayTiec;
  if (ngayTiec !== undefined && !CAC_NGAY_TIEC.includes(ngayTiec)) {
    return { trangThai: 400, duLieu: { loi: 'Ngày tiệc không hợp lệ.' } };
  }
  const goc = `${ben}/${ten}`;
  let duongDan = goc;
  for (let i = 2; ; i++) {
    const cu = await kho.get(duongDan);
    if (!cu) break;
    if (cu.tieuDe === tieuDe && cu.khach === khach && cu.ngayTiec === ngayTiec
      && CAC_TRUONG_GIO.every((khoa) => cu[khoa] === gio[khoa])) {
      return { trangThai: 200, duLieu: { duongDan: duongDan.slice(ben.length + 1) } };
    }
    duongDan = `${goc}-${i}`; // trùng đường dẫn nhưng khác nội dung: thêm số
  }
  await kho.set(duongDan, { tieuDe, khach, ben, ...gio, ...(ngayTiec ? { ngayTiec } : {}), tao: new Date().toISOString() });
  // Trang tạo link nằm trong thư mục của bên đó nên chỉ cần phần tên (vd. "co-lan")
  return { trangThai: 200, duLieu: { duongDan: duongDan.slice(ben.length + 1) } };
}

/** Lấy đường dẫn ngắn từ URL ("groom-invitation/co-lan", hoặc "ban-duc" với link cũ), hoặc '' nếu không phải link thiệp. */
export function layDuongDan(pathname) {
  let p = pathname;
  try { p = decodeURIComponent(pathname); } catch (e) { /* giữ nguyên */ }
  p = p.replace(/^\/+|\/+$/g, '');
  if (!p || p.includes('.')) return '';
  const phan = p.split('/');
  if (phan.length === 1) return CAC_BEN.includes(p) ? '' : p;
  return phan.length === 2 && CAC_BEN.includes(phan[0]) && !['links', 'reports'].includes(phan[1]) ? p : '';
}

/** Bên của một link ngắn: link cũ (không có thư mục) là nhà trai. */
export function benCuaLink(duongDan) {
  const dau = duongDan.split('/')[0];
  return CAC_BEN.includes(dau) && duongDan.includes('/') ? dau : CAC_BEN[0];
}

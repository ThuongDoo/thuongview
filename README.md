# 🔥 ThuongView

Web theo dõi view Reels của các Facebook Page, dùng cho cả nhóm. Mỗi người chỉ cần bấm **"Đăng nhập với Facebook"**, không phải cấu hình gì.

## Tính năng
- **Đăng nhập bằng Facebook**: mỗi người thấy Page của mình, có sao / cài đặt / mốc view riêng.
- **Tổng quan**: tổng view, số reels, view TB/reel, số reels đạt mốc, view tăng 24h; biểu đồ view theo page & theo ngày đăng; bảng thống kê theo page; danh sách reels sắp xếp được.
- **🔥 Ghim theo mốc**: reel vượt 5K / 10K / 20K / 50K / 100K… lên đầu, số ngọn lửa tăng theo mốc, nhãn **MỚI** khi vừa đạt mốc trong 24h.
- **⭐ Đánh dấu sao** reel muốn theo dõi.
- **Chỉ quét reels trong 30 ngày gần nhất** (chỉnh được 1–30 ngày trong Cài đặt): gặp reel cũ hơn thì dừng, không quét lùi về các năm trước.
- **Lọc** theo ngày đăng (hôm nay, 3/7/14/30 ngày, tuỳ chọn), theo page, theo tag, theo từ khoá.
- **🏷 Tag cho page**: tag có icon, tên, màu; 1 page nhiều tag; chọn nhiều page để gắn/gỡ tag hàng loạt; lọc & thống kê theo tag.
- **Phân trang** mọi danh sách (reels, page, bảng thống kê): mặc định 10 dòng/trang, chọn 10/20/30/50/100.
- Giao diện sáng/tối, dùng tốt trên điện thoại. Có chế độ **demo**.

---

## Hướng dẫn cho quản trị viên (làm 1 lần)

### 1. Tạo Facebook App
1. Vào <https://developers.facebook.com/apps> → **Create App**.
2. Chọn use case **"Manage everything on your Page"** (Quản lý mọi thứ trên Trang).
3. Trong **Use cases → Customize**, bật các quyền:
   `pages_show_list`, `pages_read_engagement`, `read_insights`, `pages_read_user_content`, `business_management` (để lấy page trong Business Portfolio).
4. Trong phần cài đặt **Facebook Login**, mục **Valid OAuth Redirect URIs**, thêm:
   `<BASE_URL>/auth/callback` (ví dụ `https://view.tenmien.com/auth/callback`).
   Chạy thử trên máy thì dùng `http://localhost:3000/auth/callback`.
5. **App settings → Basic**: copy **App ID** và **App Secret**.

> App để ở chế độ **Development** là đủ cho nhóm ≤ vài chục người, **không cần App Review**.

### 2. Thêm thành viên nhóm (≈10 người)
- **App roles → Roles → Add People → Tester**, nhập tên/ID Facebook của từng người.
- Mỗi người vào <https://developers.facebook.com/requests/> để **chấp nhận lời mời** (cần đăng ký tài khoản Meta for Developers miễn phí lần đầu).
- Người chưa được thêm sẽ thấy lỗi "ứng dụng chưa sẵn sàng" khi đăng nhập.

### 3. Cấu hình & chạy
```bash
npm install
copy .env.example .env     # điền FB_APP_ID, FB_APP_SECRET, BASE_URL, APP_SECRET
npm start
```

### 4. Đưa lên mạng cho cả nhóm dùng (cần HTTPS)
Facebook bắt buộc HTTPS cho Redirect URI (trừ `localhost`). Một vài cách:
- **VPS + Nginx/Caddy** (Caddy tự cấp HTTPS): trỏ tên miền → proxy tới `127.0.0.1:3000`.
- **Cloudflare Tunnel** với tên miền riêng: không cần mở port, chạy được ngay trên máy tính của bạn.
  (Bản `trycloudflare.com` miễn phí đổi địa chỉ mỗi lần chạy → phải sửa Redirect URI mỗi lần, không nên dùng lâu dài.)
- **Render / Railway**: cần ổ đĩa lưu trữ (persistent disk) cho thư mục `data/`.

Sau khi có địa chỉ, cập nhật `BASE_URL` trong `.env` và Redirect URI trong Facebook App cho khớp.

---

## Hướng dẫn cho thành viên
1. Chấp nhận lời mời Tester (quản trị viên sẽ gửi).
2. Mở web → **Đăng nhập với Facebook** → **chọn tất cả Page** muốn theo dõi → giữ nguyên quyền → Tiếp tục.
3. Thiếu Page? Vào **Cài đặt → Đăng nhập lại / chọn thêm Page**.

Phiên đăng nhập Facebook kéo dài ~60 ngày; web sẽ nhắc đăng nhập lại khi sắp hết hạn.

## Ghi chú kỹ thuật
- Node.js ≥ 22.13 (dùng SQLite có sẵn `node:sqlite`, chỉ cần thêm `express`).
- Dữ liệu ở `data/thuongview.db`; token Facebook được mã hoá AES-256-GCM, không bao giờ gửi xuống trình duyệt.
- Luồng lấy dữ liệu: `me/accounts` → `{page}/video_reels` → `{reel}/video_insights` (gộp bằng Batch API).
- View lấy từ metric `fb_reels_total_plays` (dự phòng `blue_reels_play_count`); đổi qua `FB_REEL_METRICS` nếu Meta đổi tên.
- Nếu App dùng **Facebook Login for Business**, điền `FB_LOGIN_CONFIG_ID` trong `.env`.
"# thuongview" 
"# thuongview" 
